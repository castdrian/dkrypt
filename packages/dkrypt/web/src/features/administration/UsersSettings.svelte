<script lang="ts">
  import { Plus, ScrollText, UserX } from 'lucide-svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import RelativeTime from '#components/RelativeTime.svelte';
  import SkeletonRows from '#components/SkeletonRows.svelte';
  import {
    addUser,
    auditLogExportUrl,
    type AuditLogEntry,
    fetchAuditLog,
    fetchRoles,
    fetchUsers,
    removeUser,
    updateUserRoles,
    type AllowedUser,
    type BillingPlanId,
    type Role,
  } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Checkbox from '#lib/components/ui/Checkbox.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import { PermissionFlag } from '#lib/permissions';
  import { scrollFade } from '#lib/scrollFade';
  import { sessionHasAnyPermission, sessionHasPermission, sessionState } from '#lib/session.svelte';
  import { confirmDialog, userJumpState } from '#lib/ui.svelte';
  import VirtualizedList from '#components/VirtualizedList.svelte';

  const canManage = $derived(sessionHasPermission(PermissionFlag.manageUsers));
  const canViewRoles = $derived(sessionHasAnyPermission([PermissionFlag.viewRoles, PermissionFlag.manageRoles]));

  let addOpen = $state(false);
  let username = $state('');
  let newRoleIds = $state<string[]>([]);
  let users = $state<AllowedUser[] | null>(null);
  let roles = $state<Role[] | null>(null);
  let userSearch = $state('');
  let submitting = $state(false);
  let savingRoles = $state(false);
  let removing = $state(false);
  let auditLog = $state<AuditLogEntry[] | null>(null);
  let auditTotal = $state(0);
  let auditNextCursor = $state<string | undefined>(undefined);
  let loadingMoreAudit = $state(false);
  let auditSearch = $state('');

  const AUDIT_ACTION_LABEL: Record<AuditLogEntry['action'], string> = {
    'user.add': 'added user',
    'user.update': 'updated user',
    'user.remove': 'removed user',
    'state.import': 'restored backup',
    'settings.update': 'updated scheduler settings',
    'watch.add': 'added watch',
    'watch.update': 'updated watch',
    'watch.remove': 'removed watch',
    'device.add': 'added device',
    'device.update': 'updated device',
    'device.remove': 'removed device',
    'role.add': 'added role',
    'role.update': 'updated role',
    'role.remove': 'removed role',
    'auth.session.new_context': 'signed in from a new browser and network',
    'project.add': 'created project',
    'project.update': 'updated project',
    'project.archive': 'changed project availability',
    'project.restore': 'changed project availability',
    'artifact.pin': 'protected artifact from eviction',
    'artifact.unpin': 'removed artifact eviction protection',
    'artifact.archive': 'archived artifact in IPA library',
    'artifact.restore': 'restored artifact to IPA library',
  };

  const assignableRoles = $derived((roles ?? []).filter((r) => !r.isDefault).sort((a, b) => b.position - a.position));

  function roleById(id: string): Role | undefined {
    return (roles ?? []).find((r) => r.id === id);
  }

  function billingPlanName(planId: BillingPlanId): string {
    return ({ regular: 'Regular', priority: 'Priority', api: 'API', priority_api: 'Priority API' })[planId];
  }

  function billingAccessDescription(entitlements: NonNullable<AllowedUser['billingEntitlements']>): string {
    return [
      entitlements.decrypt ? 'Dashboard decrypt' : undefined,
      entitlements.api ? 'API key access' : undefined,
      entitlements.priority > 0 ? 'High queue priority' : undefined,
    ].filter((capability): capability is string => capability !== undefined).join(' · ');
  }

  const filteredUsers = $derived(
    (users ?? []).filter((u) => `${u.username} ${u.accountUsername ?? ''} ${u.displayName ?? ''}`.toLowerCase().includes(userSearch.trim().toLowerCase())),
  );

  let selectedUsers = $state<Set<string>>(new Set());
  let bulkApplying = $state(false);

  const selectableUsers = $derived(filteredUsers.filter((u) => u.username !== (sessionState.sub ?? '').toLowerCase()));

  function toggleSelectUser(username: string): void {
    const next = new Set(selectedUsers);
    if (next.has(username)) next.delete(username);
    else next.add(username);
    selectedUsers = next;
  }

  function toggleSelectAllUsers(): void {
    selectedUsers = selectedUsers.size === selectableUsers.length ? new Set() : new Set(selectableUsers.map((u) => u.username));
  }

  let bulkPreviewOpen = $state(false);
  let bulkPreviewRole = $state<Role | null>(null);

  function openBulkPreview(role: Role): void {
    if (selectedUsers.size === 0) return;
    bulkPreviewRole = role;
    bulkPreviewOpen = true;
  }

  const bulkPreviewUsers = $derived(
    bulkPreviewRole ? (users ?? []).filter((u) => selectedUsers.has(u.username)) : [],
  );

  async function confirmBulkApply(): Promise<void> {
    const role = bulkPreviewRole;
    if (!role) return;
    bulkPreviewOpen = false;
    bulkApplying = true;
    try {
      for (const username of selectedUsers) await updateUserRoles(username, [role.id]);
      selectedUsers = new Set();
      void load();
    } finally {
      bulkApplying = false;
    }
  }

  let auditActionFilter = $state('all');
  let auditFromDate = $state('');
  let auditToDate = $state('');

  const AUDIT_ACTION_OPTIONS = [
    { value: 'all', label: 'All actions' },
    ...(Object.entries(AUDIT_ACTION_LABEL) as [AuditLogEntry['action'], string][]).map(([value, label]) => ({ value, label })),
  ];

  const filteredAuditLog = $derived.by(() => {
    const needle = auditSearch.trim().toLowerCase();
    const fromTs = auditFromDate ? new Date(auditFromDate).setHours(0, 0, 0, 0) : undefined;
    const toTs = auditToDate ? new Date(auditToDate).setHours(23, 59, 59, 999) : undefined;
    return (auditLog ?? []).filter((e) => {
      if (auditActionFilter !== 'all' && e.action !== auditActionFilter) return false;
      if (fromTs !== undefined && e.ts < fromTs) return false;
      if (toTs !== undefined && e.ts > toTs) return false;
      if (!needle) return true;
      return (
        e.actor.toLowerCase().includes(needle) ||
        e.target.toLowerCase().includes(needle) ||
        AUDIT_ACTION_LABEL[e.action].toLowerCase().includes(needle) ||
        (e.detail ?? '').toLowerCase().includes(needle)
      );
    });
  });

  async function load(): Promise<void> {
    const [u, r, a] = await Promise.all([
      fetchUsers(),
      canViewRoles ? fetchRoles() : Promise.resolve({ roles: [] }),
      fetchAuditLog(200),
    ]);
    users = u.users;
    roles = r.roles;
    auditLog = a.entries;
    auditTotal = a.total;
    auditNextCursor = a.nextCursor;
  }

  async function loadMoreAudit(): Promise<void> {
    if (loadingMoreAudit || !auditNextCursor) return;
    loadingMoreAudit = true;
    try {
      const page = await fetchAuditLog(200, auditNextCursor);
      auditLog = [...(auditLog ?? []), ...page.entries];
      auditTotal = page.total;
      auditNextCursor = page.nextCursor;
    } finally {
      loadingMoreAudit = false;
    }
  }

  $effect(() => {
    void load();
  });

  function openAdd(): void {
    username = '';
    newRoleIds = [];
    addOpen = true;

    void load();
  }

  function toggleNewRole(id: string): void {
    newRoleIds = newRoleIds.includes(id) ? newRoleIds.filter((r) => r !== id) : [...newRoleIds, id];
  }

  async function submit(): Promise<void> {
    const name = username.trim();
    if (!name) return;
    submitting = true;
    try {
      const { ok } = await addUser(name, newRoleIds);
      if (ok) {
        addOpen = false;
        void load();
      }
    } finally {
      submitting = false;
    }
  }

  let manageOpen = $state(false);
  let manageUser = $state<AllowedUser | null>(null);
  let manageRoleIds = $state<string[]>([]);
  let managePriority = $state('0');

  function openManage(u: AllowedUser): void {
    manageUser = u;
    manageRoleIds = [...u.roleIds];
    managePriority = String(u.priority ?? 0);
    manageOpen = true;
    void load();
  }

  $effect(() => {
    const username = userJumpState.username;
    if (!username) return;
    const match = users?.find((u) => u.username === username);
    if (!match) return;
    openManage(match);
    userJumpState.username = null;
  });

  function toggleManageRole(id: string): void {
    manageRoleIds = manageRoleIds.includes(id) ? manageRoleIds.filter((r) => r !== id) : [...manageRoleIds, id];
  }

  const rolesUnchanged = $derived.by(() => {
    if (!manageUser) return true;
    const sameRoles =
      manageRoleIds.length === manageUser.roleIds.length && manageRoleIds.every((id) => manageUser?.roleIds.includes(id));
    return sameRoles && Number(managePriority) === (manageUser.priority ?? 0);
  });

  async function saveRoles(): Promise<void> {
    if (!manageUser || rolesUnchanged) return;
    const beforeRoles = manageUser.roleIds.map((id) => roleById(id)?.name ?? id);
    const afterRoles = manageRoleIds.map((id) => roleById(id)?.name ?? id);
    const review = [
      `Member: ${manageUser.displayName ?? manageUser.username}`,
      `Roles: ${beforeRoles.join(', ') || 'none'} → ${afterRoles.join(', ') || 'none'}`,
      `Queue priority: ${manageUser.priority ?? 0} → ${Number(managePriority)}`,
    ].join('\n');
    if (!(await confirmDialog(`Review access change before applying:\n\n${review}`, { confirmLabel: 'Apply access change' }))) return;
    savingRoles = true;
    try {
      const { ok } = await updateUserRoles(manageUser.username, manageRoleIds, Number(managePriority));
      if (ok) {
        manageOpen = false;
        void load();
      }
    } finally {
      savingRoles = false;
    }
  }

  async function removeManaged(): Promise<void> {
    if (!manageUser) return;
    const username = manageUser.username;
    manageOpen = false;
    if (!(await confirmDialog(`Remove every dashboard role from ${manageUser.displayName ?? manageUser.accountUsername ?? username}? They can still sign in but will only retain the default permissions.`))) return;
    removing = true;
    try {
      await removeUser(username);
      void load();
    } finally {
      removing = false;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <Card title="Members">
    {#snippet headerExtra()}
      {#if canManage}
        <Button size="sm" onclick={openAdd}>
          <Plus class="h-3.5 w-3.5" />
          Add user
        </Button>
      {/if}
    {/snippet}
    {#if (users?.length ?? 0) > 5}
      <Input placeholder="Search by username…" bind:value={userSearch} class="mb-3 max-w-xs" />
    {/if}
    {#if canManage && selectedUsers.size > 0 && assignableRoles.length > 0}
      <div class="mb-3 flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-muted">Set role for {selectedUsers.size} selected:</span>
        {#each assignableRoles as role (role.id)}
          <Button size="sm" variant="secondary" loading={bulkApplying} onclick={() => openBulkPreview(role)}>
            {role.name}
          </Button>
        {/each}
      </div>
    {/if}
    <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
      <table class="responsive-table min-w-[640px]">
        <thead>
          <tr>
            {#if canManage}
              <th>
                <Checkbox checked={selectableUsers.length > 0 && selectedUsers.size === selectableUsers.length} onCheckedChange={toggleSelectAllUsers} aria-label="Select all users" />
              </th>
            {/if}
            <th>User</th>
            <th>Roles</th>
            <th>Added</th>
            <th>Last active</th>
            <th>Activity</th>
            {#if canManage}<th></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#if users === null}
            <SkeletonRows rows={3} colspan={canManage ? 7 : 5} />
          {:else}
            {@const defaultRole = (roles ?? []).find((r) => r.isDefault)}
            {#each filteredUsers as u (u.username)}
              {@const isSelf = u.username === (sessionState.sub ?? '').toLowerCase()}
              <tr>
                {#if canManage}
                  <td data-label="Select">
                    {#if !isSelf}
                      <Checkbox checked={selectedUsers.has(u.username)} onCheckedChange={() => toggleSelectUser(u.username)} aria-label="Select {u.displayName ?? u.username}" />
                    {/if}
                  </td>
                {/if}
                <td data-label="User">
                  <div class="flex min-w-0 items-center gap-2">
                    {#if u.avatarUrl}<img src={u.avatarUrl} alt="" class="h-6 w-6 shrink-0 rounded-full object-cover" />{/if}
                    <div class="min-w-0">
                      <div class="truncate" data-sensitive="true">{u.displayName ?? u.username}{#if isSelf}<span class="ml-1.5 text-xs text-muted">(you)</span>{/if}</div>
                      {#if u.accountUsername}<div class="truncate text-xs text-muted" data-sensitive="true">@{u.accountUsername}</div>{/if}
                    </div>
                  </div>
                </td>
                <td data-label="Roles">
                  <div class="flex flex-wrap gap-1">
                    {#if defaultRole}
                      <Badge style="background-color: {defaultRole.color}22; color: {defaultRole.color}; border: 1px solid {defaultRole.color}55">
                        {defaultRole.name}
                      </Badge>
                    {/if}
                    {#each u.roleIds as id (id)}
                      {@const role = roleById(id)}
                      {#if role}
                        <Badge style="background-color: {role.color}22; color: {role.color}; border: 1px solid {role.color}55">
                          {role.name}
                        </Badge>
                      {/if}
                    {/each}
                  </div>
                  {#if u.billingEntitlements}
                    <div class="border-border mt-1 rounded-md border px-2 py-1 text-[11px]" aria-label="Subscription-based access">
                      <div class="font-medium">{billingPlanName(u.billingEntitlements.planId)} plan</div>
                      <div class="text-muted">{billingAccessDescription(u.billingEntitlements)}</div>
                    </div>
                  {/if}
                </td>
                <td data-label="Added" class="text-muted"><RelativeTime ms={u.addedAt} /></td>
                <td data-label="Last active" class="text-muted">
                  {#if u.lastActiveAt}
                    <RelativeTime ms={u.lastActiveAt} />
                  {:else}
                    never
                  {/if}
                </td>
                <td data-label="Activity" class="text-xs text-muted">
                  {#if u.activity}
					<div>{u.activity.manualJobs} jobs · {u.activity.completedJobs} done · {u.activity.failedJobs} failed</div>
					<div>{u.activity.apiKeys} keys · {u.activity.apiRequests30d} API requests / 30d</div>
					{#if u.activity.lastJobAt}<div>last job <RelativeTime ms={u.activity.lastJobAt} /></div>{/if}
                  {:else}
                    no activity
                  {/if}
                </td>
                {#if canManage}
                  <td>
                    {#if !isSelf}
                      <Button size="sm" variant="secondary" onclick={() => openManage(u)}>Manage</Button>
                    {/if}
                  </td>
                {/if}
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    {#if users !== null && users.length === 0}
    <EmptyState icon={UserX} message="No members have role assignments yet." />
    {:else if users !== null && filteredUsers.length === 0}
      <EmptyState icon={UserX} message={`No users match "${userSearch}".`} />
    {/if}
  </Card>

  <Card title="Audit log">
    {#snippet headerExtra()}
      <div class="flex items-center gap-2">
        <a href={auditLogExportUrl('csv')} download class={buttonVariants('secondary', 'sm')}>Export CSV</a>
        <a href={auditLogExportUrl('json')} download class={buttonVariants('secondary', 'sm')}>Export JSON</a>
      </div>
    {/snippet}
    {#if (auditLog?.length ?? 0) > 5}
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <Input placeholder="Search by actor, action, target, or detail…" bind:value={auditSearch} class="max-w-xs" />
        <Select items={AUDIT_ACTION_OPTIONS} bind:value={auditActionFilter} class="w-44" />
        <label class="flex items-center gap-1.5 text-xs text-muted">
          From
          <Input type="date" bind:value={auditFromDate} class="h-8 w-auto px-2 py-1 text-xs" />
        </label>
        <label class="flex items-center gap-1.5 text-xs text-muted">
          To
          <Input type="date" bind:value={auditToDate} class="h-8 w-auto px-2 py-1 text-xs" />
        </label>
      </div>
    {/if}
    {#if auditLog === null}
      <div class="flex flex-col gap-1.5" role="status" aria-label="Loading audit log">
        {#each Array(3) as _, index (index)}
          <div class="skeleton bg-panel-muted h-12 rounded-md" aria-hidden="true"></div>
        {/each}
      </div>
    {:else}
      <VirtualizedList
        items={filteredAuditLog}
        itemKey={(entry) => entry.id}
        estimateSize={72}
        overscan={6}
        label="Audit log entries"
        class="h-80 overflow-y-auto rounded-xl border border-border/70"
      >
        {#snippet children(entry: AuditLogEntry)}
          <article class="grid gap-x-3 gap-y-2 border-b border-border/70 px-3 py-2.5 text-xs sm:grid-cols-[minmax(8rem,0.8fr)_minmax(7rem,0.8fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(12rem,1.6fr)] sm:items-center">
            <div class="min-w-0"><div class="text-[10px] font-semibold tracking-[0.08em] text-muted uppercase sm:hidden">When</div><div class="text-muted"><RelativeTime ms={entry.ts} /></div></div>
            <div class="min-w-0"><div class="text-[10px] font-semibold tracking-[0.08em] text-muted uppercase sm:hidden">Actor</div><div class="truncate" data-sensitive="true">{entry.actorDisplayName ?? entry.actor}</div></div>
            <div class="min-w-0"><div class="text-[10px] font-semibold tracking-[0.08em] text-muted uppercase sm:hidden">Action</div><Badge variant="secondary">{AUDIT_ACTION_LABEL[entry.action]}</Badge></div>
            <div class="min-w-0"><div class="text-[10px] font-semibold tracking-[0.08em] text-muted uppercase sm:hidden">Target</div><div class="truncate" data-sensitive="true">{entry.target}</div></div>
            <div class="min-w-0"><div class="text-[10px] font-semibold tracking-[0.08em] text-muted uppercase sm:hidden">Detail</div><div class="truncate font-mono text-muted" data-sensitive="true">{entry.detail ?? ''}</div>{#if entry.changes?.length}<ul class="mt-1 grid gap-0.5 text-[10px] text-muted">{#each entry.changes as change (change.field)}<li><span class="font-medium">{change.field}</span>: {String(change.before)} → {String(change.after)}</li>{/each}</ul>{/if}</div>
          </article>
        {/snippet}
      </VirtualizedList>
    {/if}
    {#if auditLog !== null && auditNextCursor}
      <div class="mt-3 flex justify-center">
        <Button size="sm" variant="secondary" loading={loadingMoreAudit} onclick={() => void loadMoreAudit()}>Load more ({Math.max(0, auditTotal - auditLog.length)} older)</Button>
      </div>
    {/if}
    {#if auditLog !== null && auditLog.length === 0}
      <EmptyState icon={ScrollText} message="No changes recorded yet." />
    {:else if auditLog !== null && filteredAuditLog.length === 0}
      <EmptyState icon={ScrollText} message={`No changes match "${auditSearch}".`} />
    {/if}
  </Card>
</div>

{#if canManage}
  <Dialog open={addOpen} onOpenChange={(v) => (addOpen = v)} class="max-w-md">
    <div class="mb-3 text-sm font-medium">Assign roles to a member</div>
    <label for="user-username" class="mb-1 block text-xs text-muted">Account username or OAuth ID</label>
    <Input id="user-username" placeholder="e.g. octocat" bind:value={username} />
    <div class="mt-3 max-h-[46vh] overflow-y-auto pr-0.5">
      <div class="mb-1 text-xs text-muted">Roles (everyone also holds @everyone)</div>
      {#if assignableRoles.length === 0}
        <div class="text-xs text-muted">No roles yet - create one on the Roles tab first.</div>
      {:else}
        <div class="border-border flex flex-col divide-y rounded-lg border">
          {#each assignableRoles as role (role.id)}
            <div class="flex items-center gap-2.5 px-3 py-2">
              <Checkbox checked={newRoleIds.includes(role.id)} onCheckedChange={() => toggleNewRole(role.id)} aria-label="Assign {role.name}" />
              <span class="h-2 w-2 shrink-0 rounded-full" style="background-color: {role.color}"></span>
              <span class="text-[13px]">{role.name}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <Button class="mt-3.5 w-full" loading={submitting} onclick={submit} disabled={!username.trim()}>Add</Button>
  </Dialog>

  <Dialog open={manageOpen} onOpenChange={(v) => (manageOpen = v)} class="max-w-md">
    {#if manageUser}
      <div class="mb-3 text-sm font-medium">Manage {manageUser.displayName ?? manageUser.accountUsername ?? manageUser.username}</div>
      <div class="max-h-[50vh] overflow-y-auto pr-0.5">
        {#if manageUser.billingEntitlements}
          <div class="border-border bg-panel-muted/50 mb-3 rounded-lg border p-3 text-xs" role="note">
            <div class="font-medium">{billingPlanName(manageUser.billingEntitlements.planId)} subscription access</div>
            <div class="text-muted mt-1">{billingAccessDescription(manageUser.billingEntitlements)}</div>
            <div class="text-muted mt-1">This access comes from billing and is not changed by role assignments.</div>
          </div>
        {/if}
        <div class="mb-1 text-xs text-muted">Roles (everyone also holds @everyone)</div>
        {#if assignableRoles.length === 0}
          <div class="text-xs text-muted">No roles yet - create one on the Roles tab first.</div>
        {:else}
          <div class="border-border flex flex-col divide-y rounded-lg border">
            {#each assignableRoles as role (role.id)}
              <div class="flex items-center gap-2.5 px-3 py-2">
                <Checkbox checked={manageRoleIds.includes(role.id)} onCheckedChange={() => toggleManageRole(role.id)} aria-label="Assign {role.name}" />
                <span class="h-2 w-2 shrink-0 rounded-full" style="background-color: {role.color}"></span>
                <span class="text-[13px]">{role.name}</span>
              </div>
            {/each}
          </div>
        {/if}
        <label for="user-priority" class="mt-3 mb-1 block text-xs text-muted">Queue priority (-5 to 5)</label>
        <Input id="user-priority" type="number" min="-5" max="5" bind:value={managePriority} />
        <div class="mt-1 text-xs text-muted">
          Higher goes first among queued manual decrypts. 0 is the default - most people never need to touch this.
        </div>
      </div>
      <Button class="mt-3.5 w-full" loading={savingRoles} onclick={saveRoles} disabled={rolesUnchanged}>
        Save roles
      </Button>
      <div class="border-border mt-4 border-t pt-4">
        <Button variant="destructive" class="w-full" loading={removing} onclick={removeManaged}>Remove role assignments</Button>
      </div>
    {/if}
  </Dialog>

  <Dialog open={bulkPreviewOpen} onOpenChange={(v) => (bulkPreviewOpen = v)} class="max-w-md">
    {#if bulkPreviewRole}
      {@const role = bulkPreviewRole}
      <div class="mb-1 text-sm font-medium">Set "{role.name}" as the only role</div>
      <div class="mb-3 text-xs text-muted">
        This replaces every role currently held by {bulkPreviewUsers.length} selected user{bulkPreviewUsers.length === 1 ? '' : 's'} - review what
        changes before applying.
      </div>
      <div class="border-border flex max-h-[46vh] flex-col divide-y overflow-y-auto rounded-lg border">
        {#each bulkPreviewUsers as u (u.username)}
          <div class="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
            <span class="shrink-0 font-medium">{u.displayName ?? u.username}</span>
            <div class="flex flex-wrap items-center gap-1">
              {#each u.roleIds as id (id)}
                {@const current = roleById(id)}
                {#if current}
                  <Badge style="background-color: {current.color}22; color: {current.color}; border: 1px solid {current.color}55">
                    {current.name}
                  </Badge>
                {/if}
              {:else}
                <span class="text-muted">(no roles)</span>
              {/each}
            </div>
            <span class="text-muted">→</span>
            <Badge style="background-color: {role.color}22; color: {role.color}; border: 1px solid {role.color}55">
              {role.name}
            </Badge>
            {#if u.roleIds.length === 1 && u.roleIds[0] === role.id}
              <Badge variant="secondary">no change</Badge>
            {/if}
          </div>
        {/each}
      </div>
      <Button class="mt-3.5 w-full" loading={bulkApplying} onclick={confirmBulkApply}>
        Apply to {bulkPreviewUsers.length} user{bulkPreviewUsers.length === 1 ? '' : 's'}
      </Button>
    {/if}
  </Dialog>
{/if}
