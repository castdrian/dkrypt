import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { listArtifacts, type ArtifactRecord } from '#artifacts.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession } from '#session.js';
import { getAllJobHistory, getAppCatalogEntries, getEffectiveDevices, getTestFlightCatalogCache, upsertAppCatalogEntries } from '#store/state.js';
import { listBuilds, listTrains } from '#testflight.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { compareVersions } from '#util/version.js';
import { listAppVersions } from '#versions.js';

function workspaceArtifacts(): ArtifactRecord[] {
  const artifacts: ArtifactRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = listArtifacts({ limit: 200, cursor });
    artifacts.push(...page.artifacts);
    if (!page.nextCursor) break;
    if (page.nextCursor === cursor) throw new Error('artifact pagination did not advance');
    cursor = page.nextCursor;
  }
  return artifacts;
}

function coverageForWorkspace() {
  const artifacts = workspaceArtifacts();
  const jobs = getAllJobHistory();
  const bundleIds = [...new Set([...artifacts.map((artifact) => artifact.bundleId), ...jobs.map((job) => job.bundleId)])];
  const catalog = new Map(getAppCatalogEntries(bundleIds).map((entry) => [entry.bundleId, entry]));
  const testFlightCache = getTestFlightCatalogCache();
  const testFlight = new Map(testFlightCache?.apps.map((app) => [app.bundleId, app]) ?? []);
  return bundleIds.map((bundleId) => {
    const metadata = catalog.get(bundleId);
    const appArtifacts = artifacts.filter((artifact) => artifact.bundleId === bundleId);
    const recentJob = jobs.filter((job) => job.bundleId === bundleId).sort((left, right) => (right.finishedAt ?? right.createdAt) - (left.finishedAt ?? left.createdAt))[0];
    const appStoreArtifact = appArtifacts.find((artifact) => artifact.channel === 'appstore' && (metadata?.latestAppStoreExternalId ? artifact.externalVersionId === metadata.latestAppStoreExternalId : artifact.versionLabel === metadata?.latestAppStoreVersion));
    const testFlightArtifact = appArtifacts.find((artifact) => artifact.channel === 'testflight' && (metadata?.latestTestFlightBuildId ? artifact.testflightBuildId === metadata.latestTestFlightBuildId : artifact.versionLabel === metadata?.latestTestFlightVersion));
    const testFlightApp = testFlight.get(bundleId);
    return {
      bundleId,
      name: metadata?.displayName ?? bundleId,
      iconUrl: metadata?.iconUrl,
      recentJob: recentJob ? { id: recentJob.id, status: recentJob.status, at: recentJob.finishedAt ?? recentJob.createdAt } : undefined,
      appStore: { latestVersion: metadata?.latestAppStoreVersion, checkedAt: metadata?.appStoreReleaseCheckedAt, artifactId: appStoreArtifact?.id },
      testFlight: testFlightApp ? { latestVersion: metadata?.latestTestFlightVersion, buildId: metadata?.latestTestFlightBuildId, checkedAt: metadata?.testFlightReleaseCheckedAt, verifiedAt: testFlightApp.lastVerifiedAt, artifactId: testFlightArtifact?.id, stale: !testFlightCache || Date.now() - testFlightCache.fetchedAt > 24 * 60 * 60 * 1000 } : undefined,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export const dashboardCoverageRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation));

  server.get('/v1/dashboard/release-coverage', {
    schema: { hide: true },
  }, () => {
    return { items: coverageForWorkspace() };
  });

  server.post('/v1/dashboard/release-coverage/:bundleId/refresh', {
    schema: { hide: true, params: Type.Object({ bundleId: Type.String({ minLength: 3, maxLength: 200 }) }) },
  }, async (request, reply) => {
    const { bundleId } = request.params;
    if (!coverageForWorkspace().some((item) => item.bundleId === bundleId)) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'app not found'));
    const catalog = getAppCatalogEntries([bundleId])[0];
    const testFlightApp = getTestFlightCatalogCache()?.apps.find((app) => app.bundleId === bundleId);
    const updates: { bundleId: string; displayName: string; latestAppStoreVersion?: string; latestAppStoreExternalId?: string; appStoreReleaseCheckedAt?: number; latestTestFlightVersion?: string; latestTestFlightBuildId?: number; testFlightReleaseCheckedAt?: number } = { bundleId, displayName: catalog?.displayName ?? testFlightApp?.displayName ?? bundleId };
    const failures: string[] = [];
    const [storeResult, testFlightResult] = await Promise.allSettled([
      listAppVersions(bundleId, true),
      testFlightApp ? (async () => {
        const device = getEffectiveDevices().find((candidate) => candidate.enabled && testFlightApp.devices.some((entry) => entry.id === candidate.id && entry.verifiedAt && Date.now() - entry.verifiedAt < 24 * 60 * 60 * 1000));
        if (!device) throw new Error('no verified device is currently enabled');
        const trains = await listTrains(testFlightApp.appId, device);
        const latestTrain = [...trains].sort((left, right) => compareVersions(right.trainVersion, left.trainVersion))[0];
        if (!latestTrain) throw new Error('no TestFlight train is available');
        const builds = await listBuilds(testFlightApp.appId, latestTrain.trainVersion, device);
        return [...builds].sort((left, right) => right.id - left.id)[0];
      })() : Promise.resolve(undefined),
    ]);
    if (storeResult.status === 'fulfilled') {
      const latest = storeResult.value.find((version) => version.isLatest);
      updates.latestAppStoreVersion = latest?.displayVersion;
      updates.latestAppStoreExternalId = latest?.externalVersionId;
      updates.appStoreReleaseCheckedAt = Date.now();
    } else failures.push('App Store lookup failed');
    if (testFlightResult.status === 'fulfilled' && testFlightResult.value) {
      updates.latestTestFlightVersion = testFlightResult.value.cfBundleShortVersion;
      updates.latestTestFlightBuildId = testFlightResult.value.id;
      updates.testFlightReleaseCheckedAt = Date.now();
    } else if (testFlightResult.status === 'rejected') failures.push('TestFlight lookup failed');
    upsertAppCatalogEntries([updates]);
    return { item: coverageForWorkspace().find((item) => item.bundleId === bundleId), failures };
  });
};
