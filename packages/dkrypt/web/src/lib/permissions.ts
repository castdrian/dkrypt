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

export function parseBits(value: string | undefined | null): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export type PermissionGroup = 'General' | 'API Keys' | 'Automation & Devices' | 'Members & Roles' | 'Projects' | 'Backups';

export interface PermissionMeta {
  key: PermissionFlagKey;
  label: string;
  description: string;
  group: PermissionGroup;
}

export const PERMISSION_META = [
  { key: 'administrator', label: 'Administrator', description: 'Grants every current and future dashboard permission. This bypasses every individual permission check and should be limited to fully trusted operators.', group: 'General' },
  { key: 'requestDecrypt', label: 'Request and manage own decrypts', description: 'Submit manual and TestFlight decrypt requests, then cancel, prioritize, retry, and download only jobs owned by this account.', group: 'General' },
  { key: 'viewLogs', label: 'View operational logs', description: 'Read the live scheduler and job log stream plus webhook delivery records. This does not grant permission to change automation or webhook settings.', group: 'General' },
  { key: 'viewBilling', label: 'View billing subscriptions', description: 'Read member subscription plans, billing providers, statuses, renewal dates, and safe payment identifiers without exposing provider secrets.', group: 'General' },
  { key: 'manageBilling', label: 'Manage billing setup', description: 'View billing subscriptions and provider readiness, including operational billing configuration checks.', group: 'General' },
  { key: 'viewProjects', label: 'View all projects', description: 'View every project, its membership, and its usage limits. Members can always see projects they belong to.', group: 'Projects' },
  { key: 'manageProjects', label: 'Manage projects', description: 'Create and archive projects, assign members, and configure project quotas.', group: 'Projects' },
  { key: 'viewDiagnosticReports', label: 'View diagnostic reports', description: 'Read user-submitted redacted support reports and their project context.', group: 'General' },
  { key: 'viewIncidents', label: 'View incidents', description: 'Read actionable incidents in accessible projects.', group: 'General' },
  { key: 'manageIncidents', label: 'Manage incidents', description: 'Assign, snooze, and resolve incidents in accessible projects.', group: 'General' },
  { key: 'notifyFailedJobOwners', label: 'Notify failed-job requesters', description: 'Send a manual resolution notice to the requester of a failed job in an accessible project.', group: 'General' },
  { key: 'requestApiKeys', label: 'Request API keys', description: 'Submit a personal API-key request for approval. Requested keys remain unusable until someone with Manage API keys approves them.', group: 'API Keys' },
  { key: 'createApiKeys', label: 'Create API keys', description: 'Create, reveal, regenerate, revoke, and use personal API keys immediately. This bypasses the approval queue only for the account’s own keys.', group: 'API Keys' },
  { key: 'viewApiKeys', label: 'View API keys', description: 'Read every API key, including its owner, status, usage, and configuration. Key secrets are never exposed by this permission.', group: 'API Keys' },
  { key: 'manageApiKeys', label: 'Manage API keys', description: 'Approve or deny requests; revoke any key; and change expiry, limits, concurrency, TestFlight access, and priority for any key.', group: 'API Keys' },
  { key: 'viewAutomation', label: 'View automation', description: 'Read watched apps, scheduler state, notifications, and dispatch health without changing any automation configuration.', group: 'Automation & Devices' },
  { key: 'manageAutomation', label: 'Manage automation', description: 'Create and edit watches, change scheduler settings, test notifications, and run or preview dispatches.', group: 'Automation & Devices' },
  { key: 'requestTestFlightSubscriptions', label: 'Request TestFlight subscriptions', description: 'Submit, view, and withdraw your own public TestFlight subscription requests.', group: 'Automation & Devices' },
  { key: 'manageTestFlightSubscriptions', label: 'Manage TestFlight subscriptions', description: 'Approve, deny, synchronize, create, and unsubscribe any public TestFlight subscription.', group: 'Automation & Devices' },
  { key: 'viewDevices', label: 'View devices', description: 'Read decrypt-pool device configuration and health without adding, editing, removing, or operating devices.', group: 'Automation & Devices' },
  { key: 'manageDevices', label: 'Manage devices', description: 'Discover, set up, edit, enable, and delete decrypt-pool devices, including their connection details.', group: 'Automation & Devices' },
  { key: 'viewUsers', label: 'View members', description: 'Read member role assignments, member details, and the audit log. It does not grant the ability to change roles or alter any record.', group: 'Members & Roles' },
  { key: 'manageUsers', label: 'Manage members', description: 'Assign or remove dashboard roles for members and set their manual queue priority. It does not control who may sign in or grant role-definition access.', group: 'Members & Roles' },
  { key: 'viewRoles', label: 'View dashboard roles', description: 'Read role names, colors, membership counts, and granted permissions. It does not permit creating, editing, deleting, or reordering roles.', group: 'Members & Roles' },
  { key: 'manageRoles', label: 'Manage dashboard roles', description: 'Create, edit, delete, and reorder dashboard roles. A user can only grant permissions they already hold unless they also hold this permission.', group: 'Members & Roles' },
  { key: 'viewBackup', label: 'View backups', description: 'Read backup schedules and history and download existing backup files. It does not create, delete, import, or change retention.', group: 'Backups' },
  { key: 'manageBackup', label: 'Manage backups', description: 'Export or import server state, create or delete backup snapshots, and change backup schedules and retention. It does not grant member or role management.', group: 'Backups' },
] satisfies PermissionMeta[];

export type PermissionMetaKey = (typeof PERMISSION_META)[number]['key'];

export function permissionLabels(bits: bigint): string[] {
  if (hasPermission(bits, PermissionFlag.administrator)) return ['Administrator'];
  return PERMISSION_META.filter((f) => f.key !== 'administrator' && (bits & PermissionFlag[f.key]) !== 0n).map((f) => f.label);
}

export function permissionKeys(bits: bigint): PermissionMetaKey[] {
  if (hasPermission(bits, PermissionFlag.administrator)) return ['administrator'];
  return PERMISSION_META.filter((f) => f.key !== 'administrator' && (bits & PermissionFlag[f.key]) !== 0n).map((f) => f.key);
}
