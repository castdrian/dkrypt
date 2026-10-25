import type { NextFunction, Request, Response } from '#http.js';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { getDeviceReadiness, peekPrimaryDeviceHealth } from '#deviceHealth.js';
import { getEffectiveSettings, getPrimaryDevice, hasSustainedDeviceHealthFailures } from '#store/state.js';

export interface MaintenanceStatus {
  active: boolean;
  manual: boolean;
  auto: boolean;
  reason?: string;
}

export function getMaintenanceStatus(): MaintenanceStatus {
  const manual = getEffectiveSettings().maintenanceMode;

  let auto = false;
  let autoReason: string | undefined;
  const health = peekPrimaryDeviceHealth();
  if (health) {
    const readiness = health.readiness ?? getDeviceReadiness(health);
    const primary = getPrimaryDevice();
    const offlineConfirmed = primary !== undefined && hasSustainedDeviceHealthFailures(primary.id);
    const hardBlock = readiness.reasons.some((reason) => /unreachable|storage|temperature|battery|internet access/i.test(reason));
    if (readiness.state === 'blocked' && (health.reachable ? hardBlock : offlineConfirmed)) {
      auto = true;
      autoReason = readiness.reasons[0] ?? 'the iDevice is not ready for automation';
    }
  }

  return {
    active: manual || auto,
    manual,
    auto,
    reason: manual ? 'maintenance mode is enabled' : autoReason,
  };
}

export function blockDuringMaintenance(_req: Request, res: Response, next: NextFunction): void {
  const status = getMaintenanceStatus();
  if (status.active) {
    res.error('maintenance_mode', `decrypts are paused for maintenance${status.reason ? ` - ${status.reason}` : ''}`, 503, true, { maintenance: true });
    return;
  }
  next();
}

export function fastifyBlockDuringMaintenance(request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
  const status = getMaintenanceStatus();
  if (status.active) {
    sendMaintenanceBlocked(request, reply, status.reason);
    return;
  }
  done();
}

export function fastifyBlockManualMaintenance(request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
  const status = getMaintenanceStatus();
  if (status.manual) {
    sendMaintenanceBlocked(request, reply, status.reason);
    return;
  }
  done();
}

function sendMaintenanceBlocked(request: FastifyRequest, reply: FastifyReply, reason?: string): void {
  const message = `decrypts are paused for maintenance${reason ? ` - ${reason}` : ''}`;
  reply.code(503).send({ error: message, code: 'maintenance_mode', message, requestId: request.id, retryable: true, remediation: { maintenance: true } });
}
