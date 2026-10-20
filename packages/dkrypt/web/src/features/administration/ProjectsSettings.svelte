<script lang="ts">
  import { Archive, FolderPlus, Pencil, RotateCcw, UsersRound } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import { createProject, fetchProjectMembers, fetchProjects, updateProject, type ProjectMember, type ProjectRecord } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Checkbox from '#lib/components/ui/Checkbox.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { confirmDialog } from '#lib/ui.svelte';
  import { fmtBytesGB, fmtNumber } from '#lib/format.svelte';

  const canManage = $derived(sessionHasPermission(PermissionFlag.manageProjects));

  let projects = $state<ProjectRecord[] | null>(null);
  let members = $state<ProjectMember[]>([]);
  let loadingError = $state('');
  let dialogOpen = $state(false);
  let editingProject = $state<ProjectRecord | null>(null);
  let name = $state('');
  let description = $state('');
  let memberIds = $state<string[]>([]);
  let storageQuota = $state('');
  let dailyJobQuota = $state('');
  let concurrentJobQuota = $state('');
  let saving = $state(false);
  let archivingId = $state<string | null>(null);

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    loadingError = '';
    try {
      const [projectResult, memberResult] = await Promise.all([
        fetchProjects(),
        canManage ? fetchProjectMembers() : Promise.resolve({ members: [] }),
      ]);
      projects = projectResult.projects;
      members = memberResult.members;
    } catch (error) {
      loadingError = error instanceof Error ? error.message : 'Could not load projects';
    }
  }

  function quotaValue(value: string): number | undefined {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
  }

  function openCreate(): void {
    editingProject = null;
    name = '';
    description = '';
    memberIds = [];
    storageQuota = '';
    dailyJobQuota = '';
    concurrentJobQuota = '';
    dialogOpen = true;
  }

  function openEdit(project: ProjectRecord): void {
    editingProject = project;
    name = project.name;
    description = project.description ?? '';
    memberIds = project.memberIds ?? [];
    storageQuota = project.storageQuotaBytes === undefined ? '' : String(project.storageQuotaBytes);
    dailyJobQuota = project.dailyJobQuota === undefined ? '' : String(project.dailyJobQuota);
    concurrentJobQuota = project.maxConcurrentJobs === undefined ? '' : String(project.maxConcurrentJobs);
    dialogOpen = true;
  }

  function toggleMember(userId: string): void {
    memberIds = memberIds.includes(userId) ? memberIds.filter((id) => id !== userId) : [...memberIds, userId];
  }

  async function save(): Promise<void> {
    const storageQuotaBytes = quotaValue(storageQuota);
    const dailyJobLimit = quotaValue(dailyJobQuota);
    const maxConcurrentJobs = quotaValue(concurrentJobQuota);
    if (!name.trim() || [storageQuotaBytes, dailyJobLimit, maxConcurrentJobs].some(Number.isNaN)) return;
    saving = true;
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        memberIds,
        storageQuotaBytes: storageQuotaBytes ?? null,
        dailyJobQuota: dailyJobLimit ?? null,
        maxConcurrentJobs: maxConcurrentJobs ?? null,
      };
      const result = editingProject
        ? await updateProject(editingProject.id, payload)
        : await createProject({ ...payload, description: payload.description ?? undefined, storageQuotaBytes: storageQuotaBytes, dailyJobQuota: dailyJobLimit, maxConcurrentJobs });
      if (result.ok) {
        dialogOpen = false;
        await load();
        window.dispatchEvent(new Event('dkrypt:projects-changed'));
      }
    } finally {
      saving = false;
    }
  }

  async function toggleArchive(project: ProjectRecord): Promise<void> {
    const archived = project.archivedAt === undefined;
    const action = archived ? 'archive' : 'restore';
    if (!(await confirmDialog(`${archived ? 'Archive' : 'Restore'} ${project.name}? ${archived ? 'It will no longer be available for new work.' : 'It will become available again.'}`, { variant: archived ? 'destructive' : 'default', confirmLabel: `${action[0].toUpperCase()}${action.slice(1)} project` }))) return;
    archivingId = project.id;
    try {
      const result = await updateProject(project.id, { archived });
      if (result.ok) {
        await load();
        window.dispatchEvent(new Event('dkrypt:projects-changed'));
      }
    } finally {
      archivingId = null;
    }
  }
</script>

<Card title="Projects" class="mb-4">
  <p class="text-sm text-muted-foreground">Configure project membership and quotas. New jobs and artifacts are scoped to the selected project and shared with its members. Existing activity remains in Default.</p>
</Card>

{#if loadingError}
  <Card class="mb-4"><div role="alert" class="text-sm text-destructive">{loadingError}</div></Card>
{/if}

<div class="mb-3 flex justify-end">
  {#if canManage}
    <Button onclick={openCreate}><FolderPlus class="size-4" />New project</Button>
  {/if}
</div>

{#if projects === null}
  <Card><div class="text-sm text-muted-foreground">Loading projects…</div></Card>
{:else if projects.length === 0}
  <EmptyState icon={UsersRound} message="No projects are available to this account." />
{:else}
  <div class="grid gap-3 xl:grid-cols-2">
    {#each projects as project (project.id)}
      <Card class="min-w-0">
        <div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="truncate text-sm font-semibold">{project.name}</h2>
              {#if project.isDefault}<Badge variant="secondary">Default</Badge>{/if}
              {#if project.archivedAt}<Badge variant="warning">Archived</Badge>{/if}
            </div>
            {#if project.description}<p class="mt-1 text-xs text-muted-foreground">{project.description}</p>{/if}
          </div>
          {#if canManage}
            <div class="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="icon" aria-label="Edit {project.name}" onclick={() => openEdit(project)}><Pencil class="size-4" /></Button>
              {#if !project.isDefault}
                <Button variant="ghost" size="icon" loading={archivingId === project.id} aria-label="{project.archivedAt ? 'Restore' : 'Archive'} {project.name}" onclick={() => void toggleArchive(project)}>
                  {#if project.archivedAt}<RotateCcw class="size-4" />{:else}<Archive class="size-4" />{/if}
                </Button>
              {/if}
            </div>
          {/if}
        </div>
        <div class="mt-4 grid grid-cols-2 gap-2 text-xs">
          <div class="rounded-lg bg-muted/40 px-3 py-2"><div class="text-muted-foreground">Members</div><div class="mt-1 font-medium">{project.isDefault ? 'Everyone' : project.memberIds ? fmtNumber(project.memberIds.length, 0) : 'Your project'}</div></div>
          <div class="rounded-lg bg-muted/40 px-3 py-2"><div class="text-muted-foreground">Storage quota</div><div class="mt-1 font-medium">{project.storageQuotaBytes ? fmtBytesGB(project.storageQuotaBytes) : 'No limit'}</div></div>
          <div class="rounded-lg bg-muted/40 px-3 py-2"><div class="text-muted-foreground">Daily jobs</div><div class="mt-1 font-medium">{project.dailyJobQuota === undefined ? 'No limit' : fmtNumber(project.dailyJobQuota, 0)}</div></div>
          <div class="rounded-lg bg-muted/40 px-3 py-2"><div class="text-muted-foreground">Concurrent jobs</div><div class="mt-1 font-medium">{project.maxConcurrentJobs === undefined ? 'No limit' : fmtNumber(project.maxConcurrentJobs, 0)}</div></div>
        </div>
      </Card>
    {/each}
  </div>
{/if}

{#if canManage}
  <Dialog open={dialogOpen} onOpenChange={(open) => (dialogOpen = open)} class="max-h-[90vh] overflow-y-auto sm:max-w-xl">
    <div class="mb-4">
      <h2 class="text-base font-semibold">{editingProject ? 'Edit project' : 'Create project'}</h2>
      <p class="mt-1 text-xs text-muted-foreground">Members can see jobs and artifacts in this project. Quotas apply to new work submitted here.</p>
    </div>
    <label for="project-name" class="mb-1 block text-xs text-muted-foreground">Name</label>
    <Input id="project-name" bind:value={name} maxlength={80} placeholder="Project name" />
    <label for="project-description" class="mb-1 mt-3 block text-xs text-muted-foreground">Description</label>
    <textarea id="project-description" bind:value={description} maxlength={240} rows="2" class="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none" placeholder="What this project is for"></textarea>
    {#if !editingProject?.isDefault}
      <div class="mt-4">
        <div class="mb-2 text-xs font-medium">Members</div>
        {#if members.length === 0}
          <div class="text-xs text-muted-foreground">No authorized user accounts are available to assign.</div>
        {:else}
          <div class="max-h-48 overflow-y-auto rounded-lg border border-border/70">
            {#each members as member (member.id)}
              <label class="flex items-center gap-3 border-b border-border/50 px-3 py-2 last:border-b-0">
                <Checkbox checked={memberIds.includes(member.id)} onCheckedChange={() => toggleMember(member.id)} aria-label="Assign {member.displayName}" />
                {#if member.avatarUrl}<img src={member.avatarUrl} alt="" class="size-7 rounded-full" />{/if}
                <span class="min-w-0"><span class="block truncate text-sm" data-sensitive="true">{member.displayName}</span><span class="block truncate text-xs text-muted-foreground" data-sensitive="true">@{member.username}</span></span>
              </label>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <div class="mt-4 grid gap-3 sm:grid-cols-3">
      <div><label for="project-storage-quota" class="mb-1 block text-xs text-muted-foreground">Storage quota (bytes)</label><Input id="project-storage-quota" type="number" min="1" bind:value={storageQuota} placeholder="No limit" /></div>
      <div><label for="project-daily-quota" class="mb-1 block text-xs text-muted-foreground">Daily jobs</label><Input id="project-daily-quota" type="number" min="1" bind:value={dailyJobQuota} placeholder="No limit" /></div>
      <div><label for="project-concurrency-quota" class="mb-1 block text-xs text-muted-foreground">Concurrent jobs</label><Input id="project-concurrency-quota" type="number" min="1" bind:value={concurrentJobQuota} placeholder="No limit" /></div>
    </div>
    <div class="mt-5 flex justify-end gap-2">
      <Button variant="secondary" onclick={() => (dialogOpen = false)}>Cancel</Button>
      <Button loading={saving} disabled={!name.trim()} onclick={() => void save()}>Save project</Button>
    </div>
  </Dialog>
{/if}
