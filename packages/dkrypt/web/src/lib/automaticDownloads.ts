interface DirectoryFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

interface DirectoryHandle {
  name: string;
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  getFileHandle(name: string, options: { create: boolean }): Promise<DirectoryFileHandle>;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<DirectoryHandle>;
}

const databaseName = 'dkrypt-automatic-downloads';
const databaseVersion = 1;
const directoryKey = 'destination';
const enabledKey = 'dkrypt-automatic-downloads-enabled';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open automatic download settings'));
  });
}

async function readDirectory(): Promise<DirectoryHandle | undefined> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction('settings', 'readonly').objectStore('settings').get(directoryKey);
      request.onsuccess = () => resolve(request.result as DirectoryHandle | undefined);
      request.onerror = () => reject(request.error ?? new Error('Could not read the saved folder'));
    });
  } finally {
    database.close();
  }
}

async function writeDirectory(handle: DirectoryHandle | undefined): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const store = database.transaction('settings', 'readwrite').objectStore('settings');
      const request = handle ? store.put(handle, directoryKey) : store.delete(directoryKey);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Could not save the selected folder'));
    });
  } finally {
    database.close();
  }
}

export function automaticDownloadsSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

export function automaticDownloadsEnabled(): boolean {
  return typeof window !== 'undefined' && localStorage.getItem(enabledKey) === 'true';
}

export async function automaticDownloadFolderName(): Promise<string | undefined> {
  return (await readDirectory())?.name;
}

export async function chooseAutomaticDownloadFolder(): Promise<string> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('Automatic folder downloads are unavailable in this browser.');
  const handle = await picker({ mode: 'readwrite' });
  const permission = await handle.requestPermission({ mode: 'readwrite' });
  if (permission !== 'granted') throw new Error('Allow dkrypt to write to the selected folder.');
  await writeDirectory(handle);
  localStorage.setItem(enabledKey, 'true');
  return handle.name;
}

export function setAutomaticDownloadsEnabled(enabled: boolean): void {
  if (enabled) localStorage.setItem(enabledKey, 'true');
  else localStorage.removeItem(enabledKey);
}

export async function clearAutomaticDownloadFolder(): Promise<void> {
  await writeDirectory(undefined);
  localStorage.removeItem(enabledKey);
}

export function automaticDownloadFileName(label: string, jobId: string): string {
  const appLabel = label.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 140) || 'dkrypt-result';
  return `${appLabel}_${jobId.slice(0, 8)}.ipa`;
}

export async function saveCompletedIpaToFolder(url: string, fileName: string): Promise<'disabled' | 'missing' | 'permission_required' | 'saved'> {
  if (!automaticDownloadsEnabled()) return 'disabled';
  const handle = await readDirectory();
  if (!handle) return 'missing';
  if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') return 'permission_required';
  const target = new URL(url, window.location.href);
  if (target.origin !== window.location.origin || !target.pathname.startsWith('/v1/')) throw new Error('Automatic downloads only accept dkrypt result links.');
  const response = await fetch(target, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`The result could not be downloaded (${response.status}).`);
  const file = await handle.getFileHandle(fileName, { create: true });
  await response.body.pipeTo(await file.createWritable());
  return 'saved';
}
