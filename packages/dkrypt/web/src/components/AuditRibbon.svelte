<script lang="ts">
  import { fetchAuditLogByTarget, type AuditLogEntry } from '#lib/api';
  import { fmtDateTime } from '#lib/format.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasAnyPermission } from '#lib/session.svelte';

  let { target }: { target: string } = $props();
  let entries = $state<AuditLogEntry[]>([]);
  let loading = $state(false);
  let error = $state('');
  const allowed = $derived(sessionHasAnyPermission([PermissionFlag.viewUsers, PermissionFlag.manageUsers]));

  async function onToggle(event: Event): Promise<void> {
    if (!(event.currentTarget as HTMLDetailsElement).open || !allowed) return;
    loading = true;
    error = '';
    try {
      entries = (await fetchAuditLogByTarget(target)).entries;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load changes';
    } finally {
      loading = false;
    }
  }
</script>

{#if allowed}
  <details class="mt-2 border-t border-border/60 pt-2 text-xs" ontoggle={(event) => void onToggle(event)}>
    <summary class="w-fit cursor-pointer text-muted hover:text-foreground">Who changed this?</summary>
    {#if loading}<p class="mt-2 text-muted" role="status">Loading changes…</p>
    {:else if error}<p class="mt-2 text-err" role="alert">{error}</p>
    {:else if entries.length === 0}<p class="mt-2 text-muted">No recorded changes for this item.</p>
    {:else}
      <ol class="mt-2 space-y-2">
        {#each entries as entry (entry.id)}
          <li class="flex flex-wrap gap-x-2"><span class="font-medium" data-sensitive="true">{entry.actorDisplayName ?? entry.actor}</span><span>{entry.action.replaceAll('.', ' ')}</span><time class="text-muted" datetime={new Date(entry.ts).toISOString()}>{fmtDateTime(entry.ts)}</time>{#if entry.changes?.length}<span class="basis-full text-muted">{entry.changes.map((change) => `${change.field}: ${String(change.before)} → ${String(change.after)}`).join(' · ')}</span>{/if}</li>
        {/each}
      </ol>
    {/if}
  </details>
{/if}
