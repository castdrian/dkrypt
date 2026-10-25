import { untrack } from 'svelte';
import { sessionState } from '#lib/session.svelte';

export interface FormDraftRecord<T> {
  values: T;
  savedAt: number;
}

export type SyncedFormDraftKind = 'api-key' | 'device' | 'role';

interface SyncedFormDraft {
  kind: SyncedFormDraftKind;
  values: Record<string, string>;
  savedAt: number;
}

export const unsavedFormsState = $state<{ ids: string[] }>({ ids: [] });
let beforeUnloadAttached = false;
const syncedDraftTimers = new Map<string, ReturnType<typeof setTimeout>>();

function syncedDraftTimerKey(accountId: string, draftId: string): string {
  return `${accountId}:${draftId}`;
}

function scheduleSyncedDraftSave(draftId: string, kind: SyncedFormDraftKind, values: Record<string, string>, accountId: string): void {
  const key = syncedDraftTimerKey(accountId, draftId);
  const previous = syncedDraftTimers.get(key);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    syncedDraftTimers.delete(key);
    if (sessionState.sub !== accountId) return;
    void fetch(`/v1/dashboard/me/form-drafts/${encodeURIComponent(draftId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, values }),
    }).catch(() => undefined);
  }, 500);
  syncedDraftTimers.set(key, timer);
}

function preventDataLoss(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = '';
}

function updateBeforeUnloadGuard(): void {
  if (typeof window === 'undefined') return;
  const shouldAttach = untrack(() => unsavedFormsState.ids.length > 0);
  if (shouldAttach === beforeUnloadAttached) return;
  beforeUnloadAttached = shouldAttach;
  if (shouldAttach) window.addEventListener('beforeunload', preventDataLoss);
  else window.removeEventListener('beforeunload', preventDataLoss);
}

export function readFormDraft<T>(key: string): FormDraftRecord<T> | undefined {
  try {
    const value = localStorage.getItem(`dkrypt-form-draft:${key}`);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as FormDraftRecord<T>;
    return parsed && typeof parsed === 'object' && 'values' in parsed ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeFormDraft<T>(key: string, values: T): void {
  try {
    localStorage.setItem(`dkrypt-form-draft:${key}`, JSON.stringify({ values, savedAt: Date.now() } satisfies FormDraftRecord<T>));
  } catch {
    return;
  }
}

export function clearFormDraft(key: string): void {
  try {
    localStorage.removeItem(`dkrypt-form-draft:${key}`);
  } catch {
    return;
  }
}

export async function readSyncedFormDraft<T extends object>(
  draftId: string,
  kind: SyncedFormDraftKind,
  localKey: string,
): Promise<FormDraftRecord<T> | undefined> {
  const accountId = sessionState.sub;
  const local = readFormDraft<T>(localKey);
  if (!accountId || !sessionState.loggedIn) return local;
  try {
    const response = await fetch(`/v1/dashboard/me/form-drafts/${encodeURIComponent(draftId)}`);
    if (sessionState.sub !== accountId) return undefined;
    if (!response.ok) return local;
    const result = await response.json() as { draft?: SyncedFormDraft };
    const remote = result.draft;
    if (!remote || remote.kind !== kind || !remote.values || typeof remote.values !== 'object') {
      if (local) scheduleSyncedDraftSave(draftId, kind, local.values as Record<string, string>, accountId);
      return local;
    }
    const validValues = Object.values(remote.values).every((value) => typeof value === 'string');
    if (!validValues) return local;
    const remoteRecord = { values: remote.values as T, savedAt: remote.savedAt };
    if (local && local.savedAt >= remoteRecord.savedAt) {
      scheduleSyncedDraftSave(draftId, kind, local.values as Record<string, string>, accountId);
      return local;
    }
    writeFormDraft(localKey, remoteRecord.values);
    return remoteRecord;
  } catch {
    return local;
  }
}

export function writeSyncedFormDraft(draftId: string, kind: SyncedFormDraftKind, values: Record<string, string>, accountId = sessionState.sub): void {
  if (!accountId || !sessionState.loggedIn || sessionState.sub !== accountId) return;
  scheduleSyncedDraftSave(draftId, kind, values, accountId);
}

export function clearSyncedFormDraft(draftId: string, accountId = sessionState.sub): void {
  if (!accountId || !sessionState.loggedIn || sessionState.sub !== accountId) return;
  const key = syncedDraftTimerKey(accountId, draftId);
  const timer = syncedDraftTimers.get(key);
  if (timer) clearTimeout(timer);
  syncedDraftTimers.delete(key);
  void fetch(`/v1/dashboard/me/form-drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' }).catch(() => undefined);
}

export function setFormUnsaved(id: string, unsaved: boolean): void {
  const currentIds = untrack(() => unsavedFormsState.ids);
  if (currentIds.includes(id) === unsaved) return;
  if (unsaved) {
    unsavedFormsState.ids = [...currentIds, id];
    updateBeforeUnloadGuard();
    return;
  }
  unsavedFormsState.ids = currentIds.filter((current) => current !== id);
  updateBeforeUnloadGuard();
}

export function clearUnsavedFormWarnings(): void {
  unsavedFormsState.ids = [];
  updateBeforeUnloadGuard();
}
