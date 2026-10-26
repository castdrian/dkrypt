<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { IpaAnalysisReport } from '#lib/api';
  import { fmtSize, fmtTime } from '#lib/format.svelte';

  let { report, previewAsset }: { report: IpaAnalysisReport; previewAsset?: (path: string) => Promise<Blob> } = $props();
  let assetQuery = $state('');
  let previewPath = $state('');
  let previewUrl = $state('');
  let previewError = $state('');
  let previewLoading = $state(false);
  let previewRequest = 0;
  const visibleAssets = $derived(report.assets.filter((asset) => asset.path.toLowerCase().includes(assetQuery.trim().toLowerCase())));

  function clearPreview(): void {
    previewRequest += 1;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    previewPath = '';
    previewError = '';
    previewLoading = false;
  }

  async function openPreview(path: string): Promise<void> {
    if (!previewAsset) return;
    const requestId = ++previewRequest;
    previewLoading = true;
    previewError = '';
    previewPath = path;
    try {
      const blob = await previewAsset(path);
      if (requestId !== previewRequest) return;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
    } catch (error) {
      if (requestId === previewRequest) previewError = error instanceof Error ? error.message : 'Could not preview this image';
    } finally {
      if (requestId === previewRequest) previewLoading = false;
    }
  }

  onDestroy(clearPreview);
</script>

<div class="space-y-4">
  <section class="rounded-xl border border-border/70 p-4" aria-labelledby="ipa-compatibility-title">
    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h3 id="ipa-compatibility-title" class="text-sm font-semibold">Executable compatibility</h3>
      <span class="text-xs text-muted">{report.executables.length} binaries · {report.totalFiles} files inspected</span>
    </div>
    {#if report.executables.length === 0}
      <p class="text-xs text-muted">No Mach-O executables were identified in this IPA.</p>
    {:else}
      <ul class="space-y-2">
        {#each report.executables as executable (executable.path)}
          <li class="rounded-lg bg-panel-muted/40 p-3">
            <div class="break-all font-mono text-[11px]" data-sensitive="true">{executable.path}</div>
            {#if executable.bundleId}<div class="mt-1 break-all font-mono text-[11px] text-muted" data-sensitive="true">{executable.bundleId}</div>{/if}
            {#if executable.analysisState === 'analyzed'}
              <div class="mt-2 grid gap-2 sm:grid-cols-2">
                {#each executable.slices as slice, index (`${executable.path}-${slice.architecture}-${index}`)}
                  <div class="rounded-md border border-border/60 bg-background/50 p-2 text-[11px]">
                    <div class="font-medium">{slice.architecture}{slice.platform ? ` · ${slice.platform}` : ''}</div>
                    <div class="mt-1 text-muted">Minimum OS {slice.minimumOsVersion ?? 'unknown'} · SDK {slice.sdkVersion ?? 'unknown'}</div>
                  </div>
                {/each}
              </div>
            {:else if executable.analysisState === 'too_large'}
              <p class="mt-1 text-xs text-muted">This binary exceeded the per-file analysis limit.</p>
            {:else}
              <p class="mt-1 text-xs text-muted">The executable header is malformed or unsupported.</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="rounded-xl border border-border/70 p-4" aria-labelledby="ipa-signing-title">
    <h3 id="ipa-signing-title" class="mb-3 text-sm font-semibold">Signing and provisioning</h3>
    {#if report.signing.profiles.length === 0 && report.signing.signatureFiles.length === 0}
      <p class="text-xs text-muted">No embedded provisioning profiles or code-signature files were found.</p>
    {/if}
    {#each report.signing.profiles as profile (profile.path)}
      <dl class="grid gap-x-4 gap-y-2 rounded-lg bg-panel-muted/40 p-3 text-xs sm:grid-cols-2">
        <div><dt class="text-muted">Profile</dt><dd class="mt-0.5 break-words font-medium">{profile.name ?? 'Unnamed'}</dd></div>
        <div><dt class="text-muted">Distribution</dt><dd class="mt-0.5 font-medium">{profile.distribution.replace('_', ' ')}</dd></div>
        <div><dt class="text-muted">Team</dt><dd class="mt-0.5 break-all font-mono" data-sensitive="true">{profile.teamIdentifiers.join(', ') || 'Unavailable'}</dd></div>
        <div><dt class="text-muted">Platforms</dt><dd class="mt-0.5">{profile.platforms.join(', ') || 'Unavailable'}</dd></div>
        <div><dt class="text-muted">Created</dt><dd class="mt-0.5">{profile.createdAt ? fmtTime(Date.parse(profile.createdAt)) : 'Unavailable'}</dd></div>
        <div><dt class="text-muted">Expires</dt><dd class="mt-0.5">{profile.expiresAt ? fmtTime(Date.parse(profile.expiresAt)) : 'Unavailable'}</dd></div>
        {#if profile.provisionedDeviceCount !== undefined}<div><dt class="text-muted">Registered devices</dt><dd class="mt-0.5">{profile.provisionedDeviceCount}</dd></div>{/if}
        {#if profile.applicationIdentifier}<div class="sm:col-span-2"><dt class="text-muted">Application identifier</dt><dd class="mt-0.5 break-all font-mono" data-sensitive="true">{profile.applicationIdentifier}</dd></div>{/if}
      </dl>
    {/each}
    {#if report.signing.signatureFiles.length > 0}
      <details class="mt-3 text-xs">
        <summary class="cursor-pointer font-medium">Signature files ({report.signing.signatureFiles.length})</summary>
        <ul class="mt-2 max-h-36 space-y-1 overflow-auto font-mono text-[11px] text-muted">
          {#each report.signing.signatureFiles as file (file)}<li class="break-all">{file}</li>{/each}
        </ul>
      </details>
    {/if}
    <p class="mt-3 text-[11px] text-muted">Certificate identity details aren’t present in the available profile data; this report does not verify the signature cryptographically.</p>
  </section>

  <section class="rounded-xl border border-border/70 p-4" aria-labelledby="ipa-assets-title">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <h3 id="ipa-assets-title" class="text-sm font-semibold">Asset browser</h3>
      <span class="text-xs text-muted">{report.assets.length}{report.assetsTruncated ? '+' : ''} images</span>
    </div>
    {#if report.assets.length === 0}
      <p class="text-xs text-muted">No previewable images were found.</p>
    {:else}
      <input class="mb-3 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" bind:value={assetQuery} aria-label="Filter IPA images" placeholder="Filter image paths" />
      {#if previewPath}
        <div class="mb-3 rounded-lg border border-border/70 p-3">
          <div class="mb-2 flex items-start gap-2">
            <div class="min-w-0 flex-1 break-all font-mono text-[11px]">{previewPath}</div>
            <button class="shrink-0 rounded border border-border px-2 py-1 text-xs" onclick={clearPreview}>Close preview</button>
          </div>
          {#if previewLoading}<div class="py-5 text-center text-xs text-muted" role="status">Loading image…</div>
          {:else if previewError}<p class="text-xs text-err" role="alert">{previewError}</p>
          {:else if previewUrl}<img class="mx-auto max-h-72 max-w-full rounded object-contain" src={previewUrl} alt={previewPath.split('/').at(-1) ?? 'IPA asset'} />{/if}
        </div>
      {/if}
      {#if visibleAssets.length === 0}<p class="text-xs text-muted">No images match this filter.</p>
      {:else}
        <ul class="grid max-h-72 grid-cols-2 gap-2 overflow-auto sm:grid-cols-3">
          {#each visibleAssets as asset (asset.path)}
            <li class="min-w-0 rounded-lg border border-border/70 p-2">
              {#if previewAsset}
                <button class="w-full rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" aria-label="Preview {asset.path}" aria-pressed={previewPath === asset.path} onclick={() => void openPreview(asset.path)}>
                  <div class="flex h-24 items-center justify-center rounded bg-panel-muted/50 text-xs text-muted">{previewPath === asset.path && previewUrl ? 'Preview open' : 'Preview image'}</div>
                </button>
              {/if}
              <div class="mt-2 break-all font-mono text-[10px] text-muted">{asset.path}</div>
              <div class="mt-1 text-[10px]">{fmtSize(asset.sizeBytes)}</div>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>
</div>
