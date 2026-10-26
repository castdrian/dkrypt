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
  }

  let agents = $state<ConnectedAgent[]>([]);
  let loading = $state(true);
  let revoking = $state('');

  function formatTime(value: number): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  async function load(): Promise<void> {
    loading = true;
    try {
      agents = (await apiJson<{ agents: ConnectedAgent[] }>('/v1/dashboard/mcp/clients')).agents;
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load connected agents', 'error');
    } finally {
      loading = false;
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
          </div>
          {#if agent.active}
            <Button size="sm" variant="secondary" loading={revoking === agent.clientId} disabled={revoking !== ''} onclick={() => void revoke(agent)}>Disconnect</Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Card>
