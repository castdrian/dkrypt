<script lang="ts">
  import Card from '#lib/components/ui/Card.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { apiAction, apiJson } from '#lib/api';
  import { confirmDialog, showToast } from '#lib/ui.svelte';

  interface ConnectedAgent {
    clientId: string;
    clientName: string;
    scopes: string[];
    connectedAt: number;
    lastUsedAt?: number;
    expiresAt: number;
    active: boolean;
    autopilot: {
      enabled: boolean;
      bundleIds: string[];
      channels: Array<'appstore' | 'testflight'>;
      maximumPer24Hours: number;
    };
  }

  interface AutopilotDraft {
    enabled: boolean;
    bundleIds: string;
    appStore: boolean;
    testFlight: boolean;
    maximumPer24Hours: number;
  }

  let agents = $state<ConnectedAgent[]>([]);
  let loading = $state(true);
  let revoking = $state('');
  let savingPolicy = $state('');
  let drafts = $state<Record<string, AutopilotDraft>>({});

  function formatTime(value: number): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  async function load(): Promise<void> {
    loading = true;
    try {
      agents = (await apiJson<{ agents: ConnectedAgent[] }>('/v1/dashboard/mcp/clients')).agents;
      drafts = Object.fromEntries(agents.map((agent) => [agent.clientId, {
        enabled: agent.autopilot.enabled,
        bundleIds: agent.autopilot.bundleIds.join('\n'),
        appStore: agent.autopilot.channels.includes('appstore'),
        testFlight: agent.autopilot.channels.includes('testflight'),
        maximumPer24Hours: agent.autopilot.maximumPer24Hours,
      }]));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load connected agents', 'error');
    } finally {
      loading = false;
    }
  }

  async function saveAutopilot(agent: ConnectedAgent): Promise<void> {
    const draft = drafts[agent.clientId];
    if (!draft || savingPolicy) return;
    savingPolicy = agent.clientId;
    try {
      const result = await apiAction<{ ok: boolean; autopilot: ConnectedAgent['autopilot'] }>('/v1/dashboard/mcp/clients/autopilot', {
        method: 'POST',
        body: JSON.stringify({
          clientId: agent.clientId,
          enabled: draft.enabled,
          bundleIds: draft.bundleIds.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
          channels: [draft.appStore ? 'appstore' : '', draft.testFlight ? 'testflight' : ''].filter(Boolean),
          maximumPer24Hours: draft.maximumPer24Hours,
        }),
      });
      if (!result.ok) throw new Error('Could not save the autopilot policy');
      await load();
      showToast(draft.enabled ? 'MCP autopilot is enabled for this agent' : 'MCP autopilot is disabled', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save the autopilot policy', 'error');
    } finally {
      savingPolicy = '';
    }
  }

  async function revoke(agent: ConnectedAgent): Promise<void> {
    if (!(await confirmDialog(`Disconnect ${agent.clientName}? It will no longer be able to access your dkrypt account.`, { confirmLabel: 'Disconnect agent' }))) return;
    revoking = agent.clientId;
    try {
      const result = await apiAction<{ ok?: boolean }>('/v1/dashboard/mcp/clients/revoke', {
        method: 'POST',
        body: JSON.stringify({ clientId: agent.clientId }),
      });
      if (!result.ok) throw new Error('Could not disconnect this agent');
      await load();
      showToast(`${agent.clientName} disconnected`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not disconnect this agent', 'error');
    } finally {
      revoking = '';
    }
  }

  $effect(() => { void load(); });
</script>

<Card title="Connected agents">
  <p class="mb-3 text-xs text-muted">Review agent connections made with your dkrypt account. Disconnecting an agent revokes its access and refresh tokens.</p>
  {#if loading}
    <div class="py-5 text-sm text-muted" role="status">Loading connected agents…</div>
  {:else if agents.length === 0}
    <div class="rounded-lg border border-border/70 bg-panel-muted/20 px-3 py-4 text-sm text-muted">No agents are connected to your account.</div>
  {:else}
    <ul class="divide-y divide-border/70">
      {#each agents as agent (agent.clientId)}
        <li class="flex flex-wrap items-start justify-between gap-3 py-3">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2 text-sm font-medium">
              <span>{agent.clientName}</span>
              <span class={`rounded-full px-2 py-0.5 text-[11px] ${agent.active ? 'bg-ok/10 text-ok' : 'bg-panel-muted text-muted'}`}>{agent.active ? 'Connected' : 'Disconnected'}</span>
            </div>
            <div class="mt-1 text-xs text-muted">Connected {formatTime(agent.connectedAt)}{agent.lastUsedAt ? ` · Last used ${formatTime(agent.lastUsedAt)}` : ''}</div>
            <div class="mt-1 break-words text-xs text-muted">Access: {agent.scopes.join(', ')}</div>
            <details class="mt-3 rounded-lg border border-border/70 p-3">
              <summary class="cursor-pointer text-xs font-medium">MCP autopilot</summary>
              {#if drafts[agent.clientId]}
                {@const draft = drafts[agent.clientId]!}
                <p class="mt-2 text-xs text-muted">Allow this connected agent to queue decrypts without per-job approval, limited to exact bundle IDs and channels you choose.</p>
                <label class="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={draft.enabled} /> Enable autopilot for this agent</label>
                <label class="mt-3 block text-xs font-medium" for={`mcp-autopilot-bundles-${agent.clientId}`}>Allowed bundle IDs</label>
                <textarea id={`mcp-autopilot-bundles-${agent.clientId}`} class="mt-1 min-h-20 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs" bind:value={draft.bundleIds} placeholder="com.example.app, one per line"></textarea>
                <div class="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs">
                  <label class="flex items-center gap-2"><input type="checkbox" bind:checked={draft.appStore} /> App Store</label>
                  <label class="flex items-center gap-2"><input type="checkbox" bind:checked={draft.testFlight} /> TestFlight</label>
                </div>
                <label class="mt-3 flex flex-wrap items-center gap-2 text-xs" for={`mcp-autopilot-limit-${agent.clientId}`}>Maximum per rolling 24 hours
                  <input id={`mcp-autopilot-limit-${agent.clientId}`} class="h-8 w-20 rounded-md border border-border bg-background px-2" type="number" min="1" max="100" bind:value={draft.maximumPer24Hours} />
                </label>
                <Button class="mt-3" size="sm" variant="secondary" loading={savingPolicy === agent.clientId} disabled={!agent.active || savingPolicy !== ''} onclick={() => void saveAutopilot(agent)}>Save autopilot policy</Button>
                {#if !agent.active}<p class="mt-2 text-[11px] text-muted">Reconnect this agent before changing its policy.</p>{/if}
              {/if}
            </details>
          </div>
          {#if agent.active}
            <Button size="sm" variant="secondary" loading={revoking === agent.clientId} disabled={revoking !== ''} onclick={() => void revoke(agent)}>Disconnect</Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Card>
