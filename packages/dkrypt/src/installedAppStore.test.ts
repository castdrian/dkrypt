import { expect, test } from 'bun:test';
import type { DeviceSession } from './idevice.js';
import { findInstalledAppStoreBundle } from './idevice.js';
import { probeDirectAppStore, submitDirectAppStore } from './directAppStore.js';

function session(respond: (command: string) => { stdout: string; code: number | null }): DeviceSession {
  return { transport: 'autoinstall', runtimeDir: '/tmp', close() {}, async exec(command) { return { ...respond(command), stderr: '' }; } };
}

const appPath = '/var/containers/Bundle/Application/ABC/Example.app';

test('native installed-bundle inspection accepts a verified bundle and rejects a placeholder', async () => {
  const conn = session(() => ({ stdout: JSON.stringify({ ok: true, appPath }), code: 0 }));
  expect(await findInstalledAppStoreBundle(conn, 'com.example.app')).toBe(appPath);
  const empty = session(() => ({ stdout: JSON.stringify({ ok: true, appPath: null }), code: 0 }));
  expect(await findInstalledAppStoreBundle(empty, 'com.example.app')).toBeUndefined();
});

test('native inspection errors do not fall back to the older filesystem check', async () => {
  let requests = 0;
  const conn = session(() => { requests++; return { stdout: 'not-json', code: 1 }; });
  await expect(findInstalledAppStoreBundle(conn, 'com.example.app')).rejects.toThrow('invalid JSON');
  expect(requests).toBe(1);
});

test('legacy inspection compares parsed bundle IDs exactly and checks executable licenses', async () => {
  const commands: string[] = [];
  const plist = (identifier: string) => Buffer.from(`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>ActualName</string></dict></plist>`).toString('base64');
  const conn = session((command) => {
    commands.push(command);
    if (command.includes('autoinstall-appstore inspect')) return { stdout: '', code: 127 };
    if (command.startsWith('for d')) return { stdout: `${appPath}\t${plist('com.example.application')}\n${appPath}\t${plist('com.example.app')}\n`, code: 0 };
    return { stdout: '', code: 0 };
  });
  expect(await findInstalledAppStoreBundle(conn, 'com.example.app')).toBe(appPath);
  expect(commands).toHaveLength(3);
  expect(commands[2]).toContain('/ActualName');
  expect(commands[2]).toContain('.supf');
});

test('bundle inspection rejects shell syntax before executing any command', async () => {
  const conn = session(() => { throw new Error('must not execute'); });
  await expect(findInstalledAppStoreBundle(conn, "com.example';id")).rejects.toThrow('unsafe');
});

test('direct backend probing accepts explicit absence but rejects malformed responses', async () => {
  expect(await probeDirectAppStore(session(() => ({ stdout: '', code: 127 })))).toBeUndefined();
  await expect(probeDirectAppStore(session(() => ({ stdout: '{}', code: 0 })))).rejects.toThrow('purchase failed');
  await expect(probeDirectAppStore(session(() => ({ stdout: 'not-json', code: 0 })))).rejects.toThrow('invalid response');
});

test('uncertain purchase results are explicitly non-retryable and are never resubmitted', async () => {
  let count = 0;
  const conn = session(() => { count++; return { stdout: JSON.stringify({ ok: false, error: 'App Store purchase outcome is unknown' }), code: 0 }; });
  const request = { bundleId: 'com.example.app', adamId: '123', operationId: 'test-operation', verifiedPrice: 0 };
  try { await submitDirectAppStore(conn, request); throw new Error('expected failure'); }
  catch (error) { expect(error).toMatchObject({ retryable: false, message: 'App Store purchase outcome is unknown' }); }
  expect(count).toBe(1);
});
