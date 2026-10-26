import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import type { Response } from '#http.js';
import { createDashboardDiagnosticReportRoutes } from '#routes/dashboardDiagnosticReportRoutes.js';
import { deleteAuthProfile, upsertAuthProfile } from '#identity.js';
import { addAllowedUser, createRole, deleteRole, removeAllowedUser } from '#store/state.js';
import { serializeBits } from '#permissions.js';
import type { DiagnosticReportRecord, DiagnosticReportRepository } from '#store/diagnosticReportRepository.js';

function sessionCookie(permissions = 0n, sub = 'root'): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub, permissions });
  return value.split(';', 1)[0]!;
}

function memoryRepository(): DiagnosticReportRepository {
  const records: DiagnosticReportRecord[] = [];
  return {
    create(report) { records.push(report); },
    listByUser(userId, limit) { return records.filter((report) => report.userId === userId).slice(0, limit); },
    listRecent(limit) { return records.slice(0, limit); },
    findById(id) { const report = records.find((item) => item.id === id); return report ? structuredClone(report) : undefined; },
    appendMessage(id, message, _updatedAt) {
      const report = records.find((item) => item.id === id);
      if (!report) return undefined;
      report.messages = [...(report.messages ?? []), message].slice(-200);
      return structuredClone(report);
    },
    pruneExpired(now) {
      const previousLength = records.length;
      for (let index = records.length - 1; index >= 0; index -= 1) if (records[index]!.expiresAt <= now) records.splice(index, 1);
      return previousLength - records.length;
    },
    close() {},
  };
}

test('diagnostic reports require a reviewed redacted preview, consent, and expire after 30 days', async () => {
  const repository = memoryRepository();
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  const managerId = `github:support-${crypto.randomUUID()}`;
  const managerName = `support-${crypto.randomUUID().slice(0, 12)}`;
  const managerRole = createRole({ name: `Support ${managerName}`, color: '#3855d6', permissions: serializeBits(PermissionFlag.viewDiagnosticReports) }, 'test setup');
  upsertAuthProfile({ userId: managerId, provider: 'github', providerId: crypto.randomUUID(), username: managerName, displayName: 'Support Manager', updatedAt: new Date().toISOString() });
  addAllowedUser(managerId, [managerRole.id], 'test setup');
  await server.register(createDashboardDiagnosticReportRoutes({
    repository,
  }));

  try {
    const preview = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/diagnostic-reports/preview',
      headers: { cookie: sessionCookie() },
      payload: { category: 'job', summary: 'Job failed for owner@example.com', details: 'Authorization: Bearer sensitive-value\nDevice 10.0.0.1 failed at 2001:db8::1 with UDID 0123456789abcdef0123456789abcdef01234567. See https://example.test/?token=secret-value.' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().summary).not.toContain('owner@example.com');
    expect(preview.json().details).not.toContain('sensitive-value');
    expect(preview.json().details).not.toContain('10.0.0.1');
    expect(preview.json().details).not.toContain('2001:db8::1');
    expect(preview.json().details).not.toContain('0123456789abcdef0123456789abcdef01234567');
    expect(preview.json().details).not.toContain('example.test');
    expect(preview.json().details).not.toContain('secret-value');

    const submission = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/diagnostic-reports',
      headers: { cookie: sessionCookie() },
      payload: { category: preview.json().category, summary: preview.json().summary, details: preview.json().details, previewToken: preview.json().previewToken, consent: true },
    });
    expect(submission.statusCode).toBe(201);
    expect(submission.json().userId).toBeUndefined();
    expect(submission.json().expiresAt - submission.json().createdAt).toBe(30 * 24 * 60 * 60 * 1000);
    const deniedInbox = await server.inject({ method: 'GET', url: '/v1/dashboard/diagnostic-reports/inbox', headers: { cookie: sessionCookie() } });
    const inbox = await server.inject({ method: 'GET', url: '/v1/dashboard/diagnostic-reports/inbox', headers: { cookie: sessionCookie(PermissionFlag.viewDiagnosticReports) } });
    expect(deniedInbox.statusCode).toBe(403);
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().reports[0].userId).toBe('root');

    const deniedReply = await server.inject({ method: 'POST', url: `/v1/dashboard/diagnostic-reports/${submission.json().id}/replies`, headers: { cookie: sessionCookie(0n, 'other-member') }, payload: { message: 'I can see this?' } });
    const supportReply = await server.inject({ method: 'POST', url: `/v1/dashboard/diagnostic-reports/${submission.json().id}/replies`, headers: { cookie: sessionCookie(PermissionFlag.viewDiagnosticReports, managerId) }, payload: { message: 'Resolved for contact@example.com' } });
    expect(deniedReply.statusCode).toBe(404);
    expect(supportReply.statusCode).toBe(200);
    expect(supportReply.json().messages).toEqual([expect.objectContaining({ authorRole: 'support', body: 'Resolved for [redacted]' })]);
    expect(supportReply.json().messages[0].authorId).toBeUndefined();

    const ownerReply = await server.inject({ method: 'POST', url: `/v1/dashboard/diagnostic-reports/${submission.json().id}/replies`, headers: { cookie: sessionCookie() }, payload: { message: 'Thanks, confirmed.' } });
    expect(ownerReply.statusCode).toBe(200);
    expect(ownerReply.json().messages.map((message: { authorRole: string }) => message.authorRole)).toEqual(['support', 'reporter']);

    const changedSubmission = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/diagnostic-reports',
      headers: { cookie: sessionCookie() },
      payload: { category: preview.json().category, summary: 'changed after preview', details: preview.json().details, previewToken: preview.json().previewToken, consent: true },
    });
    expect(changedSubmission.statusCode).toBe(400);
  } finally {
    await server.close();
    removeAllowedUser(managerId, 'test cleanup');
    deleteAuthProfile(managerId);
    deleteRole(managerRole.id, 'test cleanup');
  }
});
