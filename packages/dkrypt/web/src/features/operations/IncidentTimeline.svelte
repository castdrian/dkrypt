<script lang="ts">
  import { Activity, RefreshCw } from 'lucide-svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { fetchActionCenter, fetchDashboardIncidents, fetchIncidentStateAtTime, updateActionCenterIncident, type DashboardIncidentEvent, type IncidentStateAtTime, type OperationalIncident } from '#lib/api';
  import { fmtDateTime, fmtTime } from '#lib/format.svelte';
  import { deviceDetailJumpState, jobDetailJumpState, logSearchJumpState, setActiveTab, setSettingsSubtab } from '#lib/ui.svelte';
  import { promptDialog, showToast } from '#lib/ui.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';

  let events = $state<DashboardIncidentEvent[]>([]);
  let loading = $state(false);
  let loaded = $state(false);
  let truncated = $state(false);
  let incidents = $state<OperationalIncident[]>([]);
  let scrubOpen = $state(false);
  let scrubMaxAt = $state(Date.now());
  let scrubAt = $state(Date.now());
  let scrubState = $state<IncidentStateAtTime | null>(null);
  let scrubLoading = $state(false);
  let scrubRequest = 0;
  const scrubMinAt = $derived(scrubMaxAt - 90 * 24 * 60 * 60 * 1000);
  const canViewIncidents = $derived(sessionHasPermission(PermissionFlag.viewIncidents) || sessionHasPermission(PermissionFlag.manageIncidents));
  const canManageIncidents = $derived(sessionHasPermission(PermissionFlag.manageIncidents));

  async function load(): Promise<void> {
    loading = true;
    try {
      const result = await fetchDashboardIncidents();
      events = result.events;
      truncated = result.truncated;
      loaded = true;
      if (canViewIncidents) incidents = (await fetchActionCenter()).incidents;
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load the incident timeline', 'error');
    } finally {
      loading = false;
    }
  }

  async function loadStateAtTime(at: number): Promise<void> {
    const token = ++scrubRequest;
    scrubLoading = true;
    try {
      const result = await fetchIncidentStateAtTime(at);
      if (token === scrubRequest) scrubState = result;
    } catch (error) {
      if (token === scrubRequest) showToast(error instanceof Error ? error.message : 'Could not inspect recorded incident state', 'error');
    } finally {
      if (token === scrubRequest) scrubLoading = false;
    }
  }

  function toggleScrubber(): void {
    scrubOpen = !scrubOpen;
    if (!scrubOpen) return;
    scrubMaxAt = Date.now();
    scrubAt = scrubMaxAt;
    void loadStateAtTime(scrubAt);
  }

  $effect(() => { void load(); });

  function openEvent(event: DashboardIncidentEvent): void {
    if (event.kind === 'job' && event.jobId) {
      jobDetailJumpState.id = event.jobId;
      setActiveTab('home');
      return;
    }
    if (event.kind === 'device' && event.deviceId) {
      deviceDetailJumpState.id = event.deviceId;
      setActiveTab('settings');
      setSettingsSubtab('devices');
      return;
    }
    if (event.deploymentId) {
      logSearchJumpState.value = { query: event.deploymentId, scope: 'deploy' };
      setActiveTab('logs');
    }
  }

  async function changeIncident(incident: OperationalIncident, status: OperationalIncident['status']): Promise<void> {
    const resolutionNote = status === 'resolved' ? await promptDialog('Resolution note', { confirmLabel: 'Resolve incident' }) : undefined;
    if (status === 'resolved' && !resolutionNote?.trim()) return;
    const snoozedUntil = status === 'snoozed' ? Date.now() + 60 * 60 * 1000 : undefined;
    try {
      const result = await updateActionCenterIncident(incident.id, { status, resolutionNote: resolutionNote ?? undefined, snoozedUntil });
      incidents = incidents.map((entry) => entry.id === incident.id ? result.incident : entry);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not update incident', 'error');
    }
  }

  async function assignIncident(incident: OperationalIncident): Promise<void> {
    const assignedTo = await promptDialog('Assign to account name, or leave blank to unassign', { value: incident.assignedTo ?? '', confirmLabel: 'Save assignment' });
    if (assignedTo === null) return;
    try {
      const result = await updateActionCenterIncident(incident.id, { assignedTo: assignedTo.trim() || null });
      incidents = incidents.map((entry) => entry.id === incident.id ? result.incident : entry);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not assign incident', 'error');
    }
  }
</script>

{#if canViewIncidents}
  <Card title="Action Center" class="mb-4">
    {#if incidents.length === 0}
      <p class="text-sm text-muted">No actionable incidents.</p>
    {:else}
      <ol class="divide-y divide-border/70">
        {#each incidents as incident (incident.id)}
          <li class="py-3 first:pt-0 last:pb-0">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="min-w-0"><span class="text-sm font-medium">{incident.title}</span><span class="ml-2 text-xs text-muted">{incident.kind} · {incident.status}{incident.recoveredAt ? ' · source recovered' : ''}</span></div>
              {#if canManageIncidents}
                <div class="flex flex-wrap gap-1">
                  <Button size="sm" variant="secondary" onclick={() => void assignIncident(incident)}>{incident.assignedToDisplayName ?? incident.assignedTo ?? 'Assign'}</Button>
                  {#if incident.status !== 'in_progress'}<Button size="sm" variant="secondary" onclick={() => void changeIncident(incident, 'in_progress')}>In progress</Button>{/if}
                  {#if incident.status !== 'snoozed'}<Button size="sm" variant="secondary" onclick={() => void changeIncident(incident, 'snoozed')}>Snooze 1h</Button>{/if}
                  {#if incident.status !== 'resolved'}<Button size="sm" variant="secondary" onclick={() => void changeIncident(incident, 'resolved')}>Resolve</Button>{/if}
                </div>
              {/if}
            </div>
            <p class="mt-1 text-xs text-muted">{incident.detail}</p>
            {#if incident.resolutionNote}<p class="mt-1 text-xs">Resolved: {incident.resolutionNote}</p>{/if}
          </li>
        {/each}
      </ol>
    {/if}
  </Card>
{/if}

<Card title="Incident timeline">
  {#snippet headerExtra()}
    <div class="flex items-center gap-2">
      {#if canViewIncidents}<Button variant="secondary" size="sm" aria-expanded={scrubOpen} onclick={toggleScrubber}>{scrubOpen ? 'Close time view' : 'Explore time'}</Button>{/if}
      <Button variant="ghost" size="icon" class="h-8 w-8" loading={loading} aria-label="Refresh incident timeline" onclick={() => void load()}><RefreshCw class="h-4 w-4" /></Button>
    </div>
  {/snippet}
  {#if scrubOpen && canViewIncidents}
    <section class="mb-4 rounded-lg border border-border/70 bg-muted/20 p-3" aria-label="Incident state at a time">
      <label for="incident-time-scrubber" class="text-xs font-medium">Recorded state at {fmtDateTime(scrubAt)}</label>
      <input id="incident-time-scrubber" type="range" class="mt-2 w-full accent-accent" min={scrubMinAt} max={scrubMaxAt} step="3600000" value={scrubAt} onchange={(event) => { scrubAt = event.currentTarget.valueAsNumber; void loadStateAtTime(scrubAt); }} />
      {#if scrubLoading}<p class="mt-2 text-xs text-muted" role="status">Checking recorded state…</p>
      {:else if scrubState?.coverage === 'incomplete'}<p class="mt-2 text-xs text-warn">History before {scrubState.coverageStartAt ? fmtDateTime(scrubState.coverageStartAt) : 'the first recorded incident'} is incomplete. No earlier state is assumed.</p>
      {:else if scrubState}
        <p class="mt-2 text-xs text-muted">{scrubState.incidents.length} recorded incident{scrubState.incidents.length === 1 ? '' : 's'} at this time.</p>
        <ul class="mt-2 space-y-1 text-xs">
          {#each scrubState.incidents as incident (incident.id)}
            <li class="flex flex-wrap justify-between gap-2"><span>{incident.title}</span><span class="text-muted">{incident.status.replaceAll('_', ' ')}{incident.recovered ? ' · source recovered' : ''}</span></li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
  {#if loading && !loaded}
    <div role="status" class="py-5 text-sm text-muted">Loading recent activity…</div>
  {:else if events.length === 0}
    <EmptyState icon={Activity} message="No recent incidents or activity." />
  {:else}
    <ol class="divide-y divide-border/70">
      {#each events as event (event.id)}
        <li class="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0">
          <time class="shrink-0 pt-0.5 font-mono text-[10px] text-muted" datetime={new Date(event.at).toISOString()}>{fmtTime(event.at)}</time>
          <Button variant="link" class="h-auto min-w-0 flex-1 justify-start whitespace-normal p-0 text-left" disabled={event.kind === 'watch' && !event.deploymentId} title={event.kind === 'watch' && !event.deploymentId ? 'This is a historical watch event; app watches are no longer available.' : undefined} onclick={() => openEvent(event)}>
            <span class="block min-w-0"><span class="block text-xs font-medium">{event.title}</span>{#if event.detail}<span class="mt-0.5 block break-words text-[11px] text-muted" data-sensitive="true">{event.detail}</span>{/if}</span>
          </Button>
          <span class="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[9px] uppercase text-muted">{event.kind}</span>
        </li>
      {/each}
    </ol>
    {#if truncated}<p class="mt-3 text-[11px] text-muted">Showing the latest 200 events.</p>{/if}
  {/if}
</Card>
