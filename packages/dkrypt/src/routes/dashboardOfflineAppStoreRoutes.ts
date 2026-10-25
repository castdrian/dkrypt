import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { checkAppleDownloaderNetwork, getAppleAccountAuthenticationStatus, getOfflineAppStoreReadiness, refreshAppleAccountStorefrontCountry, resetAppleAccountAuthentication, startAppleAccountAuthentication } from '#offlineAppStore.js';
import { clearAppleAccountCredentials, saveAppleAccountCredentials, saveAppleAccountFairPlayCredential } from '#appleAccountVault.js';
import type { AppleAccountAuthenticationStatus } from '#offlineAppStoreAuthOperation.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireRecentAuthentication, fastifyRequireSession, getFastifySession } from '#session.js';
import { recordAudit } from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { getFairPlayCredentialRetrievalStatus, startFairPlayCredentialRetrieval } from '#offlineAppStoreCredential.js';
import type { CredentialRetrievalStatus } from '#offlineAppStoreCredential.js';

interface DashboardOfflineAppStoreServices {
  readiness: typeof getOfflineAppStoreReadiness;
  refreshStorefrontCountry: typeof refreshAppleAccountStorefrontCountry;
  saveAccount: typeof saveAppleAccountCredentials;
  saveCredential: typeof saveAppleAccountFairPlayCredential;
  getAuthenticationStatus: () => AppleAccountAuthenticationStatus;
  startAuthentication: (verificationCode?: string, retrySavedCredentials?: boolean) => AppleAccountAuthenticationStatus;
  resetAuthentication: () => void;
  getCredentialRetrievalStatus: typeof getFairPlayCredentialRetrievalStatus;
  retrieveCredential: typeof startFairPlayCredentialRetrieval;
  clear: typeof clearAppleAccountCredentials;
  checkDownloaderNetwork: typeof checkAppleDownloaderNetwork;
}

const defaultServices: DashboardOfflineAppStoreServices = {
  readiness: getOfflineAppStoreReadiness,
  refreshStorefrontCountry: refreshAppleAccountStorefrontCountry,
  saveAccount: saveAppleAccountCredentials,
  saveCredential: saveAppleAccountFairPlayCredential,
  getAuthenticationStatus: getAppleAccountAuthenticationStatus,
  startAuthentication: startAppleAccountAuthentication,
  resetAuthentication: resetAppleAccountAuthentication,
  getCredentialRetrievalStatus: getFairPlayCredentialRetrievalStatus,
  retrieveCredential: startFairPlayCredentialRetrieval,
  clear: clearAppleAccountCredentials,
  checkDownloaderNetwork: checkAppleDownloaderNetwork,
};

export function createDashboardOfflineAppStoreRoutes(
  overrides: Partial<DashboardOfflineAppStoreServices> = {},
): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };
  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    const administrator = fastifyRequirePermission(PermissionFlag.administrator);
    const reauthenticatedAdministrator = [administrator, fastifyRequireRecentAuthentication()];

    server.get('/v1/dashboard/appstore-offline/status', {
      schema: { hide: true },
      preHandler: administrator,
    }, () => {
      void services.refreshStorefrontCountry().catch(() => {});
      return { ...services.readiness(), authentication: services.getAuthenticationStatus(), credentialRetrieval: services.getCredentialRetrievalStatus() };
    });

    server.post('/v1/dashboard/appstore-offline/verify', {
      schema: { hide: true },
      preHandler: administrator,
    }, () => {
      const readiness = services.readiness();
      const authentication = services.getAuthenticationStatus();
      const checks = [
        { id: 'processing-enabled', ready: readiness.enabled, detail: readiness.enabled ? 'Server-side App Store processing is enabled' : 'Server-side App Store processing is disabled' },
        { id: 'downloader', ready: readiness.downloaderAvailable, detail: readiness.downloaderAvailable ? 'App Store downloader is executable' : 'App Store downloader is unavailable' },
        { id: 'decryptor', ready: readiness.decryptorAvailable, detail: readiness.decryptorAvailable ? 'FairPlay decryptor is executable' : 'FairPlay decryptor is unavailable' },
        { id: 'vault-encryption', ready: readiness.vault.encryptionReady, detail: readiness.vault.encryptionReady ? 'External credential encryption is ready' : 'External credential encryption key is unavailable' },
        { id: 'apple-session', ready: Boolean(readiness.vault.authenticatedAt) && authentication.state !== 'running', detail: readiness.vault.authenticatedAt ? 'Apple Account session is verified' : 'Apple Account session is not verified' },
        { id: 'fairplay-key', ready: readiness.vault.credentialConfigured, detail: readiness.vault.credentialConfigured ? 'At least one device-derived FairPlay key is available' : 'No device-derived FairPlay key is configured' },
      ];
      return { ok: checks.every((check) => check.ready), checkedAt: new Date().toISOString(), purchaseMade: false, downloadStarted: false, checks };
    });

    server.post('/v1/dashboard/appstore-offline/network-check', {
      schema: { hide: true },
      preHandler: administrator,
    }, async (request, reply) => {
      try {
        const result = await services.checkDownloaderNetwork();
        return { ...result, checkedAt: new Date().toISOString() };
      } catch {
        return reply.code(502).send(createHttpErrorEnvelope(request.id, 502, 'The App Store downloader network check could not run'));
      }
    });

    server.post('/v1/dashboard/appstore-offline/credential/retrieve', {
      schema: { hide: true, body: Type.Object({ deviceId: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }) },
      preHandler: reauthenticatedAdministrator,
    }, (request, reply) => {
      try {
        const previousOperationId = services.getCredentialRetrievalStatus().operationId;
        const retrieval = services.retrieveCredential(request.body.deviceId);
        if (retrieval.state === 'running' && retrieval.operationId !== previousOperationId) {
          recordAudit(getFastifySession(request)!.sub, 'settings.update', 'appstore-offline-credential', `FairPlay credential retrieval started for device ${request.body.deviceId}`);
        }
        return reply.code(202).send({ ...services.readiness(), credentialRetrieval: retrieval as CredentialRetrievalStatus });
      } catch (error) {
        return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, error instanceof Error ? error.message : 'Could not start FairPlay credential retrieval'));
      }
    });

    server.put('/v1/dashboard/appstore-offline/account', {
      schema: { hide: true, body: Type.Object({ appleId: Type.String({ minLength: 3, maxLength: 320, format: 'email' }), password: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }) },
      preHandler: reauthenticatedAdministrator,
    }, (request, reply) => {
      try {
        if (services.getAuthenticationStatus().state === 'running') throw new Error('Apple Account verification is currently running');
        services.saveAccount(request.body.appleId, request.body.password);
        services.resetAuthentication();
        recordAudit(getFastifySession(request)!.sub, 'settings.update', 'appstore-offline-account', 'Apple Account credentials updated');
        return services.readiness();
      } catch (error) {
        return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, error instanceof Error ? error.message : 'Could not save Apple Account credentials'));
      }
    });

    server.post('/v1/dashboard/appstore-offline/authenticate', {
      schema: { hide: true, body: Type.Object({ verificationCode: Type.Optional(Type.String({ pattern: '^\\d{6}$' })), retrySavedCredentials: Type.Optional(Type.Boolean()) }, { additionalProperties: false }) },
      preHandler: reauthenticatedAdministrator,
    }, (request, reply) => {
      try {
        const previous = services.getAuthenticationStatus();
        const authentication = services.startAuthentication(request.body.verificationCode, request.body.retrySavedCredentials);
        if (authentication.operationId && authentication.operationId !== previous.operationId) {
          recordAudit(getFastifySession(request)!.sub, 'settings.update', 'appstore-offline-account', 'Apple Account verification started');
        }
        return reply.code(202).send({ ...services.readiness(), authentication, credentialRetrieval: services.getCredentialRetrievalStatus() });
      } catch (error) {
        return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, error instanceof Error ? error.message : 'Apple Account authentication failed'));
      }
    });

    server.put('/v1/dashboard/appstore-offline/credential', {
      schema: { hide: true, body: Type.Object({ credential: Type.String({ minLength: 16, maxLength: 128 }) }, { additionalProperties: false }) },
      preHandler: reauthenticatedAdministrator,
    }, (request, reply) => {
      try {
        services.saveCredential(request.body.credential);
        recordAudit(getFastifySession(request)!.sub, 'settings.update', 'appstore-offline-credential', 'Device-derived FairPlay credential updated');
        return services.readiness();
      } catch (error) {
        return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, error instanceof Error ? error.message : 'Could not save FairPlay credential'));
      }
    });

    server.delete('/v1/dashboard/appstore-offline/account', {
      schema: { hide: true },
      preHandler: reauthenticatedAdministrator,
    }, (request, reply) => {
      if (services.getAuthenticationStatus().state === 'running') return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, 'Apple Account verification is currently running'));
      if (!services.clear()) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'Apple Account is not configured'));
      services.resetAuthentication();
      recordAudit(getFastifySession(request)!.sub, 'settings.update', 'appstore-offline-account', 'Apple Account credentials removed');
      return services.readiness();
    });
  };
}

export const dashboardOfflineAppStoreRoutes = createDashboardOfflineAppStoreRoutes();
