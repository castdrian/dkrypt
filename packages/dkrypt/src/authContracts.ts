import { Type, type Static } from '@sinclair/typebox';
import { identifierSchema } from '#apiCommonContracts.js';

export const authLoginBodySchema = Type.Object(
  {
    password: Type.String({ minLength: 1, maxLength: 500 }),
    mfaToken: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: true },
);

export const authTokenBodySchema = Type.Object({ token: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: true });
export const authSignupChallengeBodySchema = Type.Object({ token: Type.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false });
export const authReauthenticateBodySchema = Type.Object(
  {
    password: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    mfaToken: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: true },
);
export const authPrivacyDeleteBodySchema = Type.Object({ confirmation: Type.Literal('DELETE MY ACCOUNT') }, { additionalProperties: true });
export const authProfileBodySchema = Type.Object({ displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), username: Type.Optional(Type.String({ minLength: 2, maxLength: 40 })) }, { additionalProperties: true, minProperties: 1 });
export const authConnectionParamsSchema = Type.Object(
  { provider: Type.Union([Type.Literal('github'), Type.Literal('discord')]) },
  { additionalProperties: true },
);
export const authConnectionBodySchema = Type.Object({ confirmation: Type.Literal('DISCONNECT') }, { additionalProperties: false });
export const authIdentifierParamsSchema = Type.Object({ id: identifierSchema }, { additionalProperties: true });
export const authPasskeyPayloadSchema = Type.Record(Type.String({ minLength: 1, maxLength: 120 }), Type.Unknown());
export const authOAuthCallbackQuerySchema = Type.Object(
  {
    code: Type.Optional(Type.String({ maxLength: 2000 })),
    state: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: true },
);

export type AuthLoginRoute = { Body: Static<typeof authLoginBodySchema> };
export type AuthTokenRoute = { Body: Static<typeof authTokenBodySchema> };
export type AuthSignupChallengeRoute = { Body: Static<typeof authSignupChallengeBodySchema> };
export type AuthReauthenticateRoute = { Body: Static<typeof authReauthenticateBodySchema> };
export type AuthPrivacyDeleteRoute = { Body: Static<typeof authPrivacyDeleteBodySchema> };
export type AuthProfileRoute = { Body: Static<typeof authProfileBodySchema> };
export type AuthConnectionRoute = { Params: Static<typeof authConnectionParamsSchema>; Body: Static<typeof authConnectionBodySchema> };
export type AuthIdentifierRoute = { Params: Static<typeof authIdentifierParamsSchema> };
export type AuthPasskeyPayloadRoute = { Body: Static<typeof authPasskeyPayloadSchema> };
export type AuthOAuthCallbackRoute = { Querystring: Static<typeof authOAuthCallbackQuerySchema> };
