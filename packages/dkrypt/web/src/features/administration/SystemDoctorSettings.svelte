<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { CircleAlert, CircleCheck, CircleX, Download, RefreshCw, ServerCog } from 'lucide-svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { fetchCompatibilityMatrix, fetchDashboardBrowserCheck, fetchDashboardDoctor, runDashboardSyntheticProbes, supportBundleUrl, type CompatibilityMatrix, type DashboardDoctorReport, type DashboardSyntheticReport } from '#lib/api';
  import { fmtDateTime } from '#lib/format.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import AdvancedSection from '#components/AdvancedSection.svelte';
  import SignedTriggerSettings from '#features/administration/SignedTriggerSettings.svelte';
  import GithubOidcSettings from '#features/administration/GithubOidcSettings.svelte';
  import AppStoreOfflineSettings from '#features/administration/AppStoreOfflineSettings.svelte';
  import BridgeDiagnostics from '#features/devices/BridgeDiagnostics.svelte';
  import WorkerOperations from '#features/administration/WorkerOperations.svelte';
  import ConfigurationDriftReport from '#features/administration/ConfigurationDriftReport.svelte';

  const checkTitles: Record<string, string> = {
    'session-secret': 'Session signing secret',
    'session-secret-rotation': 'Session signing secret rotation',
    'backup-manifest-secret': 'Backup encryption secret',
    'backup-manifest-rotation': 'Backup encryption secret rotation',
    'admin-password': 'Administrator password',
    'admin-password-rotation': 'Administrator password rotation',
    'public-url': 'Public URL',
    'runtime-limits': 'Runtime limits',
    database: 'Database',
    state: 'State storage',
    artifacts: 'IPA storage',
    'backup-restore-drill': 'Backup restore drill',
    'device-bridge': 'Rust device bridge',
    'device-agent': 'Device agent',
    'device-bridge-rotation': 'Device bridge secret rotation',
    'stripe-secret-key-rotation': 'Stripe API key rotation',
    'stripe-webhook-rotation': 'Stripe webhook secret rotation',
    'crypto-api-key-rotation': 'NOWPayments API key rotation',
    'crypto-webhook-rotation': 'Crypto webhook secret rotation',
    'outbound-webhook-rotation': 'Outbound webhook secret rotation',
    'pairing-store': 'Device pairing store',
    otel: 'OpenTelemetry',
    stripe: 'Stripe billing',
    crypto: 'Crypto billing',
    testflight: 'TestFlight access',
    webhooks: 'Webhook delivery',
  };

  let report = $state<DashboardDoctorReport | null>(null);
  let probeReport = $state<DashboardSyntheticReport | null>(null);
  let compatibility = $state<CompatibilityMatrix | null>(null);
  let loading = $state(false);
  let probing = $state(false);
  let error = $state('');
  let probeError = $state('');
  let browserChecks = $state<Array<{ label: string; status: 'ok' | 'warn' | 'error' | 'manual'; detail: string }>>([]);
  let browserChecking = $state(false);
  let browserError = $state('');

  const warningCount = $derived(report?.checks.filter((check) => check.status === 'warn').length ?? 0);
  const errorCount = $derived(report?.checks.filter((check) => check.status === 'error').length ?? 0);
  const canDownloadSupportBundle = $derived(sessionHasPermission(PermissionFlag.manageAutomation));

  function checkTitle(id: string): string {
    return checkTitles[id] ?? id.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  }

  async function loadChecks(): Promise<void> {
    loading = true;
    error = '';
    try {
      report = await fetchDashboardDoctor();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not run the system doctor.';
    } finally {
      loading = false;
    }
  }

  async function runHealthChecks(): Promise<void> {
    probing = true;
    probeError = '';
    try {
      probeReport = await runDashboardSyntheticProbes();
    } catch (cause) {
      probeError = cause instanceof Error ? cause.message : 'Could not run service health checks.';
    } finally {
      probing = false;
    }
  }

  async function runBrowserChecks(): Promise<void> {
    browserChecking = true;
    browserError = '';
    try {
      const result = await fetchDashboardBrowserCheck();
      const browserOrigin = window.location.origin;
      const checks: typeof browserChecks = [
        { label: 'Browser origin', status: result.expectedOrigin === browserOrigin ? 'ok' : 'error', detail: result.expectedOrigin === browserOrigin ? 'PUBLIC_BASE_URL matches this browser.' : `This browser uses ${browserOrigin}; set PUBLIC_BASE_URL to this origin if it is the intended public address.` },
        { label: 'Session cookie', status: result.cookieSessionValid ? 'ok' : 'error', detail: result.cookieSessionValid ? 'This same-origin request was authenticated with the dashboard session.' : 'Sign in again and check cookie domain, Secure, and SameSite settings.' },
        { label: 'Proxy origin', status: result.expectedOrigin === result.observedOrigin ? 'ok' : 'warn', detail: result.expectedOrigin === result.observedOrigin ? 'dkrypt sees the expected public origin.' : `dkrypt sees ${result.observedOrigin}. Check trusted proxy Host and X-Forwarded-Proto forwarding.` },
      ];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch('/v1/dashboard/events', { headers: { Accept: 'text/event-stream' }, credentials: 'same-origin', signal: controller.signal });
        const ready = response.ok && response.headers.get('content-type')?.includes('text/event-stream');
        checks.push({ label: 'Live updates', status: ready ? 'ok' : 'error', detail: ready ? 'The browser can open the same-origin SSE stream.' : 'The event stream did not return text/event-stream; check proxy buffering and SSE routing.' });
        await response.body?.cancel().catch(() => undefined);
      } catch {
        checks.push({ label: 'Live updates', status: 'error', detail: 'The SSE stream did not open within four seconds. Check proxy buffering and connection timeouts.' });
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
      for (const [provider, callback] of Object.entries(result.oauthCallbacks)) {
        const providerName = provider === 'github' ? 'GitHub' : provider === 'discord' ? 'Discord' : 'Apple';
        checks.push({ label: `${providerName} OAuth callback`, status: callback === 'Not configured' ? 'warn' : 'manual', detail: callback === 'Not configured' ? 'OAuth is not configured for this provider.' : `Confirm the provider dashboard has this exact callback URL: ${callback}` });
      }
      browserChecks = checks;
    } catch (cause) {
      browserError = cause instanceof Error ? cause.message : 'Could not run browser checks.';
    } finally {
      browserChecking = false;
    }
  }

  onMount(() => {
    void loadChecks();
    if (sessionHasPermission(PermissionFlag.administrator)) void fetchCompatibilityMatrix().then((result) => compatibility = result);
  });

  $effect(() => {
    const deploymentId = report?.deployment?.id;
    const fragment = window.location.hash.slice(1);
    if (!deploymentId || fragment !== `deployment-${encodeURIComponent(deploymentId)}`) return;
    void tick().then(() => document.getElementById(fragment)?.scrollIntoView({ block: 'start' }));
  });
</script>

<Card class="overflow-hidden">
  <div class="flex items-start justify-between gap-3">
    <div class="flex min-w-0 items-start gap-3">
      <div class="mt-0.5 rounded-md bg-muted/40 p-2 text-muted"><ServerCog class="h-4 w-4" /></div>
      <div class="min-w-0">
        <h2 class="text-sm font-semibold">System doctor</h2>
        <p class="mt-1 text-xs text-muted">Check service configuration, storage, backups, devices, and credential rotation. Secret values are never shown.</p>
      </div>
    </div>
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      {#if canDownloadSupportBundle}
        <a href={supportBundleUrl()} download class={buttonVariants('secondary', 'sm')} aria-label="Download support bundle">
          <Download class="h-3.5 w-3.5" aria-hidden="true" /> Support bundle
        </a>
      {/if}
      <Button size="sm" variant="secondary" loading={loading} onclick={() => void loadChecks()} aria-label="Refresh checks">
        <RefreshCw class="h-3.5 w-3.5" /> Refresh
      </Button>
    </div>
  </div>

  {#if report?.deployment}
    <div id={`deployment-${encodeURIComponent(report.deployment.id)}`} class="mt-4 grid gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5 sm:grid-cols-2">
      <div class="min-w-0">
        <div class="text-[11px] text-muted">Running deployment</div>
        <div class="truncate font-mono text-xs" title={report.deployment.id}>{report.deployment.id}</div>
      </div>
      <div class="min-w-0">
        <div class="text-[11px] text-muted">Build</div>
        <div class="truncate font-mono text-xs" title={report.deployment.ref}>{report.deployment.ref}</div>
      </div>
    </div>
  {/if}

  {#if error}
    <div class="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-err" role="alert">{error}</div>
  {:else if !report}
    <div class="mt-4 text-sm text-muted" role="status">Checking service configuration…</div>
  {:else}
    <div class="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5" role="status" aria-live="polite">
      <div class="flex items-center gap-2">
        {#if errorCount > 0}
          <CircleX class="h-4 w-4 text-err" aria-hidden="true" />
          <span class="text-sm font-medium">Configuration needs attention</span>
        {:else if warningCount > 0}
          <CircleAlert class="h-4 w-4 text-warn" aria-hidden="true" />
          <span class="text-sm font-medium">Configuration ready with warnings</span>
        {:else}
          <CircleCheck class="h-4 w-4 text-ok" aria-hidden="true" />
          <span class="text-sm font-medium">All checks passed</span>
        {/if}
      </div>
      <span class="text-xs text-muted">Checked {fmtDateTime(report.checkedAt)}</span>
    </div>

    <ul class="mt-3 divide-y divide-border/70" aria-label="Configuration checks">
      {#each report.checks as check (check.id)}
        <li class="flex items-start justify-between gap-3 py-3">
          <div class="flex min-w-0 items-start gap-2.5">
            <span class="mt-0.5 shrink-0">
              {#if check.status === 'ok'}
                <CircleCheck class="h-4 w-4 text-ok" aria-hidden="true" />
              {:else if check.status === 'warn'}
                <CircleAlert class="h-4 w-4 text-warn" aria-hidden="true" />
              {:else}
                <CircleX class="h-4 w-4 text-err" aria-hidden="true" />
              {/if}
            </span>
            <div class="min-w-0">
              <h3 class="text-sm font-medium">{checkTitle(check.id)}</h3>
              <p class="mt-0.5 break-words text-xs text-muted">{check.detail}</p>
            </div>
          </div>
          <Badge variant="outline" class="text-foreground">{check.status === 'ok' ? 'Ready' : check.status === 'warn' ? 'Review' : 'Action needed'}</Badge>
        </li>
      {/each}
    </ul>
  {/if}

  {#if compatibility}
    <section class="mt-5 border-t border-border/70 pt-4" aria-label="Supported compatibility">
      <h3 class="text-sm font-semibold">Compatibility matrix</h3>
      <p class="mt-1 text-xs text-muted">Versions are checked against dkrypt’s supported deployment policy.</p>
      <div class="mt-3 divide-y divide-border/70">
        {#each compatibility.rows as row (row.component)}
          <div class="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
            <div><span class="font-medium">{row.component}</span><span class="ml-2 text-muted">{row.observed} · supports {row.supported}</span></div>
            <Badge variant={row.state === 'unsupported' ? 'destructive' : row.state === 'unknown' ? 'warning' : 'outline'}>{row.state}</Badge>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if sessionHasPermission(PermissionFlag.administrator)}<BridgeDiagnostics />{/if}
  {#if sessionHasPermission(PermissionFlag.administrator)}<SignedTriggerSettings />{/if}
  {#if sessionHasPermission(PermissionFlag.administrator)}<GithubOidcSettings />{/if}
  {#if sessionHasPermission(PermissionFlag.administrator)}<AppStoreOfflineSettings />{/if}

  <AdvancedSection label="settings.serviceHealthChecks">
  <section class="mt-5 border-t border-border/70 pt-4" aria-labelledby="system-probes-heading">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 id="system-probes-heading" class="text-sm font-semibold">Service health checks</h3>
        <p class="mt-1 text-xs text-muted">Check storage, devices, and webhooks on demand. TestFlight uses its last device verification and is never opened or refreshed.</p>
      </div>
      <Button size="sm" variant="secondary" loading={probing} onclick={() => void runHealthChecks()} aria-label="Run health checks">Run health checks</Button>
    </div>

    {#if probeError}
      <div class="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-err" role="alert">{probeError}</div>
    {:else if !probeReport}
      <p class="mt-3 text-xs text-muted" role="status">Health checks only run when you request them.</p>
    {:else}
      <p class="mt-3 text-xs text-muted">Checked {fmtDateTime(probeReport.checkedAt)}</p>
      <ul class="mt-1 divide-y divide-border/70" aria-label="Live service probe results">
        {#each probeReport.probes as probe (probe.id)}
          <li class="flex items-start justify-between gap-3 py-3">
            <div class="min-w-0">
              <h4 class="text-sm font-medium">{checkTitle(probe.id)}</h4>
              <p class="mt-0.5 break-words text-xs text-muted">{probe.detail}</p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <span class="text-[11px] text-muted">{Math.round(probe.durationMs)} ms</span>
              <Badge variant="outline" class="text-foreground">{probe.status === 'ok' ? 'Ready' : probe.status === 'warn' ? 'Review' : probe.status === 'error' ? 'Action needed' : 'Skipped'}</Badge>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
  <section class="mt-5 border-t border-border/70 pt-4" aria-label="Self-hosting browser check">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div><h3 class="text-sm font-semibold">Self-hosting browser check</h3><p class="mt-1 text-xs text-muted">Check this browser's origin, authenticated cookie, proxy origin, live updates, and expected OAuth callback URLs.</p></div>
      <Button size="sm" variant="secondary" loading={browserChecking} onclick={() => void runBrowserChecks()}>Run browser checks</Button>
    </div>
    {#if browserError}<p class="mt-3 text-xs text-err" role="alert">{browserError}</p>
    {:else if browserChecks.length === 0}<p class="mt-3 text-xs text-muted">Checks run only when requested. OAuth provider registration requires manual confirmation.</p>
    {:else}
      <ul class="mt-3 divide-y divide-border/70">
        {#each browserChecks as check (check.label)}
          <li class="flex flex-wrap items-start justify-between gap-2 py-2 text-xs"><div class="min-w-0 flex-1"><div class="font-medium">{check.label}</div><p class="mt-0.5 break-words text-muted">{check.detail}</p></div><Badge variant={check.status === 'error' ? 'destructive' : check.status === 'warn' ? 'warning' : 'outline'}>{check.status === 'manual' ? 'Confirm' : check.status === 'ok' ? 'Passed' : 'Review'}</Badge></li>
        {/each}
      </ul>
    {/if}
  </section>
  {#if report}<section class="mt-5 border-t border-border/70 pt-4"><ConfigurationDriftReport runtimeConfiguration={report.runtimeConfiguration} /></section>{/if}
  </AdvancedSection>
</Card>
<WorkerOperations />
