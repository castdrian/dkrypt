<script lang="ts">
  import Card from '#lib/components/ui/Card.svelte';
  import CopyButton from '#components/CopyButton.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { sessionState } from '#lib/session.svelte';

  type RequestKind = 'decrypt' | 'resolve' | 'job' | 'artifact';

  let kind = $state<RequestKind>('decrypt');
  let bundleId = $state('com.example.app');
  let channel = $state<'appstore' | 'testflight'>('appstore');
  let version = $state('');
  let jobId = $state('');
  let artifactId = $state('');

  const baseUrl = $derived((sessionState.publicBaseUrl ?? (typeof window === 'undefined' ? 'https://ipa.dylib.dev' : window.location.origin)).replace(/\/$/, ''));
  const request = $derived.by(() => {
    if (kind === 'job') return { method: 'GET', path: `/v1/jobs/${encodeURIComponent(jobId || 'JOB_ID')}`, body: undefined };
    if (kind === 'artifact') return { method: 'GET', path: `/v1/artifacts/${encodeURIComponent(artifactId || 'ARTIFACT_ID')}/file`, body: undefined };
    const body = { bundleId: bundleId.trim() || 'com.example.app', channel, ...(version.trim() ? { version: version.trim() } : {}), ...(kind === 'resolve' ? { resolveOnly: true } : {}) };
    return { method: 'POST', path: '/v1/decrypts', body };
  });
  const curlCommand = $derived.by(() => {
    const url = `${baseUrl}${request.path}`;
    const headers = '-H "Authorization: Bearer $DKRYPT_API_KEY"';
    if (request.method === 'GET') return `curl --fail-with-body ${headers} "${url}"${kind === 'artifact' ? ' -o app.ipa' : ''}`;
    return [`curl --fail-with-body -X POST ${headers} -H "Content-Type: application/json" \\`, `  "${url}" \\`, `  -d '${JSON.stringify(request.body)}'`].join('\n');
  });
  const javascript = $derived.by(() => {
    const body = request.body ? `,\n  body: JSON.stringify(${JSON.stringify(request.body, null, 2).replaceAll('\n', '\n  ')})` : '';
    const responseHandling = kind === 'artifact' ? 'const { writeFile } = await import("node:fs/promises");\nawait writeFile("app.ipa", Buffer.from(await response.arrayBuffer()));' : 'const result = await response.json();\nconsole.log(result);';
    return `const response = await fetch("${baseUrl}${request.path}", {\n  method: "${request.method}",\n  headers: { Authorization: \`Bearer \${process.env.DKRYPT_API_KEY}\`, ...(\n    ${request.body ? '{ "Content-Type": "application/json" }' : '{}'}\n  ) }${body}\n});\nif (!response.ok) throw new Error(\`dkrypt returned \${response.status}: \${await response.text()}\`);\n${responseHandling}`;
  });
</script>

<Card title="API request builder">
  <p class="text-xs text-muted">Build a ready-to-copy request for dkrypt’s public API. Keep your API key in an environment variable; it is never entered or saved here.</p>
  <div class="mt-3 grid gap-3 sm:grid-cols-2">
    <label class="grid gap-1 text-xs">Request<select class="h-9 rounded-md border border-border bg-background px-2" bind:value={kind}><option value="decrypt">Submit a decrypt</option><option value="resolve">Resolve without queueing</option><option value="job">Check a job</option><option value="artifact">Download an artifact</option></select></label>
    {#if kind === 'decrypt' || kind === 'resolve'}
      <label class="grid gap-1 text-xs">Channel<select class="h-9 rounded-md border border-border bg-background px-2" bind:value={channel}><option value="appstore">App Store</option><option value="testflight">TestFlight</option></select></label>
      <label class="grid gap-1 text-xs">Bundle ID<Input bind:value={bundleId} placeholder="com.example.app" /></label>
      <label class="grid gap-1 text-xs">Exact version (optional)<Input bind:value={version} placeholder={channel === 'testflight' ? '352.0_118977' : '350.0'} /></label>
    {:else if kind === 'job'}
      <label class="grid gap-1 text-xs">Job ID<Input bind:value={jobId} placeholder="job-id" /></label>
    {:else}
      <label class="grid gap-1 text-xs">Artifact ID<Input bind:value={artifactId} placeholder="artifact-id" /></label>
    {/if}
  </div>
  <div class="mt-3 space-y-2">
    <div class="rounded-lg border border-border/70 bg-background p-3"><div class="mb-2 flex items-center justify-between gap-2"><span class="text-[11px] font-medium text-muted">curl</span><CopyButton text={curlCommand} label="Copy curl" /></div><pre class="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5">{curlCommand}</pre></div>
    <div class="rounded-lg border border-border/70 bg-background p-3"><div class="mb-2 flex items-center justify-between gap-2"><span class="text-[11px] font-medium text-muted">JavaScript</span><CopyButton text={javascript} label="Copy JavaScript" /></div><pre class="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5">{javascript}</pre></div>
  </div>
</Card>
