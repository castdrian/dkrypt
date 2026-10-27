export type BackgroundTaskStatus = 'running' | 'complete' | 'failed' | 'interrupted';
export type BackgroundTaskKind = 'device_setup' | 'device_recovery' | 'device_check' | 'export' | 'bulk';

export interface BackgroundTask {
  id: string;
  kind: BackgroundTaskKind;
  title: string;
  stage: string;
  status: BackgroundTaskStatus;
  href: string;
  startedAt: number;
  updatedAt: number;
  detail?: string;
}

export const backgroundTasksState = $state<{ ownerId: string | null; items: BackgroundTask[]; dismissedIds: string[] }>({ ownerId: null, items: [], dismissedIds: [] });

function storageKey(ownerId: string): string {
  return `dkrypt-background-tasks:${ownerId}`;
}

function save(): void {
  if (!backgroundTasksState.ownerId) return;
  try {
    localStorage.setItem(storageKey(backgroundTasksState.ownerId), JSON.stringify(backgroundTasksState.items.slice(0, 30)));
    localStorage.setItem(`${storageKey(backgroundTasksState.ownerId)}:dismissed`, JSON.stringify(backgroundTasksState.dismissedIds.slice(0, 100)));
  } catch {}
}

export function loadBackgroundTasks(ownerId: string): void {
  if (backgroundTasksState.ownerId === ownerId) return;
  backgroundTasksState.ownerId = ownerId;
  try {
    const dismissed = JSON.parse(localStorage.getItem(`${storageKey(ownerId)}:dismissed`) ?? '[]') as unknown;
    backgroundTasksState.dismissedIds = Array.isArray(dismissed) ? dismissed.filter((id): id is string => typeof id === 'string').slice(0, 100) : [];
    const parsed = JSON.parse(localStorage.getItem(storageKey(ownerId)) ?? '[]') as unknown;
    backgroundTasksState.items = Array.isArray(parsed) ? parsed.filter((item): item is BackgroundTask =>
      typeof item === 'object' && item !== null && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.startedAt === 'number' && typeof item.href === 'string' && item.href.startsWith('/') && !item.href.startsWith('//') && ['device_setup', 'device_recovery', 'device_check', 'export', 'bulk'].includes(item.kind) && ['running', 'complete', 'failed', 'interrupted'].includes(item.status),
    ).filter((item) => !backgroundTasksState.dismissedIds.includes(item.id)).slice(0, 30).map((item) => item.status === 'running' && !['device_setup', 'device_recovery'].includes(item.kind) ? { ...item, status: 'interrupted', stage: 'Page reloaded before completion' } : item) : [];
  } catch {
    backgroundTasksState.items = [];
    backgroundTasksState.dismissedIds = [];
  }
  save();
}

export function clearBackgroundTasks(): void {
  backgroundTasksState.ownerId = null;
  backgroundTasksState.items = [];
  backgroundTasksState.dismissedIds = [];
}

export function putBackgroundTask(task: BackgroundTask): void {
  if (!backgroundTasksState.ownerId) return;
  if (backgroundTasksState.dismissedIds.includes(task.id)) return;
  const existing = backgroundTasksState.items.find((item) => item.id === task.id);
  if (existing && JSON.stringify(existing) === JSON.stringify(task)) return;
  backgroundTasksState.items = [task, ...backgroundTasksState.items.filter((item) => item.id !== task.id)].slice(0, 30);
  save();
}

export function startBackgroundTask(kind: BackgroundTaskKind, title: string, stage: string, href: string, id: string = crypto.randomUUID()): string {
  const now = Date.now();
  putBackgroundTask({ id, kind, title, stage, href, status: 'running', startedAt: now, updatedAt: now });
  return id;
}

export function updateBackgroundTask(id: string, status: BackgroundTaskStatus, stage: string, detail?: string): void {
  const task = backgroundTasksState.items.find((item) => item.id === id);
  if (!task) return;
  putBackgroundTask({ ...task, status, stage, detail, updatedAt: Date.now() });
}

export function dismissBackgroundTask(id: string): void {
  if (!backgroundTasksState.dismissedIds.includes(id)) backgroundTasksState.dismissedIds = [id, ...backgroundTasksState.dismissedIds].slice(0, 100);
  backgroundTasksState.items = backgroundTasksState.items.filter((item) => item.id !== id || item.status === 'running');
  save();
}
