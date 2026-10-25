import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import type { Response } from '#http.js';
import { createDashboardDiagnosticReportRoutes } from '#routes/dashboardDiagnosticReportRoutes.js';
import type { DiagnosticReportRecord, DiagnosticReportRepository } from '#store/diagnosticReportRepository.js';

function sessionCookie(permissions = 0n): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

function memoryRepository(): DiagnosticReportRepository {
  const records: DiagnosticReportRecord[] = [];
  return {
    create(report) { records.push(report); },
    listByUser(userId, limit) { return records.filter((report) => report.userId === userId).slice(0, limit); },
    listRecent(limit) { return records.slice(0, limit); },
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
  await server.register(createDashboardDiagnosticReportRoutes({
    repository,
  }));

  try {
    const preview = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/diagnostic-reports/preview',
      headers: { cookie: sessionCookie() },
      payload: { category: 'job', summary: 'Job failed for owner@example.com', details: 'Authorization: Bearer sensitive-value\nDevice 10.0.0.1 failed at 2001:db8::1 with UDID 0123456789abcdef0123456789abcdef01234567.' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().summary).not.toContain('owner@example.com');
    expect(preview.json().details).not.toContain('sensitive-value');
    expect(preview.json().details).not.toContain('10.0.0.1');
    expect(preview.json().details).not.toContain('2001:db8::1');
    expect(preview.json().details).not.toContain('0123456789abcdef0123456789abcdef01234567');

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

    const changedSubmission = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/diagnostic-reports',
      headers: { cookie: sessionCookie() },
      payload: { category: preview.json().category, summary: 'changed after preview', details: preview.json().details, previewToken: preview.json().previewToken, consent: true },
    });
    expect(changedSubmission.statusCode).toBe(400);
  } finally {
    await server.close();
  }
});
