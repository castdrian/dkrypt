<script lang="ts">
  import AuditRibbon from '#components/AuditRibbon.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { createSignedTriggerIntegration, fetchSignedTriggerIntegrations, revokeSignedTriggerIntegration, rotateSignedTriggerIntegration, type SignedTriggerIntegration } from '#lib/api';
  import IntegrationOwnershipControl from '#features/administration/IntegrationOwnershipControl.svelte';
  import { confirmDialog, showToast } from '#lib/ui.svelte';

  let integrations = $state<SignedTriggerIntegration[]>([]);
  let bundles = $state('');
  let appStore = $state(true);
  let testFlight = $state(false);
  let revealed = $state<{ id: string; secret: string } | null>(null);
  let busy = $state(false);

  async function load(): Promise<void> {
    try { integrations = (await fetchSignedTriggerIntegrations()).integrations; }
    catch { showToast('Could not load signed integrations', 'error'); }
  }

  $effect(() => { void load(); });

  async function create(): Promise<void> {
    const bundleIds = [...new Set(bundles.split(',').map((value) => value.trim()).filter(Boolean))];
    const sources: Array<'appstore' | 'testflight'> = [...(appStore ? ['appstore' as const] : []), ...(testFlight ? ['testflight' as const] : [])];
    if (!bundleIds.length || !sources.length) return;
    busy = true;
    try {
      const result = await createSignedTriggerIntegration({ bundleIds, sources });
      revealed = { id: result.integration.id, secret: result.secret };
      bundles = '';
      await load();
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not create integration', 'error'); }
    finally { busy = false; }
  }

  async function rotate(id: string): Promise<void> {
    busy = true;
    try {
      const result = await rotateSignedTriggerIntegration(id);
      revealed = { id, secret: result.secret };
      await load();
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not rotate integration', 'error'); }
    finally { busy = false; }
  }

  async function revoke(id: string): Promise<void> {
    if (!(await confirmDialog('Revoke this signed decrypt integration? Existing signatures will stop working.', { confirmLabel: 'Revoke integration' }))) return;
    busy = true;
    try { await revokeSignedTriggerIntegration(id); if (revealed?.id === id) revealed = null; await load(); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not revoke integration', 'error'); }
    finally { busy = false; }
  }
</script>

<Card title="Signed decrypt triggers" class="mt-4">
  <p class="mb-3 text-xs text-muted">Use an HMAC-signed request to start a decrypt. Each integration is limited to its listed apps and sources. The secret is shown only when created or rotated.</p>
  <label class="block text-xs text-muted" for="signed-trigger-bundles">Bundle IDs, separated by commas</label>
  <Input id="signed-trigger-bundles" bind:value={bundles} placeholder="com.example.app" />
  <div class="mt-2 flex gap-4 text-xs"><label><input type="checkbox" bind:checked={appStore} /> App Store</label><label><input type="checkbox" bind:checked={testFlight} /> TestFlight</label></div>
  <Button class="mt-3" size="sm" loading={busy} onclick={() => void create()}>Create integration</Button>
  {#if revealed}
    <div class="mt-3 rounded-lg border border-warn/50 p-3 text-xs"><div class="font-medium">Save this signing secret now for {revealed.id}</div><code class="mt-1 block break-all" data-sensitive="true">{revealed.secret}</code><Button size="sm" variant="ghost" onclick={() => revealed = null}>Hide</Button></div>
  {/if}
  <div class="mt-4 divide-y divide-border/70">
    {#each integrations as integration (integration.id)}
      <div class="py-2 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div><div class="font-medium">{integration.bundleIds.join(', ')}</div><div class="text-muted">{integration.id} · {integration.sources.join(' / ')} · {integration.enabled ? 'Active' : 'Revoked'}</div></div>
          {#if integration.enabled}<div class="flex gap-1"><Button size="sm" variant="secondary" disabled={busy} onclick={() => void rotate(integration.id)}>Rotate</Button><Button size="sm" variant="secondary" disabled={busy} onclick={() => void revoke(integration.id)}>Revoke</Button></div>{/if}
        </div>
        <IntegrationOwnershipControl integrationId={integration.id} ownerName={integration.billingOwnerDisplayName} transferName={integration.billingOwnerTransferDisplayName} onSaved={load} />
        <AuditRibbon target={integration.id} />
      </div>
    {/each}
  </div>
</Card>
