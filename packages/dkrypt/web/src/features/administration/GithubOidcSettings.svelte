<script lang="ts">
  import Card from '#lib/components/ui/Card.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { createGithubOidcTrust, fetchGithubOidcPolicies, revokeGithubOidcTrust, type GithubOidcTrustPolicy } from '#lib/api';
  import IntegrationOwnershipControl from '#features/administration/IntegrationOwnershipControl.svelte';
  import { confirmDialog, showToast } from '#lib/ui.svelte';

  let policies = $state<GithubOidcTrustPolicy[]>([]);
  let repositoryId = $state('');
  let workflowRef = $state('');
  let ref = $state('');
  let environment = $state('');
  let audience = $state('');
  let bundleIds = $state('');
  let allowTestFlight = $state(false);
  let busy = $state(false);

  async function load(): Promise<void> {
    try { policies = (await fetchGithubOidcPolicies()).policies; }
    catch { showToast('Could not load GitHub trust policies', 'error'); }
  }

  $effect(() => { void load(); });

  async function create(): Promise<void> {
    busy = true;
    try {
      await createGithubOidcTrust({ repositoryId: repositoryId.trim(), workflowRef: workflowRef.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}), ...(environment.trim() ? { environment: environment.trim() } : {}), audience: audience.trim(), bundleIds: [...new Set(bundleIds.split(',').map((value) => value.trim()).filter(Boolean))], allowTestFlight });
      repositoryId = '';
      workflowRef = '';
      ref = '';
      environment = '';
      audience = '';
      bundleIds = '';
      await load();
      showToast('GitHub trust policy created', 'success');
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not create trust policy', 'error'); }
    finally { busy = false; }
  }

  async function revoke(id: string): Promise<void> {
    if (!(await confirmDialog('Revoke this GitHub Actions trust policy?', { confirmLabel: 'Revoke policy' }))) return;
    busy = true;
    try { await revokeGithubOidcTrust(id); await load(); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not revoke trust policy', 'error'); }
    finally { busy = false; }
  }
</script>

<Card title="GitHub Actions OIDC" class="mt-4">
  <p class="mb-3 text-xs text-muted">Trust only an exact repository ID, workflow, ref or environment, and audience. Tokens can use the existing decrypt, job-status, and IPA routes only for the configured bundles. No dashboard access is granted.</p>
  <div class="grid gap-2 sm:grid-cols-2">
    <label class="text-xs">Repository ID<Input id="oidc-repository-id" bind:value={repositoryId} placeholder="123456789" /></label>
    <label class="text-xs">Workflow ref<Input id="oidc-workflow-ref" bind:value={workflowRef} placeholder="owner/repo/.github/workflows/decrypt.yml@refs/heads/main" /></label>
    <label class="text-xs">Git ref<Input id="oidc-ref" bind:value={ref} placeholder="refs/heads/main" /></label>
    <label class="text-xs">Environment, instead of ref<Input id="oidc-environment" bind:value={environment} placeholder="production" /></label>
    <label class="text-xs">Audience<Input id="oidc-audience" bind:value={audience} placeholder="https://ipa.example.com" /></label>
    <label class="text-xs">Allowed bundle IDs<Input id="oidc-bundles" bind:value={bundleIds} placeholder="com.example.app, com.example.other" /></label>
  </div>
  <label class="mt-2 block text-xs"><input type="checkbox" bind:checked={allowTestFlight} /> Allow TestFlight requests</label>
  <Button size="sm" class="mt-3" loading={busy} onclick={() => void create()}>Create trust policy</Button>
  <div class="mt-4 divide-y divide-border/70">
    {#each policies as policy (policy.id)}
      <div class="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
        <div class="min-w-0"><div class="font-medium">Repository {policy.repositoryId} · {policy.enabled ? 'Active' : 'Revoked'}</div><div class="break-all text-muted">{policy.workflowRef} · {policy.ref ?? policy.environment} · {policy.bundleIds.join(', ')}</div></div>
        {#if policy.enabled}<Button size="sm" variant="secondary" disabled={busy} onclick={() => void revoke(policy.id)}>Revoke</Button>{/if}
      </div>
      <IntegrationOwnershipControl integrationId={policy.id} ownerName={policy.billingOwnerDisplayName} transferName={policy.billingOwnerTransferDisplayName} onSaved={load} />
    {/each}
  </div>
</Card>
