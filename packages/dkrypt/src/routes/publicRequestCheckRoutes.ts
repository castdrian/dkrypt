import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { lookupAppMetadata, lookupAppMetadataByTrackId } from '#appStoreMetadata.js';
import { normalizeTestFlightInvite, resolveTestFlightInvite } from '#testflightSubscriptions.js';
import { FixedWindowRateLimiter, setRateLimitHeaders } from '#util/rateLimit.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

const requestCheckRateLimiter = new FixedWindowRateLimiter(12, 60_000);
const appStoreHostnames = new Set(['apps.apple.com', 'itunes.apple.com']);
const bundleIdPattern = /^[A-Za-z0-9.-]{3,200}$/;

function trackIdFromAppStoreLink(value: string): number | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !appStoreHostnames.has(url.hostname) || url.username || url.password || url.port) return undefined;
  const match = /(?:^|\/)id(\d+)(?:$|\/)/i.exec(url.pathname);
  if (!match) return undefined;
  const trackId = Number(match[1]);
  return Number.isSafeInteger(trackId) && trackId > 0 ? trackId : undefined;
}

export const publicRequestCheckRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.post<{ Body: { input: string } }>('/v1/public/request-check', {
    schema: {
      hide: true,
      body: Type.Object({ input: Type.String({ minLength: 1, maxLength: 512 }) }),
      response: {
        200: Type.Object({
          requestable: Type.Boolean(),
          channel: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]),
          bundleId: Type.String(),
          displayName: Type.String(),
          iconUrl: Type.Optional(Type.String()),
          latestVersion: Type.Optional(Type.String()),
          inviteUrl: Type.Optional(Type.String()),
          nextStep: Type.String(),
        }),
      },
    },
  }, async (request, reply) => {
    const decision = requestCheckRateLimiter.consume(request.ip);
    setRateLimitHeaders(reply, decision, 'request-api', 60_000);
    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      return reply.code(429).send(createHttpErrorEnvelope(request.id, 429, 'too many app checks; try again shortly'));
    }

    const input = request.body.input.trim();
    const signal = AbortSignal.timeout(12_000);
    try {
      const trackId = trackIdFromAppStoreLink(input);
      if (trackId) {
        const metadata = await lookupAppMetadataByTrackId(trackId, undefined, signal);
        return {
          requestable: true,
          channel: 'appstore' as const,
          bundleId: metadata.bundleId,
          displayName: metadata.trackName,
          iconUrl: metadata.artworkUrl || undefined,
          latestVersion: metadata.version,
          nextStep: 'Sign in to choose a release and submit the decrypt request.',
        };
      }

      if (bundleIdPattern.test(input)) {
        const metadata = await lookupAppMetadata(input, signal);
        return {
          requestable: true,
          channel: 'appstore' as const,
          bundleId: metadata.bundleId,
          displayName: metadata.trackName,
          iconUrl: metadata.artworkUrl || undefined,
          latestVersion: metadata.version,
          nextStep: 'Sign in to choose a release and submit the decrypt request.',
        };
      }

      const invite = await resolveTestFlightInvite(input, signal);
      let latestVersion: string | undefined;
      try {
        latestVersion = (await lookupAppMetadataByTrackId(invite.appId, undefined, signal)).version;
      } catch {}
      return {
        requestable: true,
        channel: 'testflight' as const,
        bundleId: invite.bundleId,
        displayName: invite.displayName,
        iconUrl: invite.iconUrl || undefined,
        latestVersion,
        inviteUrl: normalizeTestFlightInvite(input).url,
        nextStep: 'Sign in to submit this TestFlight link. dkrypt will ask before adding access.',
      };
    } catch {
      return reply.code(422).send(createHttpErrorEnvelope(request.id, 422, 'dkrypt could not resolve that app. Check the link or bundle ID and try again.'));
    }
  });
};
