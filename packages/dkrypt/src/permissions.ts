export const PermissionFlag = {
  administrator: 1n << 0n,
  requestDecrypt: 1n << 1n,
  viewApiKeys: 1n << 2n,
  approveApiKeys: 1n << 3n,
  revokeApiKeys: 1n << 4n,
  manageApiKeyLimits: 1n << 5n,
  manageWatches: 1n << 6n,
  manageDevices: 1n << 7n,
  manageSchedulerSettings: 1n << 8n,
  triggerDispatch: 1n << 9n,
  viewLogs: 1n << 11n,
  viewUsers: 1n << 12n,
  manageUsers: 1n << 13n,
  manageRoles: 1n << 14n,
  manageBackup: 1n << 15n,
  accessApi: 1n << 16n,
  viewRoles: 1n << 17n,
  viewDiscordPerks: 1n << 18n,
  manageDiscordPerks: 1n << 19n,
  viewScheduler: 1n << 20n,
  viewDevices: 1n << 21n,
  viewBackup: 1n << 22n,
  viewApiKeyUsage: 1n << 23n,
  manageApiKeyExpiry: 1n << 24n,
  manageApiKeyDailyLimits: 1n << 25n,
  manageApiKeyConcurrency: 1n << 26n,
  manageApiKeyTestFlight: 1n << 27n,
  manageApiKeyPriority: 1n << 28n,
  requestApiKeys: 1n << 29n,
  createApiKeys: 1n << 30n,
  manageApiKeys: 1n << 31n,
  viewAutomation: 1n << 32n,
  manageAutomation: 1n << 33n,
  requestTestFlightSubscriptions: 1n << 34n,
  manageTestFlightSubscriptions: 1n << 35n,
  viewBilling: 1n << 36n,
  manageBilling: 1n << 37n,
  viewProjects: 1n << 38n,
  manageProjects: 1n << 39n,
  viewDiagnosticReports: 1n << 40n,
  viewIncidents: 1n << 41n,
  manageIncidents: 1n << 42n,
  notifyFailedJobOwners: 1n << 43n,
} as const;

export type PermissionFlagKey = keyof typeof PermissionFlag;

export const PERMISSION_FLAG_KEYS = Object.keys(PermissionFlag) as PermissionFlagKey[];

export const ALL_PERMISSION_BITS = PERMISSION_FLAG_KEYS.reduce((acc, k) => acc | PermissionFlag[k], 0n);

export function hasPermission(bits: bigint, flag: bigint): boolean {
  return (bits & PermissionFlag.administrator) !== 0n || (bits & flag) !== 0n;
}

export function hasAnyPermission(bits: bigint, flags: bigint[]): boolean {
  return flags.some((flag) => hasPermission(bits, flag));
}

export function isSubsetPermission(subset: bigint, bits: bigint): boolean {
  if ((bits & PermissionFlag.administrator) !== 0n) return true;
  return (subset & bits) === subset;
}

export function combineBits(bits: bigint[]): bigint {
  return bits.reduce((acc, b) => acc | b, 0n);
}

export function serializeBits(bits: bigint): string {
  return bits.toString();
}

export function parseBits(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') return 0n;
  try {
    return BigInt(value) & ALL_PERMISSION_BITS;
  } catch {
    return 0n;
  }
}
