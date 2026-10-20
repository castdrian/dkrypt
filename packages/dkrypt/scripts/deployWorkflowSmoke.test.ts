import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { SCHEDULER_JOB_TIMEOUT_MS } from '../src/jobs/timeouts.js';

function deploymentSmokeScripts(): string[] {
  const workflow = readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  return [...workflow.matchAll(/^[ ]+docker exec -i[^\n]*bun - <<'JS'\r?\n([\s\S]*?)^[ ]+JS$/gm)]
    .map((match) => {
      const indentation = match[0].match(/^[ ]+/)?.[0] ?? '';
      return match[1].split(/\r?\n/).map((line) => line.startsWith(indentation) ? line.slice(indentation.length) : line).join('\n');
    });
}

function workflowLines(): string[] {
  return readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8').split(/\r?\n/);
}

function shutdownRecoveryWorkflow(): string {
  return readFileSync(new URL('../../../.github/workflows/shutdown-recovery-smoke.yml', import.meta.url), 'utf8');
}

function shutdownRecoveryScripts(): string[] {
  return [...shutdownRecoveryWorkflow().matchAll(/^[ ]+run_dkrypt_bun[^\n]*<<'JS'\r?\n([\s\S]*?)^[ ]+JS$/gm)]
    .map((match) => {
      const indentation = match[0].match(/^[ ]+/)?.[0] ?? '';
      return match[1].split(/\r?\n/).map((line) => line.startsWith(indentation) ? line.slice(indentation.length) : line).join('\n');
    });
}

function workflowJob(name: string): string[] {
  const lines = workflowLines();
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`missing workflow job ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^  [a-z][a-z0-9_-]*:$/.test(line));
  return lines.slice(start, end < 0 ? lines.length : end);
}

function permissionsFor(lines: string[], headingIndent: number): Record<string, string> {
  const heading = `${' '.repeat(headingIndent)}permissions:`;
  const headingIndex = lines.indexOf(heading);
  if (headingIndex < 0) return {};
  const rowPrefix = ' '.repeat(headingIndent + 2);
  const permissions: Record<string, string> = {};
  for (const line of lines.slice(headingIndex + 1)) {
    if (!line.startsWith(rowPrefix)) break;
    const match = line.match(/^\s+([a-z-]+): ([a-z]+)$/);
    if (match) permissions[match[1]] = match[2];
  }
  return permissions;
}

test('deployment smoke scripts are valid JavaScript before they reach the homelab', () => {
  const scripts = deploymentSmokeScripts();
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(script)).not.toThrow();
});

test('workflow grants supply-chain permissions only to the image publisher', () => {
  expect(permissionsFor(workflowLines(), 0)).toEqual({ contents: 'read' });
  expect(permissionsFor(workflowJob('ci'), 4)).toEqual({});
  expect(permissionsFor(workflowJob('image'), 4)).toEqual({
    contents: 'read',
    packages: 'write',
    'id-token': 'write',
    attestations: 'write',
    'artifact-metadata': 'write',
  });
  expect(permissionsFor(workflowJob('deploy'), 4)).toEqual({ packages: 'read' });
});

test('CI and image publishing use the Bun version pinned by the Dockerfile', () => {
  for (const name of ['ci', 'image']) {
    const job = workflowJob(name).join('\n');
    expect(job).toContain('id: bun_version');
    expect(job).toContain('bun-version: ${{ steps.bun_version.outputs.version }}');
    expect(job).toContain("packages/dkrypt/Dockerfile | sort -u");
  }
});

test('deployment smoke syntax validation detects duplicate declarations', () => {
  const invalidScript = 'const status = 1;\nconst status = 2;';
  expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(invalidScript)).toThrow('already been declared');
});

test('deployment smoke verifies API-key artifact access and its reusable health and login assertions', () => {
  const [script] = deploymentSmokeScripts();
  expect(script).toContain("`${base}/v1/artifacts?limit=1`");
  expect(script).toContain("import('/app/src/deploymentSmokeAssertions.ts')");
  expect(script).toContain("import('/app/src/store/sqlite.ts')");
  expect(script).toContain('assertDatabaseSchemaVersion(health.database?.schemaVersion, LATEST_SQLITE_SCHEMA_VERSION);');
  expect(script).toContain('assertAppStoreSubsystemWhenAgentReady(device?.subsystems?.agent, device?.subsystems?.appStore);');
  expect(script).toContain('inspectDeploymentSmokeLogin(login.status, loginBody.code);');
  expect(script).toContain('apiKeyArtifactListing: true');
  expect(script).not.toContain('authenticated dashboard probes skipped because root MFA is enabled');
});

test('deployment smoke always verifies authenticated dashboard and event-stream access when root MFA is enabled', () => {
  const [script] = deploymentSmokeScripts();
  expect(script).toContain("if (loginState.rootMfaChallenge) {");
  expect(script).toContain("import('/app/src/session.ts')");
  expect(script).toContain('setSessionCookie');
  expect(script).toContain('await verifyAuthenticatedRoutes(cookieHeaders);');
  expect(script).toContain('if (!authenticatedRoutes) throw new Error');
  expect(script).toContain("fetchWithTimeout(`${base}/v1/auth/logout`");
  expect(script).toContain('if (!logout.ok) throw new Error');
});

test('shutdown recovery shell stays inside its YAML run block', () => {
  const lines = shutdownRecoveryWorkflow().split(/\r?\n/);
  const runBlockStart = lines.indexOf('        run: |');
  expect(runBlockStart).toBeGreaterThan(-1);
  for (const line of lines.slice(runBlockStart + 1)) {
    if (line.trim().length === 0) continue;
    expect(line.startsWith('          ')).toBe(true);
  }
});

test('deployment USB agent readiness does not require a device SSH key', () => {
  const [script] = deploymentSmokeScripts();
  expect(script).toContain("const usbAgentDevice = { ...primaryDevice, keyPath: '/run/dkrypt/usb-agent-smoke-no-ssh-key' };");
  expect(script).toContain('withAutoinstallDeviceAgent(usbAgentDevice');
});

test('production shutdown recovery waits for an artifact-backed decrypt completion', () => {
  const workflow = shutdownRecoveryWorkflow();
  const recoverableCheck = workflow.indexOf('if [[ "$recovered" != 1 ]]');
  const completionCheck = workflow.indexOf('waitForSmokeDecryptCompletion', recoverableCheck);

  expect(recoverableCheck).toBeGreaterThanOrEqual(0);
  expect(completionCheck).toBeGreaterThan(recoverableCheck);
  expect(workflow).toContain('waitForSmokeDecryptCompletion');
  expect(workflow).toContain('sessionCookie: process.env.TEST_SESSION_COOKIE');
  expect(workflow).toContain('jobCompleted: true');
  expect(workflow).toContain('Production decrypt completed during shutdown; no job requeue was required');
  expect(workflow).toContain('Production decrypt was requeued after shutdown');
  expect(workflow).not.toContain('echo "Production decrypt survived shutdown in state $job_state; last event: $progress_label"');
});

test('production shutdown recovery has enough time to observe the maximum decrypt deadline', () => {
  const workflow = shutdownRecoveryWorkflow();
  const timeout = workflow.match(/^    timeout-minutes: (\d+)$/m);
  const timeoutMinutes = Number(timeout?.[1]);

  expect(Number.isFinite(timeoutMinutes)).toBeTrue();
  expect(timeoutMinutes).toBeGreaterThanOrEqual(Math.ceil(SCHEDULER_JOB_TIMEOUT_MS / 60_000) + 30);
});

test('production shutdown recovery scripts are valid JavaScript before they reach the homelab', () => {
  const scripts = shutdownRecoveryScripts();
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(script)).not.toThrow();
});
