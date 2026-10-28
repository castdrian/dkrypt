<script lang="ts">
  import { ArrowLeft, Check, CircleDashed, Download, LockKeyhole, Sparkles, Timer } from 'lucide-svelte';
  import { onDestroy } from 'svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';

  type DemoStatus = 'ready' | 'queued' | 'decrypting' | 'complete';
  let status = $state<DemoStatus>('ready');
  let stageIndex = $state(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stages = ['Waiting in queue', 'Preparing the IPA', 'Verifying the result'];
  const progress = $derived(status === 'queued' ? 8 : status === 'decrypting' ? [34, 68, 91][stageIndex] ?? 91 : status === 'complete' ? 100 : 0);

  function startDemo(): void {
    clearTimeout(timer);
    stageIndex = 0;
    status = 'queued';
    timer = setTimeout(() => {
      status = 'decrypting';
      advanceStage();
    }, 650);
  }

  function advanceStage(): void {
    if (stageIndex >= stages.length - 1) {
      timer = setTimeout(() => (status = 'complete'), 900);
      return;
    }
    timer = setTimeout(() => {
      stageIndex += 1;
      advanceStage();
    }, 1000);
  }

  onDestroy(() => clearTimeout(timer));
</script>

<main class="min-h-screen bg-background px-4 py-8 text-text sm:px-8 sm:py-12">
  <div class="mx-auto max-w-5xl">
    <header class="mb-8 flex flex-wrap items-center justify-between gap-3">
      <a href="/" class="inline-flex min-h-10 items-center gap-2 text-sm text-muted hover:text-text"><ArrowLeft class="h-4 w-4" />Back to sign in</a>
      <Badge variant="secondary"><Sparkles class="mr-1 h-3.5 w-3.5" />Interactive demo</Badge>
    </header>

    <section class="mb-7 max-w-2xl">
      <p class="text-xs font-semibold uppercase tracking-[0.16em] text-accent">See how dkrypt works</p>
      <h1 class="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">A decrypt flow, without the wait.</h1>
      <p class="mt-3 text-sm leading-6 text-muted sm:text-base">Explore a safe, simulated job from submission to download. This demo uses sample data only; it does not contact Apple, use a device, or create a real job.</p>
    </section>

    <div class="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(16rem,0.65fr)]">
      <section class="rounded-2xl border border-border bg-panel p-5 shadow-lg sm:p-7" aria-label="Simulated decrypt job">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="text-xs text-muted">App Store · sample app</div>
            <h2 class="mt-1 text-lg font-semibold">Example App <span class="font-normal text-muted">1.2.0</span></h2>
            <div class="mt-1 font-mono text-xs text-muted">com.example.sampleapp</div>
          </div>
          <Badge variant={status === 'complete' ? 'success' : 'secondary'}>{status === 'complete' ? 'Ready' : status === 'ready' ? 'Preview' : 'In progress'}</Badge>
        </div>

        <div class="mt-7 rounded-xl border border-border/70 bg-background/70 p-4 sm:p-5">
          <div class="flex items-center justify-between gap-3 text-sm">
            <span class="font-medium">{status === 'ready' ? 'Ready to start' : status === 'complete' ? 'Decrypt complete' : stages[stageIndex] ?? stages[0]}</span>
            <span class="tabular-nums text-muted">{progress}%</span>
          </div>
          <div class="mt-3 h-2 overflow-hidden rounded-full bg-panel-muted"><div class="h-full rounded-full bg-accent transition-all duration-700" style={`width: ${progress}%`}></div></div>
          <div class="mt-4 grid gap-2 sm:grid-cols-3">
            {#each stages as stage, index}
              <div class="flex items-center gap-2 text-xs {status === 'complete' || (status === 'decrypting' && index <= stageIndex) ? 'text-ok' : 'text-muted'}">
                {#if status === 'complete' || (status === 'decrypting' && index < stageIndex)}<Check class="h-3.5 w-3.5 shrink-0" />{:else if status === 'decrypting' && index === stageIndex}<CircleDashed class="h-3.5 w-3.5 shrink-0 animate-spin" />{:else}<span class="h-3.5 w-3.5 shrink-0 rounded-full border border-current"></span>{/if}
                <span>{stage}</span>
              </div>
            {/each}
          </div>
        </div>

        {#if status === 'complete'}
          <div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ok/25 bg-ok/5 p-4">
            <div class="flex items-center gap-3"><div class="rounded-lg bg-ok/10 p-2 text-ok"><Check class="h-5 w-5" /></div><div><div class="text-sm font-medium">Sample IPA is ready</div><div class="text-xs text-muted">148.2 MB · SHA-256 verified</div></div></div>
            <span class="inline-flex items-center gap-2 text-xs text-muted"><LockKeyhole class="h-3.5 w-3.5" />Demo only</span>
          </div>
        {/if}

        <div class="mt-5 flex flex-wrap gap-2">
          <button type="button" class={buttonVariants('default', 'sm')} onclick={startDemo} disabled={status === 'queued' || status === 'decrypting'}>{#if status === 'complete'}Run it again{:else}Start sample decrypt{/if}</button>
          <a href="/pricing" class={buttonVariants('secondary', 'sm')}>View plans</a>
        </div>
      </section>

      <aside class="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <section class="rounded-2xl border border-border bg-panel p-5">
          <div class="flex items-center gap-2 text-sm font-medium"><Timer class="h-4 w-4 text-accent" />What happens next</div>
          <p class="mt-3 text-sm leading-6 text-muted">dkrypt checks the selected release, queues the work, decrypts and verifies the IPA, then gives you a download link.</p>
        </section>
        <section class="rounded-2xl border border-border bg-panel p-5">
          <div class="flex items-center gap-2 text-sm font-medium"><Download class="h-4 w-4 text-accent" />Your file stays yours</div>
          <p class="mt-3 text-sm leading-6 text-muted">Real results are available in your account according to your plan’s retention and library access.</p>
        </section>
        <section class="rounded-2xl border border-accent/20 bg-accent/5 p-5 sm:col-span-2 lg:col-span-1">
          <div class="text-sm font-medium">Ready to try dkrypt?</div>
          <p class="mt-2 text-sm leading-6 text-muted">Create an account to submit your first real decrypt.</p>
          <a href="/" class={buttonVariants('default', 'sm') + ' mt-4'}>Sign in or create account</a>
        </section>
      </aside>
    </div>
  </div>
</main>
