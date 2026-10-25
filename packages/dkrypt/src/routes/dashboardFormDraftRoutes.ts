import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { getUserPrefs, updateUserPrefs, type AccountFormDraft, type AccountFormDraftKind } from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

const draftIdSchema = Type.String({ minLength: 3, maxLength: 140, pattern: '^(api-key:new|device:[A-Za-z0-9_:-]{1,100}|role:(new|[A-Za-z0-9_-]{1,80}))$' });
const draftKindSchema = Type.Union([Type.Literal('api-key'), Type.Literal('device'), Type.Literal('role')]);
const saveDraftBodySchema = Type.Object({
  kind: draftKindSchema,
  values: Type.Record(Type.String({ maxLength: 40 }), Type.String({ maxLength: 2000 }), { maxProperties: 8 }),
}, { additionalProperties: false });

type DraftParams = { Params: { id: string } };
type SaveDraftRoute = DraftParams & { Body: { kind: AccountFormDraftKind; values: Record<string, string> } };

function draftKindForId(id: string): AccountFormDraftKind | undefined {
  if (id === 'api-key:new') return 'api-key';
  if (id.startsWith('device:')) return 'device';
  if (id.startsWith('role:')) return 'role';
  return undefined;
}

function sanitizeDraft(kind: AccountFormDraftKind, values: Record<string, string>): Record<string, string> | undefined {
  const limits: Record<AccountFormDraftKind, Record<string, { maxLength: number; pattern?: RegExp }>> = {
    'api-key': {
      name: { maxLength: 80 },
      expiresInDays: { maxLength: 3, pattern: /^(never|1|7|30|90)$/ },
      bundleScope: { maxLength: 2000 },
      dailyLimit: { maxLength: 7, pattern: /^\d*$/ },
    },
    device: {
      name: { maxLength: 80 },
      iosVersion: { maxLength: 40 },
      toolchain: { maxLength: 120 },
      notes: { maxLength: 1000 },
    },
    role: {
      name: { maxLength: 64 },
      color: { maxLength: 7, pattern: /^#[0-9a-fA-F]{6}$/ },
      permissions: { maxLength: 200, pattern: /^\d+$/ },
    },
  };
  const allowed = limits[kind];
  if (Object.keys(values).some((key) => !allowed[key])) return undefined;
  for (const [key, value] of Object.entries(values)) {
    const limit = allowed[key]!;
    if (value.length > limit.maxLength || (limit.pattern && !limit.pattern.test(value))) return undefined;
  }
  return { ...values };
}

function validStoredDraft(id: string, value: unknown): value is AccountFormDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<AccountFormDraft>;
  const expectedKind = draftKindForId(id);
  if (!expectedKind || draft.kind !== expectedKind || !Number.isSafeInteger(draft.savedAt)) return false;
  if (!draft.values || typeof draft.values !== 'object' || Array.isArray(draft.values)) return false;
  const values = draft.values as Record<string, unknown>;
  if (Object.values(values).some((entry) => typeof entry !== 'string')) return false;
  return Boolean(sanitizeDraft(expectedKind, values as Record<string, string>));
}

function validStoredDrafts(userId: string): Record<string, AccountFormDraft> {
  const stored = getUserPrefs(userId).formDrafts;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter(([id, draft]) => validStoredDraft(id, draft)));
}

export const dashboardFormDraftRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DraftParams>('/v1/dashboard/me/form-drafts/:id', {
    schema: { hide: true, params: Type.Object({ id: draftIdSchema }) },
  }, (request) => {
    const userId = getFastifySession(request)!.sub;
    const draft = validStoredDrafts(userId)[request.params.id];
    return { draft };
  });

  server.put<SaveDraftRoute>('/v1/dashboard/me/form-drafts/:id', {
    schema: { hide: true, params: Type.Object({ id: draftIdSchema }), body: saveDraftBodySchema },
  }, (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    if (draftKindForId(request.params.id) !== request.body.kind) {
      return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'draft type does not match its ID'));
    }
    const values = sanitizeDraft(request.body.kind, request.body.values);
    if (!values) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'draft contains unsupported or invalid fields'));
    const drafts = validStoredDrafts(userId);
    drafts[request.params.id] = { kind: request.body.kind, values, savedAt: Date.now() } satisfies AccountFormDraft;
    const entries = Object.entries(drafts).sort((left, right) => right[1].savedAt - left[1].savedAt).slice(0, 40);
    updateUserPrefs(userId, { formDrafts: Object.fromEntries(entries) });
    return { draft: drafts[request.params.id] };
  });

  server.delete<DraftParams>('/v1/dashboard/me/form-drafts/:id', {
    schema: { hide: true, params: Type.Object({ id: draftIdSchema }) },
  }, (request) => {
    const userId = getFastifySession(request)!.sub;
    const drafts = validStoredDrafts(userId);
    delete drafts[request.params.id];
    updateUserPrefs(userId, { formDrafts: drafts });
    return { ok: true };
  });
};
