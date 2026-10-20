import { expect, test } from 'bun:test';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from 'ssh2';
import type { BridgeEnvelope, DeviceClient, DeviceConnection, DeviceSession, DeviceSetupResult, RustDeviceBridgeEvent } from './idevice.js';
import { withCorrelation } from '#correlation.js';
import { config } from '#config.js';
import { BRIDGE_CAPABILITIES, BRIDGE_PROTOCOL_VERSION, TESTFLIGHT_LIFECYCLE_CAPABILITIES } from './bridgeProtocol.js';
import { flushTelemetry, startSpan } from '#telemetry.js';

const { armAppStoreAutoConfirm, buildIpadecryptRuntimeConfig, clearAppStoreAutoConfirm, createBridgeEnvelope, createDeviceAgentEnvelope, DeviceBridgeError, execCommand, getDeviceAgentRetryDelay, getDeviceTransportOrder, getRustDeviceBridgeHealth, getRustDeviceBridgeStatus, isDirectUsbDeviceAgentConnection, pairDevice, probeDeviceSshTunnel, readBridgeHeartbeats, retryRustDeviceHealthProbe, retryTransientSshConnection, sendAppStoreBridgeRequest, setupDeviceConnection, subscribeRustDeviceBridgeEvents, verifyRustDevicePairing, withIpadecrypt, withSSH } = await import('./idevice.js' + '?idevice-transport-test');

type FakeExecStream = {
  stderr: {
    on(event: 'data', listener: (chunk: Buffer) => void): void;
  };
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  end(input?: string): void;
  sendData(chunk: Buffer): void;
  finish(code: number): void;
};

function fakeDeviceConnection(): { connection: Client; commands: string[]; writes: string[] } {
  const commands: string[] = [];
  const writes: string[] = [];
  const connection = {
    exec(command: string, callback: (error: Error | undefined, stream: FakeExecStream) => void) {
      commands.push(command);
      let outputHandler: ((chunk: Buffer) => void) | undefined;
      let closeHandler: ((code: number | null) => void) | undefined;
      const stream = {
        stderr: {
          on(_event: 'data', _listener: (chunk: Buffer) => void) {},
        },
        on(event: 'data' | 'error' | 'close', listener: ((chunk: Buffer) => void) | ((error: Error) => void) | ((code: number | null) => void)) {
          if (event === 'data') outputHandler = listener as (chunk: Buffer) => void;
          if (event === 'close') closeHandler = listener as (code: number | null) => void;
        },
        sendData(chunk: Buffer) {
          outputHandler?.(chunk);
        },
        finish(code: number) {
          closeHandler?.(code);
        },
        end(input = '') {
          writes.push(input);
          closeHandler?.(0);
        },
      } as unknown as FakeExecStream;
      callback(undefined, stream);
      if (command.startsWith('cat >')) return;
      const channel = command.match(/\/tmp\/autoinstall\/v1\/([^/]+)\//)?.[1] ?? 'unknown';
      stream.sendData(Buffer.from(JSON.stringify({ process: channel, at: 1 })));
      stream.finish(0);
    },
  } as unknown as Client;
  return { connection, commands, writes };
}

function signedAgentResponse(secret: string, requestId: string, result: Record<string, unknown>): Record<string, unknown> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ ok: true, result })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`dkrypt-autoinstall-agent-response-v1|${requestId}|${issuedAt}|${payload}`).digest('hex');
  return { version: 1, requestId, issuedAt, payload, signature };
}

function writeFrame(socket: import('node:net').Socket, value: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  socket.end(frame);
}

async function withRustBridgeFixture<T>(
  respond: (request: Record<string, unknown>) => unknown,
  action: () => Promise<T>,
): Promise<{ result: T; operations: string[] }> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-pairing-validation-'));
  const socketPath = path.join(runtimeDir, 'bridge.sock');
  const secret = 'pairing-validation-secret-0123456789';
  const originalSocket = config.deviceBridgeSocket;
  const originalSecret = config.deviceBridgeSecret;
  const operations: string[] = [];
  const bridge = createServer((socket) => {
    socket.once('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const length = buffer.readUInt32BE(0);
      const request = JSON.parse(buffer.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>;
      operations.push(String(request.operation));
      const result = respond(request);
      const bridgeError = result && typeof result === 'object' && '__bridgeError' in result
        ? (result as { __bridgeError?: { code?: string; message?: string; retryable?: boolean } }).__bridgeError
        : undefined;
      writeFrame(socket, {
        version: 1,
        requestId: request.requestId,
        ok: !bridgeError,
        result: bridgeError ? null : result,
        error: bridgeError ?? null,
      });
    });
  });
  await new Promise<void>((resolve) => bridge.listen(socketPath, resolve));
  config.deviceBridgeSocket = socketPath;
  config.deviceBridgeSecret = secret;

  try {
    return { result: await action(), operations };
  } finally {
    config.deviceBridgeSocket = originalSocket;
    config.deviceBridgeSecret = originalSecret;
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

test('Rust device bridge RPCs retry the previous shared secret only after unauthorized', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-secret-rotation-'));
  const socketPath = path.join(runtimeDir, 'bridge.sock');
  const originalSocket = config.deviceBridgeSocket;
  const originalSecret = config.deviceBridgeSecret;
  const originalPreviousSecret = config.deviceBridgeSecretPrevious;
  const currentSecret = 'current-device-bridge-secret-0123456789';
  const previousSecret = 'previous-device-bridge-secret-0123456789';
  const attemptedSecrets: string[] = [];
  const bridge = createServer((socket) => {
    socket.once('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const length = buffer.readUInt32BE(0);
      const request = JSON.parse(buffer.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>;
      attemptedSecrets.push(String(request.auth));
      const ok = request.auth === previousSecret;
      const result = request.operation === 'health'
        ? { state: 'ready', transport: 'usb', deviceCount: 1, devicePresent: true }
        : { protocolVersion: 1, capabilities: ['agent'] };
      writeFrame(socket, {
        version: 1,
        requestId: request.requestId,
        ok,
        ...(ok ? { result } : { error: { code: 'unauthorized', message: 'device bridge authentication failed', retryable: false } }),
      });
    });
  });
  config.deviceBridgeSocket = socketPath;
  config.deviceBridgeSecret = currentSecret;
  config.deviceBridgeSecretPrevious = previousSecret;

  try {
    await new Promise<void>((resolve, reject) => bridge.listen(socketPath, resolve).once('error', reject));
    await expect(getRustDeviceBridgeStatus()).resolves.toMatchObject({ state: 'ready', deviceCount: 1 });
    expect(attemptedSecrets.filter((secret) => secret === currentSecret)).toHaveLength(2);
    expect(attemptedSecrets.filter((secret) => secret === previousSecret)).toHaveLength(2);
  } finally {
    config.deviceBridgeSocket = originalSocket;
    config.deviceBridgeSecret = originalSecret;
    config.deviceBridgeSecretPrevious = originalPreviousSecret;
    await flushTelemetry({ endpoint: 'https://collector.example/v1/traces', fetcher: async () => Response.json({}) });
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('Rust device bridge RPCs do not retry the previous secret after non-authentication errors', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-secret-error-'));
  const socketPath = path.join(runtimeDir, 'bridge.sock');
  const originalSocket = config.deviceBridgeSocket;
  const originalSecret = config.deviceBridgeSecret;
  const originalPreviousSecret = config.deviceBridgeSecretPrevious;
  const attemptedSecrets: string[] = [];
  const bridge = createServer((socket) => {
    socket.once('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const length = buffer.readUInt32BE(0);
      const request = JSON.parse(buffer.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>;
      attemptedSecrets.push(String(request.auth));
      writeFrame(socket, {
        version: 1,
        requestId: request.requestId,
        ok: false,
        error: { code: 'device_not_found', message: 'device was not found', retryable: false },
      });
    });
  });
  config.deviceBridgeSocket = socketPath;
  config.deviceBridgeSecret = 'current-device-bridge-secret-0123456789';
  config.deviceBridgeSecretPrevious = 'previous-device-bridge-secret-0123456789';

  try {
    await new Promise<void>((resolve, reject) => bridge.listen(socketPath, resolve).once('error', reject));
    await expect(getRustDeviceBridgeStatus()).rejects.toThrow('device_not_found');
    expect(attemptedSecrets).toEqual([config.deviceBridgeSecret, config.deviceBridgeSecret]);
  } finally {
    config.deviceBridgeSocket = originalSocket;
    config.deviceBridgeSecret = originalSecret;
    config.deviceBridgeSecretPrevious = originalPreviousSecret;
    await flushTelemetry({ endpoint: 'https://collector.example/v1/traces', fetcher: async () => Response.json({}) });
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('Rust device bridge event subscriptions retry the previous shared secret after unauthorized', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-event-secret-rotation-'));
  const socketPath = path.join(runtimeDir, 'bridge.sock');
  const originalSocket = config.deviceBridgeSocket;
  const originalSecret = config.deviceBridgeSecret;
  const originalPreviousSecret = config.deviceBridgeSecretPrevious;
  const currentSecret = 'current-event-bridge-secret-0123456789';
  const previousSecret = 'previous-event-bridge-secret-0123456789';
  const attemptedSecrets: string[] = [];
  const bridge = createServer((socket) => {
    socket.once('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const length = buffer.readUInt32BE(0);
      const request = JSON.parse(buffer.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>;
      attemptedSecrets.push(String(request.auth));
      const ok = request.auth === previousSecret;
      const value = { type: 'snapshot', sequence: 1, devices: [] };
      const body = Buffer.from(JSON.stringify({
        version: 1,
        requestId: request.requestId,
        ok,
        ...(ok ? { result: value } : { error: { code: 'unauthorized', message: 'device bridge authentication failed', retryable: false } }),
      }));
      const frame = Buffer.allocUnsafe(body.length + 4);
      frame.writeUInt32BE(body.length, 0);
      body.copy(frame, 4);
      socket.write(frame);
    });
  });
  config.deviceBridgeSocket = socketPath;
  config.deviceBridgeSecret = currentSecret;
  config.deviceBridgeSecretPrevious = previousSecret;
  let stop: (() => void) | undefined;

  try {
    await new Promise<void>((resolve, reject) => bridge.listen(socketPath, resolve).once('error', reject));
    const events: unknown[] = [];
    stop = await subscribeRustDeviceBridgeEvents((event: RustDeviceBridgeEvent) => events.push(event));
    expect(events).toEqual([{ type: 'snapshot', sequence: 1, devices: [] }]);
    expect(attemptedSecrets).toEqual([currentSecret, previousSecret]);
  } finally {
    stop?.();
    config.deviceBridgeSocket = originalSocket;
    config.deviceBridgeSecret = originalSecret;
    config.deviceBridgeSecretPrevious = originalPreviousSecret;
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('Rust device bridge spans inherit the active operation span', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-trace-'));
  const originalSocket = config.deviceBridgeSocket;
  const originalSecret = config.deviceBridgeSecret;
  const originalSampleRate = config.otelSampleRate;
  const originalBatchSize = config.otelBatchSize;
  config.deviceBridgeSocket = path.join(runtimeDir, 'unavailable.sock');
  config.deviceBridgeSecret = 'bridge-test-secret-0123456789abcdef';
  config.otelSampleRate = 1;
  config.otelBatchSize = 128;
  const parent = startSpan('test.device.operation');
  let exportedSpans: Array<{ name: string; traceId: string; parentSpanId?: string }> = [];

  try {
    await expect(withCorrelation({
      correlationId: 'device-operation-123',
      traceId: parent.context.traceId,
      traceContext: parent.context,
    }, () => getRustDeviceBridgeStatus())).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    parent.end();
    await flushTelemetry({
      endpoint: 'https://collector.example/v1/traces',
      fetcher: async (_input, init) => {
        const payload = JSON.parse(String(init?.body)) as {
          resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; traceId: string; parentSpanId?: string }> }> }>;
        };
        exportedSpans = payload.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
        return Response.json({});
      },
    });

    const bridgeSpans = exportedSpans.filter((span) => span.name === 'device.bridge.request');
    expect(bridgeSpans).toHaveLength(2);
    expect(bridgeSpans.every((span) => span.traceId === parent.context.traceId)).toBe(true);
    expect(bridgeSpans.every((span) => span.parentSpanId === parent.context.spanId)).toBe(true);
  } finally {
    config.deviceBridgeSocket = originalSocket;
    config.deviceBridgeSecret = originalSecret;
    config.otelSampleRate = originalSampleRate;
    config.otelBatchSize = originalBatchSize;
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('keeps a connected USB device ready when capability discovery fails', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-health-capabilities-'));
  const socketPath = path.join(runtimeDir, 'bridge.sock');
  const originalSocket = config.deviceBridgeSocket;
  const originalSecret = config.deviceBridgeSecret;
  const bridgeSecret = '0123456789abcdef0123456789abcdef';
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      const frame = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const length = frame.readUInt32BE(0);
      const request = JSON.parse(frame.subarray(4, length + 4).toString('utf8')) as { requestId: string; operation: string };
      if (request.operation === 'health') {
        writeFrame(socket, { version: 1, requestId: request.requestId, ok: true, result: { state: 'ready', transport: 'usb', deviceCount: 1, devicePresent: true }, error: null });
        return;
      }
      writeFrame(socket, { version: 1, requestId: request.requestId, ok: false, result: null, error: { code: 'temporarily_unavailable', message: 'capability discovery failed', retryable: true } });
    });
  });

  config.deviceBridgeSocket = socketPath;
  config.deviceBridgeSecret = bridgeSecret;

  try {
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));

    await expect(getRustDeviceBridgeHealth({ transport: 'usb', udid: 'fixture-health-device' })).resolves.toEqual({
      state: 'ready',
      transport: 'usb',
      deviceCount: 1,
      capabilities: [],
    });
    await expect(getRustDeviceBridgeStatus()).resolves.toEqual({
      state: 'ready',
      transport: 'usb',
      deviceCount: 1,
      capabilities: [],
    });
  } finally {
    config.deviceBridgeSocket = originalSocket;
    config.deviceBridgeSecret = originalSecret;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('preserves a specific Rust bridge operation error instead of reporting device unavailability', async () => {
  await withRustBridgeFixture((request) => request.operation === 'health'
    ? { __bridgeError: { code: 'pairing_required', message: 'device must be paired', retryable: false } }
    : { capabilities: [] }, async () => {
    const result = getRustDeviceBridgeStatus();
    await expect(result).rejects.toBeInstanceOf(DeviceBridgeError);
    await expect(result).rejects.toMatchObject({ code: 'pairing_required', retryable: false });
  });
});

test('createBridgeEnvelope matches the shared bridge fixture', async () => {
  const fixturePath = path.resolve(import.meta.dir, '../../autoinstall/protocol/bridge-v1.fixture.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
    secret: string;
    channel: 'testflight';
    request: Record<string, unknown>;
    requestId: string;
    issuedAt: number;
    envelope: BridgeEnvelope;
    contract: { version: number; springboard: readonly string[]; testflight: readonly string[]; testflightLifecycle: readonly string[]; appstore: readonly string[] };
  };
  const envelope = createBridgeEnvelope(fixture.secret, fixture.channel, fixture.request, fixture.requestId, fixture.issuedAt);

  expect(envelope).toEqual(fixture.envelope);
  expect(createBridgeEnvelope(fixture.secret, 'appstore', fixture.request, fixture.requestId, fixture.issuedAt).signature).not.toBe(envelope.signature);
  expect(fixture.contract).toEqual({
    version: BRIDGE_PROTOCOL_VERSION,
    ...BRIDGE_CAPABILITIES,
    appstore: BRIDGE_CAPABILITIES.appstore.filter((capability) => capability !== 'localized_install_titles'),
    testflightLifecycle: TESTFLIGHT_LIFECYCLE_CAPABILITIES,
  });
  expect(BRIDGE_CAPABILITIES.appstore).toContain('localized_install_titles');
});

test('createDeviceAgentEnvelope matches the shared bridge fixture', async () => {
  const fixturePath = path.resolve(import.meta.dir, '../../device-bridge/fixtures/device-agent-v1.fixture.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
    secret: string;
    request: Record<string, unknown>;
    requestId: string;
    issuedAt: number;
    envelope: Record<string, unknown> & { payload: string };
  };
  const envelope = createDeviceAgentEnvelope(fixture.secret, fixture.requestId, fixture.request, fixture.issuedAt);

  expect(envelope).toEqual(fixture.envelope);
  expect(JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'))).toEqual(fixture.request);
});

test('uses SSH exec channels for device file reads and quoted writes', async () => {
  const { connection, commands, writes } = fakeDeviceConnection();

  await expect(readBridgeHeartbeats(connection)).resolves.toEqual({
    springboard: { process: 'springboard', at: 1 },
    testflight: { process: 'testflight', at: 1 },
    appstore: { process: 'appstore', at: 1 },
  });
  await armAppStoreAutoConfirm(connection, 'Inspect');

  expect(commands).toHaveLength(4);
  expect(commands.slice(0, 3).every((command) => command.includes('cat'))).toBe(true);
  expect(commands[3]).toContain('printf');
  expect(commands[3]).toMatch(/expiresAtMs=\d+/);
  expect(commands[3]).toContain('Inspect');
  expect(writes).toEqual([]);
});

test('clears App Store auto-confirm flags from every injected service cache', async () => {
  const { connection, commands } = fakeDeviceConnection();

  await clearAppStoreAutoConfirm(connection);

  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain('/tmp/autoinstall-autoconfirm.flag');
  expect(commands[0]).toContain('com.apple.PassbookUIService/autoinstall-autoconfirm.flag');
  expect(commands[0]).toContain('com.apple.AuthKitUIService/autoinstall-autoconfirm.flag');
  expect(commands[0]).toContain('com.apple.ios.StoreKitUIService/autoinstall-autoconfirm.flag');
});

test('times out stalled SSH exec channels', async () => {
  const connection = { exec() {} } as unknown as Client;

  await expect(execCommand(connection, 'stalled command', 20)).resolves.toEqual({
    stdout: '',
    stderr: 'command timed out after 20ms',
    code: null,
  });
});

test('aborts an in-flight SSH exec channel when the job signal is cancelled', async () => {
  const controller = new AbortController();
  let destroyed = false;
  const connection = {
    exec(_command: string, callback: (error: Error | undefined, stream: FakeExecStream) => void) {
      callback(undefined, {
        stderr: { on() {} },
        on() {},
        destroy() { destroyed = true; },
      } as unknown as FakeExecStream);
    },
  } as unknown as Client;
  const operation = execCommand(connection, 'blocked remote command', 60_000, controller.signal);
  controller.abort(new Error('job deadline exceeded'));

  await expect(operation).rejects.toThrow('job deadline exceeded');
  expect(destroyed).toBe(true);
});

test('removes a bridge request if publishing it is interrupted after the rename', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-bridge-request-cleanup-'));
  const controller = new AbortController();
  let requestPublished = false;
  let requestRemoved = false;
  const client: DeviceSession = {
    transport: 'autoinstall',
    runtimeDir,
    async exec(command) {
      if (command.startsWith('mv ') && command.includes('/appstore/requests/')) {
        requestPublished = true;
        controller.abort(new Error('job deadline exceeded'));
        throw controller.signal.reason;
      }
      if (command.startsWith('rm -f') && command.includes('/appstore/requests/') && !command.includes('.partial')) requestRemoved = true;
      return { stdout: '', stderr: '', code: 0 };
    },
    close() {},
  };

  try {
    await expect(sendAppStoreBridgeRequest(client, { action: 'install' }, 20_000, controller.signal)).rejects.toThrow('job deadline exceeded');
    expect(requestPublished).toBe(true);
    expect(requestRemoved).toBe(true);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('retries transient SSH handshakes before failing', async () => {
  let attempts = 0;

  await expect(retryTransientSshConnection(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Timed out while waiting for handshake');
    return 'ready';
  }, 1, 0)).resolves.toBe('ready');

  expect(attempts).toBe(2);
});

test('retries a USB transport that closes before the SSH handshake', async () => {
  let attempts = 0;

  await expect(retryTransientSshConnection(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Connection lost before handshake');
    return 'ready';
  }, 1, 0)).resolves.toBe('ready');

  expect(attempts).toBe(2);
});

test('stops transient SSH handshake retries when the job is aborted', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const connecting = retryTransientSshConnection(async () => {
    attempts += 1;
    throw new Error('Connection reset by peer');
  }, 5, 60_000, controller.signal);

  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error('job deadline exceeded'));

  await expect(connecting).rejects.toThrow('job deadline exceeded');
  expect(attempts).toBe(1);
});

test('cancels a pending Rust device-agent request when a running job is aborted', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-agent-cancel-'));
  const socketPath = path.join(runtimeDir, 'bridge.sock');
  const secret = '0123456789abcdef0123456789abcdef';
  const originalSocket = config.deviceBridgeSocket;
  const originalSecret = config.deviceBridgeSecret;
  const originalRuntimeDir = config.deviceRuntimeDir;
  let resolveExecRequest: ((requestId: string) => void) | undefined;
  let resolveCleanupRequest: ((requestId: string) => void) | undefined;
  let resolveCancellation: ((requestId: string) => void) | undefined;
  const execRequest = new Promise<string>((resolve) => { resolveExecRequest = resolve; });
  const cleanupRequest = new Promise<string>((resolve) => { resolveCleanupRequest = resolve; });
  const cancellation = new Promise<string>((resolve) => { resolveCancellation = resolve; });
  const requests: string[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (input.length >= 4) {
        const length = input.readUInt32BE(0);
        if (input.length < length + 4) break;
        const request = JSON.parse(input.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>;
        input = input.subarray(length + 4);
        requests.push(String(request.operation));
        const requestId = String(request.requestId);
        const reply = (result: Record<string, unknown>) => writeFrame(socket, { version: 1, requestId, ok: true, result });
        if (request.operation === 'capabilities') {
          reply({ protocolVersion: 1, capabilities: ['agent', 'cancel'] });
        } else if (request.operation === 'agent') {
          const envelope = request.payload as Record<string, unknown>;
          const message = JSON.parse(Buffer.from(String(envelope.payload), 'base64url').toString('utf8')) as Record<string, unknown>;
          requests.push(`agent:${String(message.action)}`);
          if (message.action === 'status') {
            reply(signedAgentResponse(String(request.agentSecret), String(envelope.requestId), { agentVersion: '1.0.0' }));
          } else if (message.action === 'exec') {
            if (message.command === 'sleep 30') {
              resolveExecRequest?.(requestId);
            } else {
              resolveCleanupRequest?.(requestId);
              reply(signedAgentResponse(String(request.agentSecret), String(envelope.requestId), { stdout: '', stderr: '', code: 0 }));
            }
          }
        } else if (request.operation === 'cancel') {
          const targetRequestId = String(request.payload);
          resolveCancellation?.(targetRequestId);
          reply({ cancelled: true, requestId: targetRequestId });
        }
      }
    });
  });

  config.deviceBridgeSocket = socketPath;
  config.deviceBridgeSecret = secret;
  config.deviceRuntimeDir = runtimeDir;
  const controller = new AbortController();

  try {
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
    const operation = withSSH(
      { transport: 'usb', udid: '2a0e0924d60bbd25e9ce1398fa5543128ec5a5dd' },
      async (client: DeviceClient) => {
        const session = client as DeviceSession;
        try {
          return await session.exec('sleep 30', 5_000);
        } finally {
          await session.exec('clear auto-confirm', 1_000);
        }
      },
      controller.signal,
    );
    const operationOutcome = operation.then(
      () => 'resolved',
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    const requestId = await Promise.race([
      execRequest,
      operationOutcome.then((outcome: string) => { throw new Error(`device-agent operation ${outcome}; requests=${requests.join(',')}`); }),
      new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out waiting for exec; requests=${requests.join(',')}`)), 2_000)),
    ]);
    controller.abort(new Error('job deadline exceeded'));

    await expect(operation).rejects.toThrow('job deadline exceeded');
    await expect(Promise.race([
      cancellation,
      new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out waiting for cancel; requests=${requests.join(',')}`)), 2_000)),
    ])).resolves.toBe(requestId);
    await expect(Promise.race([
      cleanupRequest,
      new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out waiting for cleanup; requests=${requests.join(',')}`)), 2_000)),
    ])).resolves.not.toBe(requestId);
  } finally {
    controller.abort(new Error('test cleanup'));
    config.deviceBridgeSocket = originalSocket;
    config.deviceBridgeSecret = originalSecret;
    config.deviceRuntimeDir = originalRuntimeDir;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('recovers the Rust USB agent without an SSH key after dropped RPC and transient restart', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-agent-recovery-'));
  const socketPath = path.join(runtimeDir, 'bridge.sock');
  const missingSshKeyPath = path.join(runtimeDir, 'missing-device-key');
  const bridgeSecret = '0123456789abcdef0123456789abcdef';
  const originalSocket = config.deviceBridgeSocket;
  const originalSecret = config.deviceBridgeSecret;
  const originalRuntimeDir = config.deviceRuntimeDir;
  const originalSshKeyPath = config.deviceSshKeyPath;
  const operations: string[] = [];
  const commands: string[] = [];
  const sockets = new Set<import('node:net').Socket>();
  let statusAttempts = 0;
  let droppedFirstCommand = false;
  let invalidAuthentication = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (input.length >= 4) {
        const length = input.readUInt32BE(0);
        if (input.length < length + 4) return;
        const request = JSON.parse(input.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>;
        input = input.subarray(length + 4);
        const requestId = String(request.requestId);
        operations.push(String(request.operation));
        invalidAuthentication ||= request.auth !== bridgeSecret;
        if (request.operation === 'capabilities') {
          writeFrame(socket, { version: 1, requestId, ok: true, result: { protocolVersion: 1, capabilities: ['agent', 'cancel'] }, error: null });
          continue;
        }
        if (request.operation !== 'agent') {
          writeFrame(socket, { version: 1, requestId, ok: false, result: null, error: { code: 'unsupported', message: 'unexpected RPC', retryable: false } });
          continue;
        }
        const envelope = request.payload as Record<string, unknown>;
        const agentRequest = JSON.parse(Buffer.from(String(envelope.payload), 'base64url').toString('utf8')) as Record<string, unknown>;
        const agentSecret = String(request.agentSecret);
        if (agentRequest.action === 'status') {
          statusAttempts += 1;
          if (statusAttempts === 2) {
            writeFrame(socket, { version: 1, requestId, ok: false, result: null, error: { code: 'agent_unavailable', message: 'device agent is restarting', retryable: true } });
            continue;
          }
          writeFrame(socket, { version: 1, requestId, ok: true, result: signedAgentResponse(agentSecret, String(envelope.requestId), { agentVersion: '1.4.0' }), error: null });
          continue;
        }
        if (agentRequest.action === 'exec') {
          const command = String(agentRequest.command);
          commands.push(command);
          if (command === 'disconnect-once' && !droppedFirstCommand) {
            droppedFirstCommand = true;
            socket.destroy();
            continue;
          }
          writeFrame(socket, { version: 1, requestId, ok: true, result: signedAgentResponse(agentSecret, String(envelope.requestId), { stdout: 'recovered', stderr: '', code: 0 }), error: null });
          continue;
        }
        writeFrame(socket, { version: 1, requestId, ok: false, result: null, error: { code: 'unsupported', message: 'unexpected agent action', retryable: false } });
      }
    });
  });
  const device = { transport: 'usb' as const, udid: 'fixture-agent-recovery-device' };

  config.deviceBridgeSocket = socketPath;
  config.deviceBridgeSecret = bridgeSecret;
  config.deviceRuntimeDir = runtimeDir;
  config.deviceSshKeyPath = missingSshKeyPath;

  try {
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
    await expect(readFile(missingSshKeyPath)).rejects.toThrow();

    await expect(withSSH(device, (client: DeviceClient) => (client as DeviceSession).exec('disconnect-once', 1_000))).rejects.toThrow('device agent connection was lost');
    const recovered = await withSSH(device, async (client: DeviceClient) => {
      const session = client as DeviceSession;
      try {
        return await session.exec('recovered', 1_000);
      } finally {
        session.close();
      }
    });

    expect(recovered).toMatchObject({ stdout: 'recovered', code: 0 });
    expect(statusAttempts).toBe(3);
    expect(commands).toEqual(['disconnect-once', 'recovered']);
    expect(operations.filter((operation) => operation === 'capabilities')).toHaveLength(3);
    expect(operations.every((operation) => operation === 'capabilities' || operation === 'agent')).toBe(true);
    expect(invalidAuthentication).toBe(false);
  } finally {
    config.deviceBridgeSocket = originalSocket;
    config.deviceBridgeSecret = originalSecret;
    config.deviceRuntimeDir = originalRuntimeDir;
    config.deviceSshKeyPath = originalSshKeyPath;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('identifies direct USB connections that can recover without SSH', () => {
  expect(isDirectUsbDeviceAgentConnection({ transport: 'usb', udid: '2a0e0924d60bbd25e9ce1398fa5543128ec5a5dd' })).toBe(true);
  expect(isDirectUsbDeviceAgentConnection({ transport: 'wifi', udid: '2a0e0924d60bbd25e9ce1398fa5543128ec5a5dd', usbmuxNetwork: true })).toBe(false);
  expect(isDirectUsbDeviceAgentConnection({ transport: 'wifi', host: 'ipad.local', udid: '2a0e0924d60bbd25e9ce1398fa5543128ec5a5dd' })).toBe(false);
});

test('uses the Rust bridge for USB and paired Wi-Fi devices after cutover', () => {
  const connection = { transport: 'usb' as const, udid: '2a0e0924d60bbd25e9ce1398fa5543128ec5a5dd' };
  const networkConnection = { transport: 'wifi' as const, udid: connection.udid, usbmuxNetwork: true };
  expect(getDeviceTransportOrder(connection, 'auto')).toEqual(['autoinstall']);
  expect(getDeviceTransportOrder(connection, 'autoinstall')).toEqual(['autoinstall']);
  expect(getDeviceTransportOrder(connection, 'ssh')).toEqual(['autoinstall']);
  expect(getDeviceTransportOrder(networkConnection, 'ssh')).toEqual(['autoinstall']);
});

test('reports a device as paired only after the saved record authenticates that device identity', async () => {
  const deviceId = 'fixture-paired-device-identifier';
  const { result, operations } = await withRustBridgeFixture((request) => request.operation === 'pair'
    ? { deviceId, hostId: 'fixture-host-id', paired: true }
    : { UniqueDeviceID: deviceId }, () => pairDevice({ transport: 'usb', udid: deviceId }));

  expect(result).toEqual({ deviceId, hostId: 'fixture-host-id', paired: true });
  expect(operations).toEqual(['pair', 'metadata']);
});

test('sets the Rust request deadline before the client timeout', async () => {
  let rustDeadline: unknown;
  await withRustBridgeFixture((request) => {
    rustDeadline = request.deadlineMs;
    return { UniqueDeviceID: 'fixture-paired-device-identifier' };
  }, () => verifyRustDevicePairing({ transport: 'usb', udid: 'fixture-paired-device-identifier' }));

  expect(rustDeadline).toBe(9_000);
});

test('rejects a saved pairing record that authenticates a different device', async () => {
  const deviceId = 'fixture-paired-device-identifier';
  const { operations } = await withRustBridgeFixture(
    () => ({ UniqueDeviceID: 'different-device-identifier' }),
    async () => expect(verifyRustDevicePairing({ transport: 'usb', udid: deviceId })).rejects.toMatchObject({
      code: 'pairing_identity_mismatch',
      retryable: false,
    }),
  );

  expect(operations).toEqual(['metadata']);
});

test('device setup provisions dkrypt SSH access and does not report decrypt readiness without SFTP', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-setup-'));
  const privateKeyPath = path.join(runtimeDir, 'device-key');
  const publicKeyPath = path.join(runtimeDir, 'device-key.pub');
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ed25519PublicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const algorithm = Buffer.from('ssh-ed25519');
  const algorithmLength = Buffer.alloc(4);
  const keyLength = Buffer.alloc(4);
  algorithmLength.writeUInt32BE(algorithm.length);
  keyLength.writeUInt32BE(ed25519PublicKey.length);
  const publicKey = `ssh-ed25519 ${Buffer.concat([algorithmLength, algorithm, keyLength, ed25519PublicKey]).toString('base64')}`;
  await writeFile(privateKeyPath, keyPair.privateKey.export({ format: 'pem', type: 'pkcs1' }), { mode: 0o600 });
  await writeFile(publicKeyPath, `${publicKey} dkrypt-device\n`, { mode: 0o600 });
  const unavailableService = createServer();
  await new Promise<void>((resolve) => unavailableService.listen(0, '127.0.0.1', resolve));
  const port = (unavailableService.address() as AddressInfo).port;
  await new Promise<void>((resolve) => unavailableService.close(() => resolve()));
  const originalRuntimeDir = config.deviceRuntimeDir;
  const originalSshKeyPath = config.deviceSshKeyPath;
  const originalSshPublicKeyPath = config.deviceSshPublicKeyPath;
  const originalSshPort = config.deviceSshPort;
  const commands: string[] = [];
  const stages: string[] = [];
  const deviceId = 'fixture-setup-device';
  let paired = false;

  config.deviceRuntimeDir = runtimeDir;
  config.deviceSshKeyPath = privateKeyPath;
  config.deviceSshPublicKeyPath = publicKeyPath;
  config.deviceSshPort = 22;

  try {
    const { result, operations } = await withRustBridgeFixture<DeviceSetupResult[]>((request) => {
      if (request.operation === 'pair') {
        paired = true;
        return { deviceId, hostId: 'fixture-host', paired: true };
      }
      if (request.operation === 'metadata') {
        return paired
          ? { UniqueDeviceID: deviceId }
          : { __bridgeError: { code: 'pairing_unavailable', message: 'no saved pairing record', retryable: true } };
      }
      if (request.operation === 'capabilities') return { protocolVersion: 1, capabilities: ['agent'] };
      if (request.operation === 'open_tunnel') return { tunnelId: 'fixture-ssh-tunnel', host: '127.0.0.1', port };
      if (request.operation === 'close_tunnel') return { closed: true };
      if (request.operation !== 'agent') return {};

      const envelope = request.payload as Record<string, unknown>;
      const agentRequest = JSON.parse(Buffer.from(String(envelope.payload), 'base64url').toString('utf8')) as Record<string, unknown>;
      const agentSecret = String(request.agentSecret);
      if (agentRequest.action === 'status') {
        return signedAgentResponse(agentSecret, String(envelope.requestId), { agentVersion: '1.4.0' });
      }

      const command = String(agentRequest.command);
      commands.push(command);
      const stdout = command === 'uname -s 2>/dev/null' ? 'Darwin'
        : command === 'sysctl -n hw.machine 2>/dev/null' ? 'iPad14,1'
          : command === '/var/jb/usr/bin/sw_vers -productVersion 2>/dev/null' ? '18.0'
            : command === 'uname -p 2>/dev/null' ? 'arm'
              : command === 'scutil --get ComputerName 2>/dev/null' ? 'iPad'
                : command.startsWith('/var/jb/usr/bin/dpkg-query') ? 'install ok installed|1.4.0'
                  : '';
      return signedAgentResponse(agentSecret, String(envelope.requestId), { stdout, stderr: '', code: 0 });
    }, async () => [
      await setupDeviceConnection({ transport: 'usb', udid: deviceId }, (id: string) => stages.push(id)),
      await setupDeviceConnection({ transport: 'usb', udid: deviceId }),
    ]);

    expect(result).toHaveLength(2);
    expect(stages).toEqual(['pairing', 'connecting', 'sftp']);
    expect(result.every((setup) => !setup.ready)).toBe(true);
    expect(operations.slice(0, 3)).toEqual(['metadata', 'pair', 'metadata']);
    expect(operations.filter((operation) => operation === 'pair')).toHaveLength(1);
    expect(result[0]?.steps.find((step) => step.id === 'ssh_sftp')).toMatchObject({ status: 'attention' });
    expect(commands.some((command) => command.includes(publicKey) && command.includes('authorized_keys'))).toBe(true);
    expect(commands.some((command) => command.includes('ssh_home=/var/jb/var/mobile'))).toBe(true);
    expect(commands.some((command) => command.includes('ssh_home=/var/mobile;'))).toBe(false);
    expect(commands.some((command) => command.includes('HOME:-/var/jb/var/mobile'))).toBe(false);
  } finally {
    config.deviceRuntimeDir = originalRuntimeDir;
    config.deviceSshKeyPath = originalSshKeyPath;
    config.deviceSshPublicKeyPath = originalSshPublicKeyPath;
    config.deviceSshPort = originalSshPort;
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('backs off USB agent reconnects long enough for USBMux to recover', () => {
  expect([0, 1, 2, 3, 4, 5].map(getDeviceAgentRetryDelay)).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000]);
});

test('retries transient Rust device health gaps before reporting USB absence', async () => {
  let attempts = 0;
  await expect(retryRustDeviceHealthProbe(async () => {
    attempts += 1;
    return { state: 'ready', transport: 'usb', deviceCount: attempts === 3 ? 1 : 0, devicePresent: attempts === 3 };
  }, 3, 0)).resolves.toMatchObject({ devicePresent: true, deviceCount: 1 });
  expect(attempts).toBe(3);
});

test('closes the Rust-managed SSH tunnel when the SFTP service cannot be reached', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-ssh-tunnel-probe-'));
  const socketPath = path.join(runtimeDir, 'bridge.sock');
  const keyPath = path.join(runtimeDir, 'device-key');
  const secret = '0123456789abcdef0123456789abcdef';
  const oldSocket = config.deviceBridgeSocket;
  const oldSecret = config.deviceBridgeSecret;
  const oldKeyPath = config.deviceSshKeyPath;
  const oldPort = config.deviceSshPort;
  const oldUser = config.deviceSshUser;
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(keyPath, keyPair.privateKey.export({ format: 'pem', type: 'pkcs1' }), { mode: 0o600 });
  const unavailableService = createServer();
  await new Promise<void>((resolve) => unavailableService.listen(0, '127.0.0.1', resolve));
  const port = (unavailableService.address() as AddressInfo).port;
  await new Promise<void>((resolve) => unavailableService.close(() => resolve()));
  const operations: string[] = [];
  let invalidAuthentication = false;
  const bridge = createServer((socket) => {
    socket.once('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const length = buffer.readUInt32BE(0);
      const request = JSON.parse(buffer.subarray(4, length + 4).toString('utf8')) as { version: number; requestId: string; auth: string; operation: string };
      operations.push(request.operation);
      invalidAuthentication ||= request.auth !== secret;
      const result = request.operation === 'open_tunnel'
        ? { tunnelId: 'fixture-tunnel', host: '127.0.0.1', port }
        : { closed: true };
      writeFrame(socket, { version: 1, requestId: request.requestId, ok: true, result, error: null });
    });
  });
  await new Promise<void>((resolve) => bridge.listen(socketPath, resolve));

  config.deviceBridgeSocket = socketPath;
  config.deviceBridgeSecret = secret;
  config.deviceSshKeyPath = keyPath;
  config.deviceSshPort = 22;
  config.deviceSshUser = 'mobile';

  try {
    await expect(probeDeviceSshTunnel({ transport: 'usb', udid: 'fixture-device' })).resolves.toBe(false);
    expect(operations).toEqual(['open_tunnel', 'close_tunnel']);
    expect(invalidAuthentication).toBe(false);
  } finally {
    config.deviceBridgeSocket = oldSocket;
    config.deviceBridgeSecret = oldSecret;
    config.deviceSshKeyPath = oldKeyPath;
    config.deviceSshPort = oldPort;
    config.deviceSshUser = oldUser;
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('device operations do not treat legacy config directories as discovered devices', async () => {
  const legacyRoot = await mkdtemp(path.join(tmpdir(), 'dkrypt-obsolete-device-config-'));
  await writeFile(path.join(legacyRoot, 'config.json'), JSON.stringify({
    version: 2,
    device: { host: '192.0.2.10', port: 22, user: 'mobile', auth: { kind: 'key', keyPath: '/tmp/legacy-device-key' } },
  }));
  const legacyConnection = { id: 'legacy-device', rootDir: legacyRoot } as unknown as DeviceConnection;
  let operationStarted = false;

  try {
    await expect(withIpadecrypt(legacyRoot as unknown as DeviceConnection, async () => {
      operationStarted = true;
      return true;
    })).rejects.toThrow('device connection must be discovered over USB or Wi-Fi');
    await expect(withIpadecrypt(legacyConnection, async () => {
      operationStarted = true;
      return true;
    })).rejects.toThrow('device connection must be discovered over USB or Wi-Fi');
    expect(operationStarted).toBe(false);
  } finally {
    await rm(legacyRoot, { recursive: true, force: true });
  }
});

test('creates an ipadecrypt runtime config without requiring bootstrap credentials', () => {
  const config = JSON.parse(buildIpadecryptRuntimeConfig({ host: '127.0.0.1', port: 2222, user: 'mobile', keyPath: '/data/device-ssh/id_ed25519' })) as {
    version: number;
    apple?: { email?: string; password?: string };
    device?: { host?: string; port?: number; user?: string; auth?: { kind?: string; keyPath?: string } };
  };

  expect(config).toMatchObject({
    version: 2,
    apple: { email: 'managed-device@dkrypt.invalid' },
    device: { host: '127.0.0.1', port: 2222, user: 'mobile', auth: { kind: 'key', keyPath: '/data/device-ssh/id_ed25519' } },
  });
  expect(config.apple?.password).toBeUndefined();
});
