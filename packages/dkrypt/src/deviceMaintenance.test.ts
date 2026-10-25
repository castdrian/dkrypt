import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { setCachedDeviceHealth } from '#deviceHealthCache.js';
import { getDeviceHealth } from '#deviceHealth.js';
import { fastifyBlockDuringMaintenance, fastifyBlockManualMaintenance, getMaintenanceStatus } from '#maintenance.js';
import { createDevice, deleteDevice, getEffectiveSettings, recordDeviceHealthCheck, updateSettings } from '#store/state.js';

function recordHealthChecksAt(deviceId: string, timestamps: number[]): void {
  for (const timestamp of timestamps) {
    const originalNow = Date.now;
    Date.now = () => timestamp;
    try {
      recordDeviceHealthCheck(deviceId, false);
    } finally {
      Date.now = originalNow;
    }
  }
}

function runManualMaintenanceGuard(): { next: boolean; status?: number; code?: string } {
  let next = false;
  let status: number | undefined;
  let code: string | undefined;
  const request = { id: 'maintenance-test' };
  const reply = {
    code(value: number) { status = value; return this; },
    send(value: { code?: string }) { code = value.code; return this; },
  };
  fastifyBlockManualMaintenance(request as never, reply as never, (() => { next = true; }) as never);
  return { next, status, code };
}

function runAutomaticMaintenanceGuard(): { next: boolean; status?: number; code?: string } {
  let next = false;
  let status: number | undefined;
  let code: string | undefined;
  const request = { id: 'automatic-maintenance-test' };
  const reply = {
    code(value: number) { status = value; return this; },
    send(value: { code?: string }) { code = value.code; return this; },
  };
  fastifyBlockDuringMaintenance(request as never, reply as never, (() => { next = true; }) as never);
  return { next, status, code };
}

test('transient forced device probes do not automatically pause decrypts', async () => {
  const suffix = randomUUID();
  const now = Date.now();
  const originalMaintenanceMode = getEffectiveSettings().maintenanceMode;
  const device = createDevice({
    name: `Transient probe ${suffix}`,
    transport: 'wifi',
    host: '127.0.0.1',
    port: 1,
    user: 'mobile',
    isPrimary: true,
  }, 'test');
  updateSettings({ maintenanceMode: false }, 'test');
  recordHealthChecksAt(device.id, [now - 90 * 60_000, now - 85 * 60_000, now - 80 * 60_000]);

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) await getDeviceHealth(device.id, true);

    expect(getMaintenanceStatus()).toMatchObject({ active: false, manual: false, auto: false });

    recordHealthChecksAt(device.id, [now]);
    setCachedDeviceHealth(device.id, { reachable: false, checkedAt: Date.now() });
    expect(getMaintenanceStatus()).toMatchObject({ active: false, manual: false, auto: false });

    recordHealthChecksAt(device.id, [now - 10 * 60_000, now - 5 * 60_000]);
    setCachedDeviceHealth(device.id, { reachable: false, checkedAt: Date.now() });

    expect(getMaintenanceStatus()).toMatchObject({ active: true, manual: false, auto: true });
    expect(runManualMaintenanceGuard()).toMatchObject({ next: true });
    expect(runAutomaticMaintenanceGuard()).toMatchObject({ next: false, status: 503, code: 'maintenance_mode' });
    updateSettings({ maintenanceMode: true }, 'test');
    expect(runManualMaintenanceGuard()).toMatchObject({ next: false, status: 503, code: 'maintenance_mode' });
  } finally {
    updateSettings({ maintenanceMode: originalMaintenanceMode }, 'test');
    deleteDevice(device.id, 'test');
  }
});
