export const BRIDGE_PROTOCOL_VERSION = 1;

export const BRIDGE_CAPABILITIES = {
  springboard: ['dark_on', 'dark_off', 'launch_app', 'screen_status', 'status', 'protocol_v1', 'authenticated_requests', 'operation_responses', 'heartbeats', 'stale_artifact_cleanup'],
  testflight: ['list_trains', 'list_builds', 'list_apps', 'device_catalog', 'install', 'diagnostics', 'idempotent_install', 'protocol_v1', 'authenticated_requests', 'operation_responses', 'heartbeats', 'stale_artifact_cleanup'],
  appstore: ['install', 'status', 'diagnostics', 'foreground_status', 'localized_install_titles', 'storefront', 'protocol_v1', 'authenticated_requests', 'operation_responses', 'heartbeats', 'stale_artifact_cleanup'],
} as const;

export const TESTFLIGHT_LIFECYCLE_CAPABILITIES = ['subscribe_invite', 'status_invite', 'unsubscribe_invite', 'invite_lifecycle'] as const;
export const TESTFLIGHT_DEVICE_CATALOG_CAPABILITIES = ['list_apps', 'device_catalog'] as const;

export type BridgeChannel = keyof typeof BRIDGE_CAPABILITIES;

export function hasBridgeCapabilitySet(capabilities: unknown, required: readonly string[]): boolean {
  if (!Array.isArray(capabilities)) return false;
  const reported = capabilities.filter((value): value is string => typeof value === 'string');
  return required.every((capability) => reported.includes(capability));
}

export function hasBridgeCapabilities(channel: BridgeChannel, capabilities: unknown): boolean {
  return hasBridgeCapabilitySet(capabilities, BRIDGE_CAPABILITIES[channel]);
}
