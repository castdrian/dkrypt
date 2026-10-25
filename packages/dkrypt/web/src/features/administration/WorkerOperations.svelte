<script lang="ts">
  import { onMount } from 'svelte';
  import { CircleAlert, Gauge, PauseCircle, PlayCircle, RefreshCw, ServerCog } from 'lucide-svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { fetchWorkerFleetStatus, setWorkerDraining, type WorkerFleetStatus, type WorkerInstanceStatus } from '#lib/api';
  import { fmtDurationApprox, fmtTime } from '#lib/format.svelte';

  let status = $state<WorkerFleetStatus | null>(null);
  let loading = $state(false);
  let error = $state('');
  let busyWorkerId = $state('');
  const workerStatePresentation = {
    active: { variant: 'success', label: 'Ready' },
    draining: { variant: 'warning', label: 'Finishing current jobs' },
    offline: { variant: 'destructive', label: 'Offline' },
    drained: { variant: 'secondary', label: 'Drained' },
  } satisfies Record<WorkerInstanceStatus['state'], { variant: 'success' | 'warning' | 'destructive' | 'secondary'; label: string }>;

  const capacityPercent = $derived(status && status.capacity.maxParallelJobs > 0
    ? Math.min(100, Math.round(status.capacity.activeLeases / status.capacity.maxParallelJobs * 100))
    : 0);

  function workerStateVariant(state: WorkerInstanceStatus['state']): 'success' | 'warning' | 'destructive' | 'secondary' {
    return workerStatePresentation[state].variant;
  }

  function workerStateLabel(state: WorkerInstanceStatus['state']): string {
    return workerStatePresentation[state].label;
  }

  async function refresh(): Promise<void> {
    loading = true;
    error = '';
    try {
      status = await fetchWorkerFleetStatus();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Worker status could not be loaded.';
    } finally {
      loading = false;
    }
  }

  async function setDraining(worker: WorkerInstanceStatus, draining: boolean): Promise<void> {
    busyWorkerId = worker.workerId;
    error = '';
    try {
      const result = await setWorkerDraining(worker.workerId, draining);
      if (status) status = { ...status, workers: result.workers };
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Worker state could not be updated.';
    } finally {
      busyWorkerId = '';
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  });
</script>

<Card class="mt-4 overflow-hidden">
  <div class="flex items-start justify-between gap-3">
    <div class="flex min-w-0 items-start gap-3">
      <div class="mt-0.5 rounded-md bg-muted/40 p-2 text-muted"><ServerCog class="h-4 w-4" /></div>
      <div class="min-w-0">
        <h2 class="text-sm font-semibold">Worker instances</h2>
        <p class="mt-1 text-xs text-muted">Track job runners, compare their runtime settings, and safely drain one before restarting it.</p>
      </div>
    </div>
    <Button size="sm" variant="secondary" loading={loading} onclick={() => void refresh()} aria-label="Refresh worker status"><RefreshCw class="h-3.5 w-3.5" />Refresh</Button>
  </div>

  {#if error}<div class="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-err" role="alert">{error}</div>{/if}
  {#if !status && !error}<div class="mt-4 text-sm text-muted" role="status">Loading worker status…</div>{/if}
  {#if status}
    <div class="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <div class="rounded-lg border border-border/70 bg-muted/20 p-3"><div class="flex items-center gap-2 text-xs text-muted"><Gauge class="h-3.5 w-3.5" />Estimated parallel capacity</div><div class="mt-1 text-lg font-semibold">{status.capacity.activeLeases} / {status.capacity.maxParallelJobs}</div><div class="mt-1 text-[11px] text-muted">{status.capacity.availableSlots} available · {status.capacity.enabledDeviceSlots} device + {status.capacity.offlineSlots} server-side slots</div></div>
      <div class="rounded-lg border border-border/70 bg-muted/20 p-3"><div class="text-xs text-muted">Queue</div><div class="mt-1 text-lg font-semibold">{status.capacity.queuedJobs} queued</div><div class="mt-1 text-[11px] text-muted">{status.capacity.runningJobs} running jobs</div></div>
      <div class="rounded-lg border border-border/70 bg-muted/20 p-3"><div class="text-xs text-muted">Worker fleet</div><div class="mt-1 text-lg font-semibold">{status.workers.filter((worker) => worker.state === 'active').length} active</div><div class="mt-1 text-[11px] text-muted">{status.workers.length} known instance{status.workers.length === 1 ? '' : 's'}</div></div>
      <div class="rounded-lg border border-border/70 bg-muted/20 p-3"><div class="text-xs text-muted">Runtime configuration</div><div class="mt-1 flex items-center gap-2 text-sm font-semibold"><Badge variant={status.configurationConsistent ? 'success' : 'warning'}>{status.configurationConsistent ? 'Consistent' : 'Mismatch'}</Badge></div><div class="mt-1 text-[11px] text-muted">Compared across live workers</div></div>
    </div>
    <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-panel-muted" role="progressbar" aria-label="Worker capacity in use" aria-valuemin="0" aria-valuemax="100" aria-valuenow={capacityPercent}><div class="h-full rounded-full bg-accent transition-[width]" style={`width:${capacityPercent}%`}></div></div>
    {#if !status.configurationConsistent}
      <div class="mt-3 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 p-3 text-xs text-warn"><CircleAlert class="mt-0.5 h-4 w-4 shrink-0" /><span>Live workers disagree on runtime version or job limits. Align their configuration before relying on shared capacity estimates.</span></div>
    {/if}
    <ul class="mt-4 divide-y divide-border/70" aria-label="Worker instances">
      {#each status.workers as worker (worker.workerId)}
        <li class="grid min-w-0 gap-3 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2"><span class="font-mono text-xs" title={worker.workerId}>{worker.workerId === status.currentWorkerId ? 'This instance' : worker.workerId.slice(0, 12)}</span><Badge variant={workerStateVariant(worker.state)}>{workerStateLabel(worker.state)}</Badge><span class="text-[11px] text-muted">Heartbeat {fmtTime(worker.heartbeatAt)}</span></div>
            <div class="mt-1 text-[11px] text-muted">Runtime {worker.configuration.runtimeVersion} · {worker.activeLeases} active lease{worker.activeLeases === 1 ? '' : 's'} · Offline capacity {worker.configuration.offlineConcurrency}</div>
            <div class="mt-1 text-[11px] text-muted">Wait limit {fmtDurationApprox(worker.configuration.maxJobWaitSeconds * 1000)} · Retry limit {worker.configuration.maxRetries} · SQLite wait {worker.configuration.databaseBusyTimeoutMs} ms</div>
            {#if worker.resources.length}<div class="mt-1 break-all font-mono text-[10px] text-muted">{worker.resources.join(' · ')}</div>{/if}
          </div>
          {#if worker.state === 'active' || worker.state === 'draining' || worker.state === 'drained'}
            <Button size="sm" variant={worker.state === 'active' ? 'secondary' : 'default'} loading={busyWorkerId === worker.workerId} onclick={() => void setDraining(worker, worker.state === 'active')}>
              {#if worker.state === 'active'}<PauseCircle class="h-3.5 w-3.5" />Drain{:else}<PlayCircle class="h-3.5 w-3.5" />Resume{/if}
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="mt-3 text-[11px] text-muted">Draining stops new assignments and lets current jobs finish. A worker marked offline has missed heartbeats and cannot be drained remotely.</p>
  {/if}
</Card>
