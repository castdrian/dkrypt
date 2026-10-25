<script lang="ts">
  import { ExternalLink } from 'lucide-svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
</script>

<section class="flex min-w-0 flex-col gap-3">
  <div class="flex min-w-0 items-center justify-between gap-3">
    <div class="min-w-0">
      <h1 class="text-base font-semibold">API documentation</h1>
      <p class="mt-1 text-muted text-sm">Browse and try the public API on this dkrypt instance. Add an API key in Scalar’s authorization panel. Decrypt requests create real jobs and use your account’s allowance.</p>
    </div>
    <a href="/reference/" target="_blank" rel="noopener noreferrer" class={buttonVariants('secondary', 'sm')}>
      <ExternalLink class="h-4 w-4" />Open API reference in new tab
    </a>
  </div>
  <div class="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-background">
    <iframe
      src="/reference/"
      title="dkrypt API reference"
      loading="lazy"
      referrerpolicy="same-origin"
      class="block h-[min(78vh,58rem)] min-h-[36rem] w-full border-0"
    ></iframe>
  </div>
</section>
