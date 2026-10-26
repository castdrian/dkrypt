import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { evaluateAutoinstallVersion, getAutoinstallCompatibilityRows, supportedCompatibility } from '#compatibility.js';
import { setCachedDeviceHealth } from '#deviceHealthCache.js';

test('compatibility policy accepts supported semantic Autoinstall versions', () => {
  expect(supportedCompatibility.autoinstallMinimum).toBe('1.4.0');
  expect(evaluateAutoinstallVersion('1.4.0')).toBe('supported');
  expect(evaluateAutoinstallVersion('1.4.0-rc.1')).toBe('unsupported');
  expect(evaluateAutoinstallVersion('1.4.4')).toBe('supported');
  expect(evaluateAutoinstallVersion('1.5.0')).toBe('supported');
  expect(evaluateAutoinstallVersion('1.3.9')).toBe('unsupported');
  expect(evaluateAutoinstallVersion('2.0.0')).toBe('unsupported');
  expect(evaluateAutoinstallVersion(undefined)).toBe('unknown');
  expect(evaluateAutoinstallVersion('not-a-version')).toBe('unknown');
});

test('Autoinstall compatibility uses the current device heartbeat without forcing another probe', async () => {
  const calls: Array<{ deviceId: string; force: boolean; signal?: AbortSignal }> = [];
  const rows = await getAutoinstallCompatibilityRows(
    [{ id: 'device-1', name: 'Adrian’s iPad' }],
    async (deviceId, force, signal) => {
      calls.push({ deviceId, force: force ?? false, signal });
      return { reachable: true, checkedAt: Date.now(), bridgeHeartbeats: { springboard: { at: Date.now() / 1000, bridgeVersion: '1.4.14' } } };
    },
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ deviceId: 'device-1', force: false });
  expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(rows).toEqual([{
    component: 'Adrian’s iPad Autoinstall',
    observed: '1.4.14',
    supported: '>=1.4.0 <2.0.0',
    state: 'supported',
    detail: 'device-1',
  }]);
});

test('Autoinstall compatibility retains a known version when the live device check fails', async () => {
  const deviceId = `device-${randomUUID()}`;
  setCachedDeviceHealth(deviceId, {
    reachable: true,
    checkedAt: Date.now(),
    bridgeHeartbeats: { springboard: { at: Date.now() / 1000, bridgeVersion: '1.4.14' } },
  });

  const rows = await getAutoinstallCompatibilityRows(
    [{ id: deviceId, name: 'Adrian’s iPad' }],
    async () => { throw new Error('device check unavailable'); },
  );

  expect(rows[0]).toMatchObject({ observed: '1.4.14', state: 'supported' });
});
