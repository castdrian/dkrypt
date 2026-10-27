interface DurationSeries {
  values: number[];
  lastUsedAt: number;
}

const durationSeries = new Map<string, DurationSeries>();
const maximumSamples = 20;
const maximumKeys = 2_000;

export function adaptiveTimeout(key: string, baseTimeoutMs: number, now = Date.now()): number {
  const series = durationSeries.get(key);
  if (!series || series.values.length < 3) return baseTimeoutMs;
  series.lastUsedAt = now;
  const sorted = [...series.values].sort((left, right) => left - right);
  const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] ?? baseTimeoutMs;
  return Math.min(baseTimeoutMs * 3, Math.max(baseTimeoutMs, Math.ceil(p90 * 1.5)));
}

export function recordAdaptiveDuration(key: string, durationMs: number, now = Date.now()): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  const series = durationSeries.get(key) ?? { values: [], lastUsedAt: now };
  series.values.push(Math.ceil(durationMs));
  if (series.values.length > maximumSamples) series.values.splice(0, series.values.length - maximumSamples);
  series.lastUsedAt = now;
  durationSeries.set(key, series);
  if (durationSeries.size > maximumKeys) {
    const oldest = [...durationSeries.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt).slice(0, durationSeries.size - maximumKeys);
    for (const [expiredKey] of oldest) durationSeries.delete(expiredKey);
  }
}
