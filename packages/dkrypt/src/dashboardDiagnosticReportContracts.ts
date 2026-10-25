import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';

const reportCategorySchema = Type.Union([Type.Literal('bug'), Type.Literal('device'), Type.Literal('job'), Type.Literal('other')]);

export const diagnosticReportPreviewBodySchema = Type.Object({
  category: reportCategorySchema,
  summary: Type.String({ minLength: 1, maxLength: 200 }),
  details: Type.String({ minLength: 1, maxLength: 5000 }),
}, { additionalProperties: false });

export const diagnosticReportSubmitBodySchema = Type.Object({
  category: reportCategorySchema,
  summary: Type.String({ minLength: 1, maxLength: 200 }),
  details: Type.String({ minLength: 1, maxLength: 5000 }),
  previewToken: Type.String({ minLength: 1, maxLength: 256 }),
  consent: Type.Literal(true),
}, { additionalProperties: false });

export const diagnosticReportRecordSchema = Type.Object({
  id: Type.String(),
  userId: Type.Optional(Type.String()),
  userDisplayName: Type.Optional(Type.String()),
  category: reportCategorySchema,
  summary: Type.String(),
  details: Type.String(),
  createdAt: Type.Number(),
  expiresAt: Type.Number(),
  status: Type.Literal('received'),
}, { additionalProperties: false });

export const diagnosticReportPreviewResponseSchema = Type.Object({
  category: reportCategorySchema,
  summary: Type.String(),
  details: Type.String(),
  previewToken: Type.String(),
  expiresAt: Type.Number(),
}, { additionalProperties: false });

export const diagnosticReportListResponseSchema = Type.Object({ reports: Type.Array(diagnosticReportRecordSchema) }, { additionalProperties: false });

export type DiagnosticReportPreviewRoute = { Body: Static<typeof diagnosticReportPreviewBodySchema>; Reply: { 200: Static<typeof diagnosticReportPreviewResponseSchema>; 400: ApiErrorEnvelope; 404: ApiErrorEnvelope } };
export type DiagnosticReportSubmitRoute = { Body: Static<typeof diagnosticReportSubmitBodySchema>; Reply: { 201: Static<typeof diagnosticReportRecordSchema>; 400: ApiErrorEnvelope; 404: ApiErrorEnvelope } };
export type DiagnosticReportListRoute = { Reply: { 200: Static<typeof diagnosticReportListResponseSchema> } };
export type DiagnosticReportInboxRoute = { Reply: { 200: Static<typeof diagnosticReportListResponseSchema> } };
