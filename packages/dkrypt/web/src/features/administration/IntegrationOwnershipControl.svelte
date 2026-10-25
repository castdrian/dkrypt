<script lang="ts">
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { fetchEligibleIntegrationOwners, requestIntegrationOwnership } from '#lib/api';
  import { sessionState } from '#lib/session.svelte';
  import { showToast } from '#lib/ui.svelte';

  interface Props {
    integrationId: string;
    ownerName?: string;
    transferName?: string;
    onSaved?: () => void | Promise<void>;
  }

  let { integrationId, ownerName, transferName, onSaved = () => undefined }: Props = $props();
  let open = $state(false);
  let users = $state<Array<{ id: string; name: string }>>([]);
  let targetId = $state('');
  let loading = $state(false);
  let saving = $state(false);

  async function show(): Promise<void> {
    open = true;
    loading = true;
    try {
      users = (await fetchEligibleIntegrationOwners(integrationId)).users;
      targetId = users.find((user) => user.id === sessionState.sub)?.id ?? '';
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load eligible members', 'error');
    } finally {
      loading = false;
    }
  }

  async function save(): Promise<void> {
    if (!targetId) return;
    saving = true;
    try {
      await requestIntegrationOwnership(integrationId, targetId);
      open = false;
      showToast(targetId === sessionState.sub ? 'Automation ownership assigned to you' : 'Ownership request sent; the recipient must accept', 'success');
      await onSaved();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not update automation owner', 'error');
    } finally {
      saving = false;
    }
  }
</script>

<div class="flex flex-wrap items-center gap-1.5 text-xs">
  <span class="text-muted">Quota owner: {ownerName ?? 'System-owned'}</span>
  {#if transferName}<span class="text-warn">Transfer awaiting {transferName}</span>{/if}
  <Button size="sm" variant="secondary" onclick={() => void show()}>Change owner</Button>
</div>

<Dialog {open} onOpenChange={(value) => (open = value)} class="max-w-md">
  <h2 class="text-sm font-semibold">Automation billing owner</h2>
  <p class="mt-1 text-xs text-muted">New decrypts use the owner’s plan and daily allowance. A transfer to someone else takes effect only after they accept it.</p>
  <div class="mt-3 rounded-md border border-border p-2.5 text-xs">Current owner: {ownerName ?? 'System-owned'}</div>
  <label for="integration-owner-target" class="mt-3 mb-1 block text-xs text-muted">Assign or request ownership</label>
  <select id="integration-owner-target" class="bg-background border-border w-full rounded-md border px-2.5 py-2 text-sm" bind:value={targetId} disabled={loading || saving}>
    <option value="">Select an eligible member</option>
    {#each users as user (user.id)}
      <option value={user.id}>{user.name}{user.id === sessionState.sub ? ' (you)' : ''}</option>
    {/each}
  </select>
  {#if loading}<p class="mt-2 text-xs text-muted">Loading eligible members…</p>{:else if users.length === 0}<p class="mt-2 text-xs text-muted">A recipient needs integration and decrypt access.</p>{/if}
  <div class="mt-4 flex justify-end gap-2">
    <Button variant="secondary" disabled={saving} onclick={() => (open = false)}>Cancel</Button>
    <Button loading={saving} disabled={loading || !targetId} onclick={() => void save()}>{targetId === sessionState.sub ? 'Assign to me' : 'Request transfer'}</Button>
  </div>
</Dialog>
