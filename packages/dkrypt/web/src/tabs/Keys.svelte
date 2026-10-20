<script lang="ts">
  import { PackageSearch, TriangleAlert } from 'lucide-svelte';
  import CopyButton from '#components/CopyButton.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import KeyUsageDialog from '#components/KeyUsageDialog.svelte';
  import RelativeTime from '#components/RelativeTime.svelte';
  import SkeletonRows from '#components/SkeletonRows.svelte';
  import {
    approveKey,
    bulkApproveKeys,
    bulkExtendKeyExpiry,
    bulkRevokeKeys,
    bulkSetKeyDailyLimit,
    bulkSetKeyScope,
    createKey,
    denyKey,
    fetchAllKeys,
    fetchMyKeys,
    fetchPendingKeys,
    regenerateKey,
    requestKey,
    revealKey,
    simulateApiKeyScope,
    revokeKey,
    updateKeyAllowTestFlight,
    updateKeyMaxConcurrent,
    updateKeyPriority,
    type ApiKeyRecord,
  } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Checkbox from '#lib/components/ui/Checkbox.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import { statusToBadgeVariant } from '#lib/components/ui/variants';
  import { debounce, fmtUntil } from '#lib/format.svelte';
  import { scrollFade } from '#lib/scrollFade';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasAnyPermission, sessionHasPermission, sessionState } from '#lib/session.svelte';
  import { projectSelectionState } from '#lib/projectSelection.svelte';
  import { confirmDialog, keyUsageJumpState, showToast } from '#lib/ui.svelte';

  const PAGE_SIZE = 25;

  let keyName = $state('');
  let keyExpiry = $state('never');
  let keyScope = $state('');
  let keyDailyLimit = $state('');
  let simulateBundleId = $state('');
  let simulateSource = $state<'appstore' | 'testflight'>('appstore');
  let simulateKeyId = $state('');
  let simulateScope = $state('');
  let simulateClearScope = $state(false);
  let simulateDailyLimit = $state('');
  let simulateConcurrentLimit = $state('');
  let simulateTestFlight = $state('keep');
  let simulation = $state<Awaited<ReturnType<typeof simulateApiKeyScope>> | null>(null);
  let simulationBusy = $state(false);
  let revealedKey = $state('');
  let mine = $state<ApiKeyRecord[] | null>(null);
  let pending = $state<ApiKeyRecord[] | null>(null);
  let all = $state<ApiKeyRecord[] | null>(null);
  let allTotal = $state(0);
  let allNextCursor = $state<string | undefined>(undefined);
  let loadingMoreAll = $state(false);
  let statusFilter = $state('all');
  let allSearch = $state('');
  let selected = $state<Set<string>>(new Set());
  let selectedPending = $state<Set<string>>(new Set());
  let submitting = $state(false);
  let busyActions = $state<Set<string>>(new Set());
  let bulkRevoking = $state(false);
  let bulkApproving = $state(false);

  function setBusy(action: string, id: string, busy: boolean): void {
    const key = `${action}:${id}`;
    const next = new Set(busyActions);
    if (busy) next.add(key);
    else next.delete(key);
    busyActions = next;
  }

  function isBusy(action: string, id: string): boolean {
    return busyActions.has(`${action}:${id}`);
  }

  const STALE_MS = 90 * 24 * 60 * 60 * 1000;

  function isStale(k: ApiKeyRecord): boolean {
    if (k.status !== 'approved') return false;
    const lastActivity = k.lastUsedAt ?? k.createdAt;
    return Date.now() - lastActivity > STALE_MS;
  }

  const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

  const expiringSoonKeys = $derived.by(() => {
    const seen = new Map<string, ApiKeyRecord>();
    for (const k of [...(mine ?? []), ...(all ?? [])]) {
      if (k.status !== 'approved' || !k.expiresAt) continue;
      const untilExpiry = k.expiresAt - Date.now();
      if (untilExpiry > 0 && untilExpiry <= EXPIRING_SOON_MS) seen.set(k.id, k);
    }
    return [...seen.values()].sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0));
  });

  let usageOpen = $state(false);
  let usageKeyId = $state('');
  let usageKeyName = $state('');
  let usageKeyDailyLimit = $state<number | undefined>(undefined);
  let usageKeyLastIp = $state<string | undefined>(undefined);

  function openUsage(k: ApiKeyRecord): void {
    usageKeyId = k.id;
    usageKeyName = k.name;
    usageKeyDailyLimit = k.dailyLimit;
    usageKeyLastIp = k.lastUsedIp;
    usageOpen = true;
  }

  const STATUS_OPTIONS = [
    { value: 'all', label: 'All statuses' },
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Approved' },
    { value: 'denied', label: 'Denied' },
  ];

  const EXPIRY_OPTIONS = [
    { value: 'never', label: 'Never expires' },
    { value: '1', label: 'In 1 day' },
    { value: '7', label: 'In 7 days' },
    { value: '30', label: 'In 30 days' },
    { value: '90', label: 'In 90 days' },
  ];

  const canManage = $derived(sessionHasPermission(PermissionFlag.manageApiKeys));
  const canCreate = $derived(sessionHasPermission(PermissionFlag.createApiKeys));
  const canRequest = $derived(sessionHasPermission(PermissionFlag.requestApiKeys));
  const canViewAll = $derived(sessionHasAnyPermission([PermissionFlag.viewApiKeys, PermissionFlag.manageApiKeys]));
  const canRevokeAny = $derived(canManage);
  const canViewUsage = $derived(canViewAll || canCreate);
  const canManageExpiry = $derived(canManage);
  const canManageDailyLimits = $derived(canManage);
  const canManageScope = $derived(canManage);
  const canManagePriority = $derived(canManage);
  const canManageConcurrency = $derived(canManage);
  const canManageTestFlight = $derived(canManage);

  async function loadAllKeysPage(): Promise<void> {
    const data = await fetchAllKeys(undefined, PAGE_SIZE, allSearch);
    all = data.keys;
    allTotal = data.total;
    allNextCursor = data.nextCursor;
  }

  async function loadMoreKeys(): Promise<void> {
    if (!all || !allNextCursor) return;
    loadingMoreAll = true;
    try {
      const data = await fetchAllKeys(allNextCursor, PAGE_SIZE, allSearch);
      all = [...all, ...data.keys];
      allTotal = data.total;
      allNextCursor = data.nextCursor;
    } finally {
      loadingMoreAll = false;
    }
  }

  const debouncedSearchAllKeys = debounce(() => void loadAllKeysPage(), 300);

  $effect(() => {
    void allSearch;
    debouncedSearchAllKeys();
  });

  async function loadAll(): Promise<void> {
    mine = (await fetchMyKeys()).keys;
    if (canManage) pending = (await fetchPendingKeys()).keys;
    if (canViewAll) await loadAllKeysPage();
  }

  $effect(() => {
    void loadAll();
  });

  $effect(() => {
    const keyId = keyUsageJumpState.keyId;
    if (!keyId) return;
    const match = mine?.find((k) => k.id === keyId) ?? all?.find((k) => k.id === keyId);
    if (!match) return;
    openUsage(match);
    keyUsageJumpState.keyId = null;
  });

  function parseScope(raw: string): string[] | undefined {
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return ids.length > 0 ? ids : undefined;
  }

  async function previewScope(): Promise<void> {
    if (!simulateBundleId.trim()) return;
    simulationBusy = true;
    try {
      simulation = await simulateApiKeyScope({
        keyId: simulateKeyId || undefined,
        projectId: projectSelectionState.id,
        bundleId: simulateBundleId.trim(),
        source: simulateSource,
        allowedBundleIds: simulateKeyId ? simulateClearScope ? [] : parseScope(simulateScope) : parseScope(keyScope),
        allowTestFlight: simulateTestFlight === 'keep' ? undefined : simulateTestFlight === 'allow',
        dailyLimit: simulateKeyId ? simulateDailyLimit.trim() ? Number(simulateDailyLimit) || null : undefined : keyDailyLimit.trim() ? Number(keyDailyLimit) : undefined,
        maxConcurrent: simulateConcurrentLimit.trim() ? Number(simulateConcurrentLimit) || null : undefined,
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not preview API key scope', 'error');
    } finally {
      simulationBusy = false;
    }
  }

  async function submitRequest(): Promise<void> {
    const name = keyName.trim();
    if (!name) return;
    submitting = true;
    try {
      const expiresInDays = keyExpiry === 'never' ? undefined : Number(keyExpiry);
      const dailyLimit = keyDailyLimit.trim() ? Number(keyDailyLimit) : undefined;
      const { ok, data } = canCreate
        ? await createKey(name, expiresInDays, parseScope(keyScope), dailyLimit)
        : await requestKey(name, expiresInDays, parseScope(keyScope), dailyLimit);
      if (!ok) return;
      keyName = '';
      keyScope = '';
      keyDailyLimit = '';
      if (canCreate && data.key) {
        revealedKey = data.key;
        showToast('Key created', 'success');
      } else {
        showToast('Request submitted - waiting on admin approval', 'success');
      }
      void loadAll();
    } finally {
      submitting = false;
    }
  }

  function curlExample(key: string): string {
    const base = sessionState.publicBaseUrl ?? location.origin;
    return `curl -H "Authorization: Bearer ${key}" "${base}/v1/decrypt?bundleId=com.example.app" -o app.ipa`;
  }

  function envExample(key: string): string {
    const base = sessionState.publicBaseUrl ?? location.origin;
    return `DKRYPT_API_KEY=${key}\nDKRYPT_BASE_URL=${base}`;
  }

  async function doReveal(id: string): Promise<void> {
    setBusy('reveal', id, true);
    try {
      const { ok, data } = await revealKey(id);
      if (!ok) return;
      revealedKey = data.key;
      void loadAll();
    } finally {
      setBusy('reveal', id, false);
    }
  }

  const REGENERATE_GRACE_MINUTES = 15;

  async function doRegenerate(id: string): Promise<void> {
    if (
      !(await confirmDialog(`Regenerate this key? The old secret keeps working for ${REGENERATE_GRACE_MINUTES} more minutes so in-flight deploys don't break.`, {
        confirmLabel: 'Regenerate',
      }))
    )
      return;
    setBusy('regenerate', id, true);
    try {
      const { ok } = await regenerateKey(id, REGENERATE_GRACE_MINUTES);
      if (ok) void loadAll();
    } finally {
      setBusy('regenerate', id, false);
    }
  }

  async function doRevoke(id: string): Promise<void> {
    if (!(await confirmDialog('Revoke this key? Access is cut off immediately.'))) return;
    setBusy('revoke', id, true);
    try {
      const { ok } = await revokeKey(id);
      if (ok) void loadAll();
    } finally {
      setBusy('revoke', id, false);
    }
  }

  async function doApprove(id: string): Promise<void> {
    setBusy('approve', id, true);
    try {
      const { ok } = await approveKey(id);
      if (ok) void loadAll();
    } finally {
      setBusy('approve', id, false);
    }
  }

  async function savePriority(id: string, priority: number): Promise<void> {
    setBusy('priority', id, true);
    try {
      await updateKeyPriority(id, priority);
      void loadAll();
    } finally {
      setBusy('priority', id, false);
    }
  }

  async function saveMaxConcurrent(id: string, raw: string): Promise<void> {
    const trimmed = raw.trim();
    const maxConcurrent = trimmed ? Number(trimmed) : null;
    if (maxConcurrent !== null && (!Number.isFinite(maxConcurrent) || maxConcurrent <= 0)) return;
    setBusy('maxConcurrent', id, true);
    try {
      await updateKeyMaxConcurrent(id, maxConcurrent);
      void loadAll();
    } finally {
      setBusy('maxConcurrent', id, false);
    }
  }

  async function saveAllowTestFlight(id: string, allowTestFlight: boolean): Promise<void> {
    setBusy('allowTestFlight', id, true);
    try {
      await updateKeyAllowTestFlight(id, allowTestFlight);
      void loadAll();
    } finally {
      setBusy('allowTestFlight', id, false);
    }
  }

  async function doDeny(id: string): Promise<void> {
    if (!(await confirmDialog('Deny this key request?'))) return;
    setBusy('deny', id, true);
    try {
      const { ok } = await denyKey(id);
      if (ok) void loadAll();
    } finally {
      setBusy('deny', id, false);
    }
  }

  function toggleSelect(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function toggleSelectPending(id: string): void {
    const next = new Set(selectedPending);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedPending = next;
  }

  const filteredAll = $derived((all ?? []).filter((k) => statusFilter === 'all' || k.status === statusFilter));

  async function bulkRevoke(): Promise<void> {
    if (selected.size === 0) return;
    if (!(await confirmDialog(`Revoke ${selected.size} key(s)? This can't be undone.`))) return;
    bulkRevoking = true;
    try {
      await bulkRevokeKeys([...selected]);
      selected = new Set();
      void loadAll();
    } finally {
      bulkRevoking = false;
    }
  }

  let bulkExtendDays = $state('30');
  let bulkExtending = $state(false);

  async function bulkExtend(): Promise<void> {
    const days = Number(bulkExtendDays);
    if (selected.size === 0 || !Number.isFinite(days) || days <= 0) return;
    bulkExtending = true;
    try {
      await bulkExtendKeyExpiry([...selected], days);
      selected = new Set();
      void loadAll();
    } finally {
      bulkExtending = false;
    }
  }

  let bulkDailyLimit = $state('');
  let bulkSettingLimit = $state(false);

  async function bulkSetLimit(): Promise<void> {
    if (selected.size === 0) return;
    const trimmed = bulkDailyLimit.trim();
    const limit = trimmed ? Number(trimmed) : null;
    if (trimmed && (!Number.isFinite(limit) || (limit as number) <= 0)) return;
    bulkSettingLimit = true;
    try {
      await bulkSetKeyDailyLimit([...selected], limit);
      selected = new Set();
      void loadAll();
    } finally {
      bulkSettingLimit = false;
    }
  }

  let bulkScope = $state('');
  let bulkSettingScope = $state(false);

  async function bulkSetScope(): Promise<void> {
    if (selected.size === 0) return;
    const ids = bulkScope
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    bulkSettingScope = true;
    try {
      await bulkSetKeyScope([...selected], ids.length > 0 ? ids : null);
      selected = new Set();
      bulkScope = '';
      void loadAll();
    } finally {
      bulkSettingScope = false;
    }
  }

  async function bulkApprove(): Promise<void> {
    if (selectedPending.size === 0) return;
    bulkApproving = true;
    try {
      await bulkApproveKeys([...selectedPending]);
      selectedPending = new Set();
      void loadAll();
    } finally {
      bulkApproving = false;
    }
  }
</script>

<div class="flex flex-col gap-4">
  {#if expiringSoonKeys.length > 0}
    <Card class="border-warn">
      <div class="flex items-start gap-2.5">
        <TriangleAlert class="text-warn mt-0.5 h-4 w-4 shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium">
            {expiringSoonKeys.length} key{expiringSoonKeys.length === 1 ? '' : 's'} expiring within 7 days
          </div>
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            {#each expiringSoonKeys as k (k.id)}
              <Button
                variant="outline"
                size="sm"
                class="border-warn text-warn hover:bg-warn/10"
                onclick={() => openUsage(k)}
                title="View usage for {k.name}"
              >
                {k.name} · {fmtUntil(k.expiresAt as number)}
              </Button>
            {/each}
          </div>
        </div>
      </div>
    </Card>
  {/if}
  {#if canCreate || canRequest}
  <Card title={canCreate ? 'Create API key' : 'Request API key'}>
    <div class="mb-2.5 text-sm text-muted">
      {canCreate ? 'API keys can submit decrypts, check job status, and access the IPA library. Sessions, billing, and dashboard management stay in dkrypt. This key is created immediately and is ready to use.' : 'API keys can submit decrypts, check job status, and access the IPA library. Sessions, billing, and dashboard management stay in dkrypt. This request needs approval from someone with Manage API keys before it works.'}
    </div>
    <label for="key-name" class="mb-1 block text-xs text-muted">Name</label>
    <Input id="key-name" placeholder="e.g. laptop, ci-runner" bind:value={keyName} />
    <label for="key-expiry" class="mt-3 mb-1 block text-xs text-muted">Expires</label>
    <Select id="key-expiry" items={EXPIRY_OPTIONS} bind:value={keyExpiry} class="w-full" />
    <label for="key-scope" class="mt-3 mb-1 block text-xs text-muted">Restrict to bundle IDs (optional)</label>
    <Input id="key-scope" placeholder="e.g. com.example.app, com.example.app2" bind:value={keyScope} />
    <div class="mt-1 text-xs text-muted">Comma-separated. Leave blank for a key that can decrypt anything.</div>
    <label for="key-daily-limit" class="mt-3 mb-1 block text-xs text-muted">Daily request limit (optional)</label>
    <Input id="key-daily-limit" type="number" min="1" placeholder="e.g. 100" bind:value={keyDailyLimit} />
    <div class="mt-1 text-xs text-muted">Blank = no limit. Over-limit requests get a 429 until the next day.</div>
    <div class="mt-3 rounded-lg border border-border/70 p-3">
      <h3 class="text-xs font-semibold">Preview access before creating or changing a key</h3>
      <label class="mt-2 block text-xs"><span class="mb-1 block text-muted">Key to preview</span><Select items={[{ value: '', label: 'Proposed new key' }, ...[...new Map([...(mine ?? []), ...(all ?? [])].map((key) => [key.id, key])).values()].map((key) => ({ value: key.id, label: `${key.name} · ${key.ownerDisplayName ?? key.ownerUsername ?? key.ownerId}` }))]} bind:value={simulateKeyId} /></label>
      <div class="mt-2 flex flex-wrap gap-2">
        <label class="min-w-40 flex-1 text-xs"><span class="mb-1 block text-muted">Bundle ID</span><Input id="scope-simulator-bundle" placeholder="com.example.app" bind:value={simulateBundleId} class="w-full" /></label>
        <label class="text-xs"><span class="mb-1 block text-muted">Source</span><Select id="scope-simulator-source" items={[{ value: 'appstore', label: 'App Store' }, { value: 'testflight', label: 'TestFlight' }]} bind:value={simulateSource} /></label>
        <Button size="sm" variant="secondary" loading={simulationBusy} onclick={() => void previewScope()}>Preview scope</Button>
      </div>
      {#if simulateKeyId}
        <label class="mt-2 block text-xs"><span class="mb-1 block text-muted">Proposed bundle scope, blank keeps current</span><Input bind:value={simulateScope} placeholder="com.example.app, com.example.app2" disabled={simulateClearScope} /></label>
        <label class="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={simulateClearScope} /> Remove bundle restriction</label>
      {/if}
      <div class="mt-2 flex flex-wrap gap-2">
        <label class="min-w-28 flex-1 text-xs"><span class="mb-1 block text-muted">{simulateKeyId ? 'Proposed daily limit, blank keeps current' : 'Daily limit from form'}</span>{#if simulateKeyId}<Input type="number" min="0" bind:value={simulateDailyLimit} placeholder="0 = unlimited" />{:else}<span class="block py-2">{keyDailyLimit || 'Unlimited'}</span>{/if}</label>
        <label class="min-w-28 flex-1 text-xs"><span class="mb-1 block text-muted">Proposed concurrency, blank keeps current</span><Input type="number" min="0" bind:value={simulateConcurrentLimit} placeholder="0 = unlimited" /></label>
        <label class="min-w-28 flex-1 text-xs"><span class="mb-1 block text-muted">TestFlight access</span><Select items={[{ value: 'keep', label: 'Keep current/default' }, { value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }]} bind:value={simulateTestFlight} /></label>
      </div>
      {#if simulation}
        <p role="status" class="mt-2 text-xs">{simulation.allowed ? 'This request is within the proposed key scope.' : simulation.reasons.join(' · ')}</p>
        {#if simulation.warnings.length}<p class="mt-1 text-xs text-warn">{simulation.warnings.join(' · ')}</p>{/if}
        <p class="mt-1 text-xs text-muted">{simulation.routes.length} available public routes · {simulation.limits.daily === null ? 'No daily limit' : `${simulation.limits.dailyUsed}/${simulation.limits.daily} requests used today`} · {simulation.limits.concurrent === null ? 'No key concurrency limit' : `${simulation.limits.concurrentRunning}/${simulation.limits.concurrent} running jobs`}{simulation.limits.queueWait ? ' · new jobs would wait' : ''}</p>
        <details class="mt-2 text-xs"><summary class="cursor-pointer">Route-by-route access</summary><ul class="mt-1 space-y-1">{#each simulation.operations as operation (operation.route)}<li>{operation.allowed ? '✓' : '×'} {operation.route}{operation.reasons.length ? ` · ${operation.reasons.join(', ')}` : ''}</li>{/each}</ul></details>
      {/if}
    </div>
    <Button class="mt-3" loading={submitting} onclick={submitRequest}>{canCreate ? 'Create key' : 'Request key'}</Button>
    {#if revealedKey}
      <div class="border-accent bg-panel-muted mt-3 rounded-md border p-2.5 text-xs break-all">
        Save this now, it won't be shown again:<br />
        <code>{revealedKey}</code>
        <CopyButton text={revealedKey} />
        <div class="mt-2 flex flex-wrap gap-1.5">
          <CopyButton text={curlExample(revealedKey)} label="Copy curl example" />
          <CopyButton text={envExample(revealedKey)} label="Copy as .env" />
        </div>
      </div>
    {/if}
  </Card>
  {/if}

  <Card title="My keys">
    <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
      <table class="responsive-table min-w-[640px]">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Scope</th>
            <th>Created</th>
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#if mine === null}
            <SkeletonRows rows={2} colspan={6} />
          {:else}
            {#each mine as k (k.id)}
              <tr>
                <td data-label="Name">{k.name}</td>
                <td data-label="Status">
                  <div class="flex flex-wrap items-center justify-end gap-1.5">
                    <Badge variant={statusToBadgeVariant(k.status)}>{k.status}</Badge>
                    {#if k.expiresAt}
                      <Badge variant="secondary">expires {fmtUntil(k.expiresAt)}</Badge>
                    {/if}
                    {#if isStale(k)}
                      <Badge variant="secondary" title="Not used in 90+ days">unused 90+d</Badge>
                    {/if}
                    {#if k.dailyLimit}
                      <Badge variant="secondary" title="{k.dailyLimit} requests/day">{k.dailyLimit}/day</Badge>
                    {/if}
                  </div>
                </td>
                <td data-label="Scope" class="max-w-40 truncate text-muted" title={k.allowedBundleIds?.join(', ') ?? ''}>
                  {#if k.allowedBundleIds?.length}
                    {k.allowedBundleIds.length} bundle{k.allowedBundleIds.length === 1 ? '' : 's'}
                  {:else}
                    <span class="text-muted">unrestricted</span>
                  {/if}
                </td>
                <td data-label="Created" class="text-muted"><RelativeTime ms={k.createdAt} /></td>
                <td data-label="Last used" class="text-muted"><RelativeTime ms={k.lastUsedAt} /></td>
                <td>
                  <div class="flex flex-wrap justify-end gap-1.5">
                    {#if k.hasUnrevealedSecret}
                      <Button size="sm" loading={isBusy('reveal', k.id)} onclick={() => doReveal(k.id)}>Reveal</Button>
                    {/if}
                    {#if k.status === 'approved'}
                      {#if canViewUsage}<Button size="sm" variant="secondary" onclick={() => openUsage(k)}>Usage</Button>{/if}
                      <Button size="sm" variant="secondary" loading={isBusy('regenerate', k.id)} onclick={() => doRegenerate(k.id)}>Regenerate</Button>
                    {/if}
                    <Button size="sm" variant="destructive" loading={isBusy('revoke', k.id)} onclick={() => doRevoke(k.id)}>Revoke</Button>
                  </div>
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    {#if mine !== null && mine.length === 0}
      <EmptyState icon={PackageSearch} message="No keys yet." />
    {/if}
  </Card>

  {#if canManage}
    <Card title="Pending requests">
      {#snippet headerExtra()}
        {#if selectedPending.size > 0}
          <Button size="sm" loading={bulkApproving} onclick={bulkApprove}>Approve {selectedPending.size} selected</Button>
        {/if}
      {/snippet}
      <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
        <table class="responsive-table min-w-[640px]">
          <thead>
            <tr>
              <th></th>
              <th>Name</th>
              <th>Requested by</th>
              <th>Requested</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#if pending === null}
              <SkeletonRows rows={2} colspan={5} />
            {:else}
              {#each pending as k (k.id)}
                <tr>
                  <td data-label="Select">
                    <Checkbox checked={selectedPending.has(k.id)} onCheckedChange={() => toggleSelectPending(k.id)} aria-label="Select pending key {k.name}" />
                  </td>
                  <td data-label="Name">
                    {k.name}
                    {#if k.expiresAt}
                      <Badge variant="secondary" class="ml-1.5">expires {fmtUntil(k.expiresAt)}</Badge>
                    {/if}
                  </td>
                  <td data-label="Requested by">{k.ownerDisplayName ?? k.ownerUsername ?? k.ownerId}</td>
                  <td data-label="Requested" class="text-muted"><RelativeTime ms={k.createdAt} /></td>
                  <td>
                    <div class="flex justify-end gap-1.5">
                      <Button size="sm" loading={isBusy('approve', k.id)} onclick={() => doApprove(k.id)}>Approve</Button>
                      <Button size="sm" variant="destructive" loading={isBusy('deny', k.id)} onclick={() => doDeny(k.id)}>Deny</Button>
                    </div>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
      {#if pending !== null && pending.length === 0}
        <EmptyState icon={PackageSearch} message="Nothing pending." />
      {/if}
    </Card>
  {/if}

  {#if canViewAll}
    <Card title="All keys">
      {#snippet headerExtra()}
        {#if selected.size > 0}
          <div class="flex flex-wrap items-center gap-1.5">
            {#if canManageExpiry || canManageDailyLimits}
              <div class="flex items-center gap-1">
                <Input type="number" min="1" bind:value={bulkExtendDays} class="h-8 w-16 text-xs" aria-label="Days to extend expiry" />
                {#if canManageExpiry}<Button size="sm" variant="secondary" loading={bulkExtending} onclick={bulkExtend}>Extend expiry</Button>{/if}
              </div>
              <div class="flex items-center gap-1">
                <Input type="number" min="1" placeholder="blank = clear" bind:value={bulkDailyLimit} class="h-8 w-28 text-xs" aria-label="New daily limit" />
                {#if canManageDailyLimits}<Button size="sm" variant="secondary" loading={bulkSettingLimit} onclick={bulkSetLimit}>Set daily limit</Button>{/if}
              </div>
              <div class="flex items-center gap-1">
                <Input placeholder="bundle ids, blank = unrestricted" bind:value={bulkScope} class="h-8 w-56 text-xs" aria-label="Bundle IDs to restrict selected keys to" />
                {#if canManageScope}<Button size="sm" variant="secondary" loading={bulkSettingScope} onclick={bulkSetScope}>Set scope</Button>{/if}
              </div>
            {/if}
            {#if canRevokeAny}
              <Button size="sm" variant="destructive" loading={bulkRevoking} onclick={bulkRevoke}>Revoke {selected.size} selected</Button>
            {/if}
          </div>
        {/if}
      {/snippet}
      <div class="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Search by name or owner…" bind:value={allSearch} class="w-56" />
        <Select items={STATUS_OPTIONS} bind:value={statusFilter} class="w-44" />
      </div>
      <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
        <table class="responsive-table min-w-[800px]">
          <thead>
            <tr>
              {#if canRevokeAny}<th></th>{/if}
              <th>ID</th>
              <th>Name</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Scope</th>
              {#if canManagePriority}<th>Priority</th>{/if}
              {#if canManageConcurrency}<th>Max concurrent</th>{/if}
              {#if canManageTestFlight}<th>TestFlight</th>{/if}
              <th>Created</th>
              <th>Last used</th>
              <th></th>
              {#if canRevokeAny}<th></th>{/if}
            </tr>
          </thead>
          <tbody>
            {#if all === null}
              <SkeletonRows rows={3} colspan={8 + (canRevokeAny ? 2 : 0) + (canManagePriority ? 1 : 0) + (canManageConcurrency ? 1 : 0) + (canManageTestFlight ? 1 : 0)} />
            {:else}
              {#each filteredAll as k (k.id)}
                <tr>
                  {#if canRevokeAny}
                    <td data-label="Select">
                      <Checkbox checked={selected.has(k.id)} onCheckedChange={() => toggleSelect(k.id)} aria-label="Select key {k.name}" />
                    </td>
                  {/if}
                  <td data-label="ID">
                    <div class="flex items-center gap-1.5">
                      <code title={k.id}>{k.id.slice(0, 8)}</code>
                      <CopyButton text={k.id} />
                    </div>
                  </td>
                  <td data-label="Name">{k.name}</td>
                  <td data-label="Owner">{k.ownerDisplayName ?? k.ownerUsername ?? k.ownerId}</td>
                  <td data-label="Status">
                    <div class="flex flex-wrap items-center justify-end gap-1.5">
                      <Badge variant={statusToBadgeVariant(k.status)}>{k.status}</Badge>
                      {#if k.expiresAt}
                        <Badge variant="secondary">{fmtUntil(k.expiresAt)}</Badge>
                      {/if}
                      {#if isStale(k)}
                        <Badge variant="secondary" title="Not used in 90+ days">unused 90+d</Badge>
                      {/if}
                      {#if k.dailyLimit}
                        <Badge variant="secondary" title="{k.dailyLimit} requests/day">{k.dailyLimit}/day</Badge>
                      {/if}
                      {#if k.maxConcurrent}
                        <Badge variant="secondary" title="Up to {k.maxConcurrent} concurrent job(s)">{k.maxConcurrent}× concurrent</Badge>
                      {/if}
                      {#if k.previousKeyValidUntil}
                        <Badge variant="secondary" title="The pre-rotation secret still works until then">old secret valid {fmtUntil(k.previousKeyValidUntil)}</Badge>
                      {/if}
                      {#if k.allowTestFlight === false}
                        <Badge variant="secondary" title="This key can't call the TestFlight endpoints">no TestFlight</Badge>
                      {/if}
                    </div>
                  </td>
                  <td data-label="Scope" class="max-w-32 truncate text-muted" title={k.allowedBundleIds?.join(', ') ?? ''}>
                    {#if k.allowedBundleIds?.length}
                      {k.allowedBundleIds.length} bundle{k.allowedBundleIds.length === 1 ? '' : 's'}
                    {:else}
                      <span class="text-muted">unrestricted</span>
                    {/if}
                  </td>
                  {#if canManagePriority}
                    <td data-label="Priority">
                      <Input
                        type="number"
                        min="-5"
                        max="5"
                        value={k.priority ?? 0}
                        disabled={isBusy('priority', k.id)}
                        onchange={(e) => savePriority(k.id, Number((e.target as HTMLInputElement).value))}
                        class="h-8 w-14 px-1.5 py-1 text-xs"
                        title="Higher goes first among queued manual decrypts"
                      />
                    </td>
                  {/if}
                  {#if canManageConcurrency}
                    <td data-label="Max concurrent">
                      <Input
                        type="number"
                        min="1"
                        placeholder="∞"
                        value={k.maxConcurrent ?? ''}
                        disabled={isBusy('maxConcurrent', k.id)}
                        onchange={(e) => saveMaxConcurrent(k.id, (e.target as HTMLInputElement).value)}
                        class="h-8 w-14 px-1.5 py-1 text-xs"
                        title="Max jobs from this key running at once - blank means unlimited"
                      />
                    </td>
                  {/if}
                  {#if canManageTestFlight}
                    <td data-label="TestFlight">
                      <Switch
                        checked={k.allowTestFlight ?? true}
                        disabled={isBusy('allowTestFlight', k.id)}
                        onCheckedChange={(v) => saveAllowTestFlight(k.id, v)}
                        aria-label="Allow TestFlight for {k.name}"
                      />
                    </td>
                  {/if}
                  <td data-label="Created" class="text-muted"><RelativeTime ms={k.createdAt} /></td>
                  <td data-label="Last used" class="text-muted"><RelativeTime ms={k.lastUsedAt} /></td>
                  <td>
                    {#if k.status === 'approved'}
                      {#if canViewUsage}<Button size="sm" variant="secondary" onclick={() => openUsage(k)}>Usage</Button>{/if}
                    {/if}
                  </td>
                  {#if canRevokeAny}
                    <td><Button size="sm" variant="destructive" loading={isBusy('revoke', k.id)} onclick={() => doRevoke(k.id)}>Revoke</Button></td>
                  {/if}
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
      {#if all !== null && filteredAll.length === 0}
        <EmptyState icon={PackageSearch} message="No keys match this filter." />
      {/if}
      {#if all !== null && allNextCursor}
        <div class="mt-3 flex justify-center">
          <Button size="sm" variant="secondary" loading={loadingMoreAll} onclick={loadMoreKeys}>
            Load more ({allTotal - all.length} older)
          </Button>
        </div>
      {/if}
    </Card>
  {/if}
</div>

<KeyUsageDialog
  open={usageOpen}
  keyId={usageKeyId}
  keyName={usageKeyName}
  dailyLimit={usageKeyDailyLimit}
  lastUsedIp={usageKeyLastIp}
  onOpenChange={(v) => (usageOpen = v)}
/>
