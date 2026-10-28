<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, CircleAlert, FolderCheck, FolderOpen, Info, RefreshCw, Trash2 } from 'lucide-svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { automaticDownloadFolderName, automaticDownloadsEnabled, automaticDownloadsSupported, chooseAutomaticDownloadFolder, clearAutomaticDownloadFolder, setAutomaticDownloadsEnabled } from '#lib/automaticDownloads';

  let supported = $state(false);
  let enabled = $state(false);
  let folderName = $state('');
  let error = $state('');
  let busy = $state(false);
  type RemoteDestination = { provider: 'webdav' | 's3'; endpoint: string; prefix: string; enabled: boolean; username?: string; bucket?: string; region?: string; secretConfigured: boolean; accessKeyHint?: string };
  type Delivery = { id: string; jobId: string; fileName: string; status: 'pending' | 'delivered' | 'failed'; attempts: number; updatedAt: number; nextAttemptAt?: number; remotePath?: string; error?: string };
  let remoteDestination = $state<RemoteDestination>();
  let deliveries = $state<Delivery[]>([]);
  let remoteProvider = $state<'webdav' | 's3'>('s3');
  let endpoint = $state('');
  let prefix = $state('');
  let username = $state('');
  let password = $state('');
  let accessKey = $state('');
  let secretKey = $state('');
  let bucket = $state('');
  let region = $state('auto');
  let remoteEnabled = $state(false);
  let remoteBusy = $state(false);
  let testingRemote = $state(false);
  let remoteMessage = $state('');
  let remoteError = $state('');
  const savedRemoteSecret = $derived(remoteDestination?.provider === remoteProvider && remoteDestination.secretConfigured);

  onMount(() => {
    supported = automaticDownloadsSupported();
    enabled = automaticDownloadsEnabled();
    void automaticDownloadFolderName().then((name) => (folderName = name ?? '')).catch(() => {
      error = 'Could not read the selected folder. Choose it again to restore automatic downloads.';
    });
    void loadRemoteDestination();
  });

  async function loadRemoteDestination(): Promise<void> {
    try {
      const response = await fetch('/v1/dashboard/download-destination', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json() as { destination?: RemoteDestination; deliveries?: Delivery[] };
      remoteDestination = data.destination;
      deliveries = data.deliveries ?? [];
      if (!remoteDestination) return;
      remoteProvider = remoteDestination.provider;
      endpoint = remoteDestination.endpoint;
      prefix = remoteDestination.prefix ?? '';
      username = remoteDestination.username ?? '';
      bucket = remoteDestination.bucket ?? '';
      region = remoteDestination.region ?? 'auto';
      remoteEnabled = remoteDestination.enabled;
    } catch {
      remoteError = 'Could not load the saved cloud destination.';
    }
  }

  async function saveRemoteDestination(): Promise<void> {
    remoteBusy = true;
    remoteError = '';
    remoteMessage = '';
    try {
      const body = remoteProvider === 'webdav'
        ? { provider: remoteProvider, endpoint, prefix, username, password: password || undefined, enabled: remoteEnabled }
        : { provider: remoteProvider, endpoint, prefix, accessKey: accessKey || undefined, secretKey: secretKey || undefined, bucket, region, enabled: remoteEnabled };
      const response = await fetch('/v1/dashboard/download-destination', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message ?? 'Could not save the destination.');
      remoteDestination = data.destination as RemoteDestination;
      password = '';
      accessKey = '';
      secretKey = '';
      remoteMessage = 'Destination saved. New completed IPAs will be sent there when automatic delivery is enabled.';
    } catch (cause) {
      remoteError = cause instanceof Error ? cause.message : 'Could not save the destination.';
    } finally {
      remoteBusy = false;
    }
  }

  async function testRemoteDestination(): Promise<void> {
    testingRemote = true;
    remoteError = '';
    remoteMessage = '';
    try {
      const response = await fetch('/v1/dashboard/download-destination/test', { method: 'POST', credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message ?? 'Destination check failed.');
      remoteMessage = 'Connection works. The temporary check file was removed.';
    } catch (cause) {
      remoteError = cause instanceof Error ? cause.message : 'Destination check failed.';
    } finally {
      testingRemote = false;
    }
  }

  async function removeRemoteDestination(): Promise<void> {
    remoteBusy = true;
    remoteError = '';
    try {
      const response = await fetch('/v1/dashboard/download-destination', { method: 'DELETE', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Could not remove the destination.');
      remoteDestination = undefined;
      remoteProvider = 's3';
      endpoint = '';
      prefix = '';
      username = '';
      bucket = '';
      region = 'auto';
      remoteEnabled = false;
      remoteMessage = 'Cloud destination removed.';
    } catch (cause) {
      remoteError = cause instanceof Error ? cause.message : 'Could not remove the destination.';
    } finally {
      remoteBusy = false;
    }
  }

  async function retryDelivery(id: string): Promise<void> {
    remoteBusy = true;
    remoteError = '';
    try {
      const response = await fetch(`/v1/dashboard/download-destination/deliveries/${encodeURIComponent(id)}/retry`, { method: 'POST', credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message ?? 'Could not retry this delivery.');
      await loadRemoteDestination();
    } catch (cause) {
      remoteError = cause instanceof Error ? cause.message : 'Could not retry this delivery.';
    } finally {
      remoteBusy = false;
    }
  }

  async function chooseFolder(): Promise<void> {
    busy = true;
    error = '';
    try {
      folderName = await chooseAutomaticDownloadFolder();
      enabled = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not select a download folder.';
    } finally {
      busy = false;
    }
  }

  async function clearFolder(): Promise<void> {
    try {
      await clearAutomaticDownloadFolder();
      folderName = '';
      enabled = false;
      error = '';
    } catch {
      error = 'Could not clear the selected folder.';
    }
  }

  function toggleEnabled(event: Event): void {
    enabled = (event.currentTarget as HTMLInputElement).checked;
    setAutomaticDownloadsEnabled(enabled);
  }
</script>

<Card class="p-5 sm:p-6">
  <div class="flex items-start gap-3">
    <div class="rounded-xl bg-accent/10 p-2.5 text-accent"><FolderCheck class="h-5 w-5" /></div>
    <div class="min-w-0 flex-1">
      <h2 class="text-base font-semibold">Automatic downloads</h2>
      <p class="mt-1 text-sm text-muted">Save completed IPAs to a folder on this computer while dkrypt is open.</p>
    </div>
  </div>

  {#if supported}
    <div class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 py-3">
      <div class="min-w-0">
        <div class="text-sm font-medium">{folderName || 'No folder selected'}</div>
        <div class="mt-1 text-xs text-muted">{folderName ? 'Newly completed IPA files are saved here.' : 'Choose where new results should be saved.'}</div>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Button variant="secondary" size="sm" loading={busy} onclick={() => void chooseFolder()}><FolderOpen class="h-4 w-4" />{folderName ? 'Change folder' : 'Choose folder'}</Button>
        {#if folderName}<Button variant="ghost" size="sm" aria-label="Clear selected folder" onclick={() => void clearFolder()}><Trash2 class="h-4 w-4" /></Button>{/if}
      </div>
    </div>
    {#if folderName}
      <label class="mt-4 flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <input type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" checked={enabled} onchange={toggleEnabled} />
        Automatically save each completed IPA
      </label>
    {/if}
    <Alert variant="default" class="mt-4"><Info class="h-4 w-4" /><span>On a Mac, choose a folder inside iCloud Drive to have Apple sync the files. Other synced folders work too. The browser must remain open while a job finishes. iPhone and iPad browsers can use the Share button to save to Files.</span></Alert>
  {:else}
    <Alert variant="default" class="mt-5"><Info class="h-4 w-4" /><span>This browser does not support automatic folder access. You can still download each result or use the Share button to save it to Files, iCloud Drive, or another app.</span></Alert>
  {/if}
  {#if error}<p class="mt-3 text-sm text-err" role="alert">{error}</p>{/if}
</Card>

<Card class="mt-4 p-5 sm:p-6">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h2 class="text-base font-semibold">Cloud delivery</h2>
      <p class="mt-1 max-w-2xl text-sm text-muted">Send completed IPA files directly to your S3-compatible storage, including Cloudflare R2, or a WebDAV folder. Credentials are encrypted in dkrypt and never shown again.</p>
    </div>
    {#if remoteDestination}<span class="rounded-full border border-border px-2.5 py-1 text-xs text-muted">{remoteDestination.enabled ? 'Automatic delivery on' : 'Saved · delivery off'}</span>{/if}
  </div>

  <div class="mt-5 grid gap-3 sm:grid-cols-2">
    <label class="grid gap-1.5 text-xs font-medium">Provider
      <select bind:value={remoteProvider} class="min-h-10 rounded-lg border border-border bg-background px-3 text-sm">
        <option value="s3">S3-compatible storage (AWS S3 / Cloudflare R2)</option>
        <option value="webdav">WebDAV</option>
      </select>
    </label>
    <label class="grid gap-1.5 text-xs font-medium">{remoteProvider === 's3' ? 'HTTPS endpoint' : 'WebDAV folder URL'}
      <input bind:value={endpoint} class="min-h-10 rounded-lg border border-border bg-background px-3 text-sm" placeholder={remoteProvider === 's3' ? 'https://s3.eu-central-1.amazonaws.com' : 'https://cloud.example.com/remote.php/dav/files/name/'} autocomplete="url" />
    </label>
    <label class="grid gap-1.5 text-xs font-medium">Folder prefix
      <input bind:value={prefix} class="min-h-10 rounded-lg border border-border bg-background px-3 text-sm" placeholder="dkrypt" />
    </label>
    {#if remoteProvider === 's3'}
      <label class="grid gap-1.5 text-xs font-medium">Bucket
        <input bind:value={bucket} class="min-h-10 rounded-lg border border-border bg-background px-3 text-sm" autocomplete="off" />
      </label>
      <label class="grid gap-1.5 text-xs font-medium">Region <input bind:value={region} class="min-h-10 rounded-lg border border-border bg-background px-3 text-sm" placeholder="auto for R2" autocomplete="off" /></label>
      <label class="grid gap-1.5 text-xs font-medium">Access key ID <input bind:value={accessKey} class="min-h-10 rounded-lg border border-border bg-background px-3 text-sm" placeholder={remoteDestination?.accessKeyHint ?? 'Enter access key'} autocomplete="off" /></label>
      <label class="grid gap-1.5 text-xs font-medium">Secret access key <input bind:value={secretKey} type="password" class="min-h-10 rounded-lg border border-border bg-background px-3 text-sm" placeholder={savedRemoteSecret ? 'Saved securely · leave blank to keep' : 'Enter secret key'} autocomplete="new-password" /></label>
    {:else}
      <label class="grid gap-1.5 text-xs font-medium">Username <input bind:value={username} class="min-h-10 rounded-lg border border-border bg-background px-3 text-sm" autocomplete="username" /></label>
      <label class="grid gap-1.5 text-xs font-medium">Password <input bind:value={password} type="password" class="min-h-10 rounded-lg border border-border bg-background px-3 text-sm" placeholder={savedRemoteSecret ? 'Saved securely · leave blank to keep' : 'Enter password'} autocomplete="new-password" /></label>
    {/if}
  </div>

  <label class="mt-4 flex min-h-10 cursor-pointer items-center gap-3 text-sm"><input type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" bind:checked={remoteEnabled} />Automatically deliver completed IPA files</label>
  <p class="mt-1 text-xs text-muted">Only new completed, retained library artifacts are sent. Existing files are not uploaded retroactively. You can turn delivery off or remove the destination at any time.</p>

  <div class="mt-4 flex flex-wrap gap-2">
    <Button loading={remoteBusy} onclick={() => void saveRemoteDestination()}>{remoteDestination ? 'Save destination' : 'Save destination'}</Button>
    {#if remoteDestination}<Button variant="secondary" loading={testingRemote} disabled={remoteBusy} onclick={() => void testRemoteDestination()}><Check class="h-4 w-4" />Test connection</Button><Button variant="ghost" disabled={remoteBusy} onclick={() => void removeRemoteDestination()}><Trash2 class="h-4 w-4" />Remove</Button>{/if}
  </div>
  {#if remoteMessage}<p class="mt-3 flex items-center gap-2 text-sm text-ok" role="status"><Check class="h-4 w-4" />{remoteMessage}</p>{/if}
  {#if remoteError}<p class="mt-3 flex items-center gap-2 text-sm text-err" role="alert"><CircleAlert class="h-4 w-4" />{remoteError}</p>{/if}

  {#if deliveries.length}
    <div class="mt-5 border-t border-border pt-4">
      <h3 class="text-sm font-medium">Recent deliveries</h3>
      <ul class="mt-2 divide-y divide-border/70">
        {#each deliveries as delivery (delivery.id)}
          <li class="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
            <span class="min-w-0"><span class="block truncate font-medium">{delivery.fileName}</span><span class="text-muted">{delivery.status === 'delivered' ? 'Delivered' : delivery.status === 'pending' ? 'Sending' : delivery.error ?? 'Delivery failed'} · {new Date(delivery.updatedAt).toLocaleString()}</span></span>
            {#if delivery.status === 'failed'}<Button size="sm" variant="secondary" disabled={remoteBusy} onclick={() => void retryDelivery(delivery.id)}><RefreshCw class="h-3.5 w-3.5" />Retry</Button>{/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</Card>
