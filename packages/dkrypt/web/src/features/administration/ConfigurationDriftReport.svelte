<script lang="ts">
  import { CircleCheck, CircleX, ScanSearch } from 'lucide-svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import type { DashboardDoctorReport } from '#lib/api';

  type Snapshot = DashboardDoctorReport['runtimeConfiguration'];
  type DriftRow = { key: string; configured: string; running: string; matches: boolean | undefined };
  type ConfigurationEntry =
    | { label: string; snapshotKey: keyof Snapshot; kind: 'boolean' | 'number' }
    | { label: string; configuredSnapshotKey: keyof Snapshot; fingerprintSnapshotKey: keyof Snapshot; kind: 'endpoint' };

  let { runtimeConfiguration }: { runtimeConfiguration: Snapshot } = $props();
  let configurationText = $state('');
  let rows = $state<DriftRow[]>([]);
  let comparedAt = $state<string>();
  let endpointFingerprints = $state<Record<string, string>>({});
  let endpointFingerprintPending = $state(false);
  let inputRevision = 0;
  const endpointFingerprintTasks = new Map<string, Promise<string | undefined>>();

  const configurationMap: Record<string, ConfigurationEntry> = {
    APPSTORE_OFFLINE_DECRYPT_ENABLED: { label: 'Off-device decrypts', snapshotKey: 'appStoreOfflineDecryptEnabled', kind: 'boolean' },
    APPSTORE_OFFLINE_MAX_WORKERS: { label: 'Off-device workers', snapshotKey: 'appStoreOfflineMaxWorkers', kind: 'number' },
    APPSTORE_OFFLINE_WORKER_MEMORY_MB: { label: 'Memory per worker', snapshotKey: 'appStoreOfflineWorkerMemoryMb', kind: 'number' },
    APPSTORE_OFFLINE_VAULT_KEY: { label: 'Encrypted Apple credential vault', snapshotKey: 'appStoreOfflineVaultConfigured', kind: 'boolean' },
    BACKUP_MANIFEST_SECRET: { label: 'Stable backup encryption secret', snapshotKey: 'backupManifestSecretConfigured', kind: 'boolean' },
    OTEL_EXPORTER_OTLP_ENDPOINT: { label: 'OTLP base endpoint', configuredSnapshotKey: 'otelBaseEndpointConfigured', fingerprintSnapshotKey: 'otelBaseEndpointFingerprint', kind: 'endpoint' },
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: { label: 'OTLP traces endpoint', configuredSnapshotKey: 'otelTracesEndpointConfigured', fingerprintSnapshotKey: 'otelTracesEndpointFingerprint', kind: 'endpoint' },
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: { label: 'OTLP metrics endpoint', configuredSnapshotKey: 'otelMetricsEndpointConfigured', fingerprintSnapshotKey: 'otelMetricsEndpointFingerprint', kind: 'endpoint' },
  };

  function isEndpointKey(key: string): boolean {
    return configurationMap[key]?.kind === 'endpoint';
  }

  function resolveValue(value: string): string {
    const unquoted = value.trim().replace(/^(['"])(.*)\1$/, '$2');
    const interpolationDefault = unquoted.match(/^\$\{[^}]+?[:-]([^}]+)\}$/)?.[1];
    return (interpolationDefault ?? unquoted).trim();
  }

  function normalizeEndpoint(value: string): string | undefined {
    const resolved = resolveValue(value);
    if (!resolved || resolved === '[configured]') return undefined;
    try {
      const endpoint = new URL(resolved);
      endpoint.username = '';
      endpoint.password = '';
      endpoint.search = '';
      endpoint.hash = '';
      return endpoint.toString();
    } catch {
      return undefined;
    }
  }

  async function fingerprintEndpoint(value: string): Promise<string | undefined> {
    const normalized = normalizeEndpoint(value);
    if (!normalized || !globalThis.crypto?.subtle) return undefined;
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      return undefined;
    }
  }

  async function handleConfigurationInput(event: Event): Promise<void> {
    const revision = ++inputRevision;
    const supplied = (event.currentTarget as HTMLTextAreaElement).value;
    const nextFingerprints = { ...endpointFingerprints };
    const digestTasks: Array<[string, Promise<string | undefined>]> = [];
    const sanitizedLines = supplied.split(/\r?\n/).map((line) => {
      const match = line.match(/^(\s*(?:-\s*)?(?:export\s+)?)([A-Z][A-Z0-9_]*)(\s*[=:]\s*)(.*)$/);
      if (!match) return line;
      const [, prefix, key, separator, rawValue] = match;
      const value = rawValue!.trim();
      if (isEndpointKey(key!)) {
        if (value === '[configured]') {
          const pending = endpointFingerprintTasks.get(key!);
          if (pending) digestTasks.push([key!, pending]);
          return `${prefix}${key}${separator}[configured]`;
        }
        if (!value) {
          delete nextFingerprints[key!];
          endpointFingerprintTasks.delete(key!);
          return `${prefix}${key}${separator}`;
        }
        delete nextFingerprints[key!];
        const task = fingerprintEndpoint(value);
        endpointFingerprintTasks.set(key!, task);
        digestTasks.push([key!, task]);
        return `${prefix}${key}${separator}[configured]`;
      }
      if (/(SECRET|TOKEN|PASSWORD|API_KEY|VAULT_KEY|HEADERS|PRIVATE)/i.test(key!)) {
        return `${prefix}${key}${separator}${value ? '[configured]' : ''}`;
      }
      return line;
    });

    endpointFingerprints = nextFingerprints;
    configurationText = sanitizedLines.join('\n');
    endpointFingerprintPending = digestTasks.length > 0;
    if (digestTasks.length === 0) return;

    const results = await Promise.all(digestTasks.map(async ([key, task]) => [key, task, await task] as const));
    if (revision !== inputRevision) return;
    const resolvedFingerprints = { ...endpointFingerprints };
    for (const [key, task, fingerprint] of results) {
      if (endpointFingerprintTasks.get(key) !== task) continue;
      endpointFingerprintTasks.delete(key);
      if (fingerprint) resolvedFingerprints[key] = fingerprint;
      else delete resolvedFingerprints[key];
    }
    endpointFingerprints = resolvedFingerprints;
    endpointFingerprintPending = false;
  }

  function normalizeValue(value: string, kind: 'boolean' | 'number'): boolean | number | undefined {
    const resolved = resolveValue(value).toLowerCase();
    if (kind === 'number') {
      const parsed = Number(resolved);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
    }
    if (['true', '1', 'yes'].includes(resolved) || resolved === '[configured]') return true;
    if (['false', '0', 'no', ''].includes(resolved)) return false;
    return undefined;
  }

  function compareConfiguration(): void {
    const expected = new Map<string, string>();
    for (const line of configurationText.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:-\s*)?(?:export\s+)?([A-Z][A-Z0-9_]*)\s*(?:=|:)\s*(.*?)\s*$/);
      if (!match || !configurationMap[match[1]!]) continue;
      const key = match[1]!;
      const rawValue = isEndpointKey(key) ? match[2]!.trim() : match[2]!.replace(/\s+#.*$/, '').trim();
      expected.set(key, rawValue);
    }

    rows = [...expected].flatMap<DriftRow>(([key, rawValue]) => {
      const definition = configurationMap[key]!;
      if (definition.kind === 'endpoint') {
        const expectedConfigured = Boolean(resolveValue(rawValue)) || rawValue === '[configured]';
        const runningConfigured = Boolean(runtimeConfiguration[definition.configuredSnapshotKey]);
        const expectedFingerprint = endpointFingerprints[key];
        const runningFingerprint = runtimeConfiguration[definition.fingerprintSnapshotKey];
        const configured = expectedConfigured ? 'Endpoint configured (masked)' : 'No endpoint';
        const running = runningConfigured ? 'Endpoint configured (fingerprinted)' : 'No endpoint';
        if (!expectedConfigured || !runningConfigured) {
          return [{ key: definition.label, configured, running, matches: expectedConfigured === runningConfigured }];
        }
        if (!expectedFingerprint || !runningFingerprint) {
          return [{ key: definition.label, configured, running: 'Fingerprint unavailable', matches: undefined }];
        }
        return [{ key: definition.label, configured, running, matches: expectedFingerprint === runningFingerprint }];
      }

      const desired = normalizeValue(rawValue, definition.kind);
      const current = runtimeConfiguration[definition.snapshotKey];
      if (desired === undefined) return [{ key: definition.label, configured: 'Unrecognized value', running: String(current), matches: false }];
      const same = desired === current;
      const show = (value: boolean | number) => typeof value === 'boolean'
        ? value ? 'Enabled' : 'Disabled'
        : definition.snapshotKey === 'appStoreOfflineMaxWorkers' ? `${value} worker(s)` : `${value.toLocaleString()} MB`;
      return [{ key: definition.label, configured: show(desired), running: show(current as boolean | number), matches: same }];
    });
    comparedAt = new Date().toLocaleString();
  }
</script>

<Card title="Self-host configuration drift">
  <div class="flex items-start gap-2 text-xs text-muted"><ScanSearch class="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" /><p>Compare selected deployment settings with the values currently running in dkrypt. This comparison stays in your browser. Secret values are masked as you type. OTLP endpoints are masked and compared by a fingerprint that excludes credentials, query values, and fragments.</p></div>
  <label class="mt-3 grid gap-1 text-xs" for="configuration-drift-input">Paste the relevant environment or Compose settings<textarea id="configuration-drift-input" class="min-h-32 rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px]" value={configurationText} oninput={handleConfigurationInput} placeholder={'APPSTORE_OFFLINE_MAX_WORKERS=1\nAPPSTORE_OFFLINE_WORKER_MEMORY_MB=8192\nBACKUP_MANIFEST_SECRET=…'}></textarea></label>
  <div class="mt-2 flex flex-wrap items-center gap-2"><Button size="sm" variant="secondary" disabled={!configurationText.trim() || endpointFingerprintPending} onclick={compareConfiguration}>Compare with running config</Button>{#if endpointFingerprintPending}<span class="text-[11px] text-muted">Masking endpoint values…</span>{/if}{#if rows.length > 0}<span class="text-[11px] text-muted">Compared {comparedAt}</span>{/if}</div>
  {#if rows.length > 0}
    <ul class="mt-3 divide-y divide-border/70" aria-label="Configuration drift results">
      {#each rows as row (row.key)}
        <li class="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"><div class="flex min-w-0 items-center gap-2">{#if row.matches === true}<CircleCheck class="h-4 w-4 shrink-0 text-ok" aria-hidden="true" />{:else if row.matches === false}<CircleX class="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />{:else}<ScanSearch class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />{/if}<span class="font-medium">{row.key}</span></div><div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted"><span>Configured: {row.configured}</span><span>Running: {row.running}</span><Badge variant={row.matches === true ? 'success' : row.matches === false ? 'warning' : 'secondary'}>{row.matches === true ? 'Match' : row.matches === false ? 'Drift' : 'Cannot compare'}</Badge></div></li>
      {/each}
    </ul>
    {#if rows.some((row) => row.matches === false)}<p class="mt-2 text-[11px] text-muted">Review the displayed configuration before changing environment values and restarting the service.</p>{/if}
  {/if}
</Card>
