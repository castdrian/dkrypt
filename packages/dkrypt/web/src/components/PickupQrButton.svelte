<script lang="ts">
  import { QrCode } from 'lucide-svelte';
  import CopyButton from '#components/CopyButton.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import { createPickupLink } from '#lib/api';
  import { showToast } from '#lib/ui.svelte';

  let { artifactId, jobId, label, compact = false }: { artifactId?: string; jobId?: string; label?: string; compact?: boolean } = $props();
  let open = $state(false);
  let loading = $state(false);
  let pickupUrl = $state('');
  let qrImage = $state('');
  let expiresAt = $state<number>();
  let fileName = $state('app.ipa');

  async function createQr(): Promise<void> {
    if (loading || (!artifactId && !jobId)) return;
    loading = true;
    try {
      const pickup = await createPickupLink({ artifactId, jobId });
      pickupUrl = pickup.url;
      expiresAt = pickup.expiresAt;
      fileName = pickup.fileName;
      const { default: QRCode } = await import('qrcode');
      qrImage = await QRCode.toDataURL(pickup.url, { width: 256, margin: 2, errorCorrectionLevel: 'M' });
      open = true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create a pickup QR code.', 'error');
    } finally {
      loading = false;
    }
  }

  function close(): void {
    open = false;
    pickupUrl = '';
    qrImage = '';
    expiresAt = undefined;
  }
</script>

<Button variant="secondary" size={label ? 'sm' : 'icon'} class={compact ? 'h-8 w-8 shrink-0' : ''} aria-label="Show download QR code" title="Show download QR code" loading={loading} disabled={!artifactId && !jobId} onclick={() => void createQr()}><QrCode class="h-4 w-4" />{#if label}{label}{/if}</Button>

<Dialog {open} onOpenChange={(value) => { if (value) open = true; else close(); }} title="Download on another device" class="max-w-sm">
  <div class="text-center">
    <h2 class="text-base font-semibold">Download on another device</h2>
    <p class="mt-1 text-sm text-muted">Scan with your phone or tablet camera to download {fileName}.</p>
    {#if qrImage}
      <img src={qrImage} alt="QR code for downloading this IPA" class="mx-auto mt-4 h-64 w-64 max-w-full rounded-xl bg-white p-2" />
    {/if}
    {#if expiresAt}
      <p class="mt-3 text-xs text-muted">This link expires at {new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(expiresAt)}.</p>
    {/if}
    <div class="mt-4 flex justify-center gap-2">
      <CopyButton text={pickupUrl} label="Copy link" />
      <a class={buttonVariants('secondary', 'sm')} href={pickupUrl}>Download here</a>
      <Button variant="ghost" size="sm" onclick={close}>Done</Button>
    </div>
    <p class="mt-3 text-[11px] text-muted">Anyone with the link can download it until it expires.</p>
  </div>
</Dialog>
