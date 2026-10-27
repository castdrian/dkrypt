import { hasPermission, parseBits, PermissionFlag, permissionKeys, permissionLabels, type PermissionMetaKey } from '#lib/permissions';
import { serverStateCache } from '#lib/serverStateCache.svelte';
import { resetTestFlightCatalogState } from '#lib/testFlightCatalogState.svelte';
import { clearPersistedTestFlightCatalog } from '#lib/testFlightCatalogPersistence';
import { clearLegacyStarredApps, readLegacyStarredApps, replaceStarredApps } from '#lib/decrypts.svelte';
import {
  accentState,
  highContrastState,
  formattingLocaleState,
  interfaceLanguageState,
  setAccent,
  setHighContrast,
  setFormattingLocale,
  setInterfaceLanguage,
  setSoundEnabled,
  setTheme,
  setDensity,
  setSidebarPreferences,
  sidebarState,
  setSettingsMode,
  setHomeLayoutPreferences,
  setHomeViewModes,
  setDisplayTimeZone,
  setLargeTargets,
  setOneThumbMode,
  setDecryptUsageAlertThresholds,
  setNavigationPreferences,
  setArtifactLibraryPreferences,
  setArtifactFilenameTemplate,
  homeLayoutPreferencesState,
  homeViewModesState,
  artifactLibraryPreferencesState,
  resetUserInterfacePreferences,
  soundEnabledState,
  themePrefState,
  type ThemePref,
} from '#lib/ui.svelte';
import type { FormattingLocalePreference } from '#lib/locale';
import type { InterfaceLanguagePreference } from '#lib/locale';
import type { HomeLayout, HomeViewModes } from '#lib/homeLayouts';
import type { ArtifactColumnId, DisplayDensity, SavedArtifactColumnLayout, SettingsMode, TabId } from '#lib/ui.svelte';
import { resetShortcutBindings, setShortcutBindings, type ShortcutBindings } from '#lib/shortcuts.svelte';

export interface Role {
  id: string;
  name: string;
  color: string;
  permissions: string;
  position: number;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export function permissionsSummary(bits: bigint): string {
  if (hasPermission(bits, PermissionFlag.administrator)) return 'administrator';
  if (bits === 0n) return 'viewer';
  return 'custom';
}

export interface SessionInfo {
  loggedIn: boolean;
  freeTier?: boolean;
  sub?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  identities?: { provider: 'github' | 'discord'; username: string; displayName: string; avatarUrl?: string }[];
  linkedProviders?: ('github' | 'discord')[];

  permissions?: string;
  expiresAt?: number;
  githubOauthEnabled: boolean;
  discordOauthEnabled: boolean;
  deployment?: { ref: string };
  publicBaseUrl?: string;
  signupVerificationEnabled?: boolean;
  signupTurnstileSiteKey?: string;
  mfa?: { enabled: boolean; recoveryCodesRemaining: number; required: boolean };
}

let confirmedSidebar = { width: 256, collapsed: false };
let sidebarPreferenceWrite: Promise<void> = Promise.resolve();

export const sessionState = $state<SessionInfo>({ loggedIn: false, githubOauthEnabled: false, discordOauthEnabled: false });

export function sessionBits(): bigint {
  return parseBits(sessionState.permissions);
}

export function sessionHasPermission(flag: bigint): boolean {
  return hasPermission(sessionBits(), flag);
}

export function sessionHasAnyPermission(flags: bigint[]): boolean {
  return flags.some((flag) => sessionHasPermission(flag));
}

export function sessionCanViewOperationalDashboard(): boolean {
  return sessionHasAnyPermission([
    PermissionFlag.viewDevices,
    PermissionFlag.manageDevices,
    PermissionFlag.viewAutomation,
    PermissionFlag.manageAutomation,
  ]);
}

export function sessionPermissionLabels(): string[] {
  return permissionLabels(sessionBits());
}

export function sessionPermissionKeys(): PermissionMetaKey[] {
  return permissionKeys(sessionBits());
}

export function sessionCanSeeSettings(): boolean {
  return sessionState.loggedIn;
}

export async function refreshSession(): Promise<SessionInfo> {
  const res = await fetch('/v1/auth/session');
  const data = (await res.json()) as SessionInfo;
  const previousSub = sessionState.sub?.trim();
  const identityChanged = data.loggedIn !== sessionState.loggedIn || data.sub !== sessionState.sub;
  const permissionsChanged = data.permissions !== sessionState.permissions;
  const accessChanged = identityChanged || permissionsChanged;
  const identitySwitched = previousSub && data.loggedIn && previousSub.toLowerCase() !== data.sub?.trim().toLowerCase();
  if (identitySwitched) {
    resetUserInterfacePreferences();
    confirmedSidebar = { width: 256, collapsed: false };
    resetShortcutBindings();
    replaceStarredApps([]);
  }
  if (accessChanged) {
    serverStateCache.clear();
    const leavingIdentity = previousSub && (!data.loggedIn || previousSub.toLowerCase() !== data.sub?.trim().toLowerCase());
    if (previousSub && (leavingIdentity || permissionsChanged)) clearPersistedTestFlightCatalog(previousSub);
    resetTestFlightCatalogState();
  }
  Object.assign(sessionState, data);
  if (data.loggedIn) {
    if (accessChanged) serverStateCache.invalidateAll();
    void syncThemeFromServer();
  } else {
    replaceStarredApps([]);
  }
  return data;
}

export async function updateProfile(displayName: string, username: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/v1/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName, username }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    return { ok: false, error: data.message ?? data.error ?? 'Could not update profile.' };
  }
  await refreshSession();
  return { ok: true };
}

async function syncThemeFromServer(): Promise<void> {
  const accountId = sessionState.sub;
  const res = await fetch('/v1/dashboard/me/prefs');
  if (!res.ok || sessionState.sub !== accountId) return;
  const prefs = (await res.json()) as {
    formattingLocale?: FormattingLocalePreference;
    interfaceLanguage?: InterfaceLanguagePreference;
    theme?: ThemePref;
    accent?: string;
    sound?: boolean;
    highContrast?: boolean;
    density?: DisplayDensity;
    sidebarWidth?: number;
    sidebarCollapsed?: boolean;
    homeLayouts?: HomeLayout[];
    activeHomeLayoutId?: string;
    viewModes?: Partial<HomeViewModes>;
    settingsMode?: SettingsMode;
    displayTimeZone?: string;
    appFavorites?: Array<{ bundleId: string; trackName: string }>;
    navigationOrder?: TabId[];
    pinnedNavigation?: TabId[];
    artifactLibrary?: { groupByApp: boolean; columns: ArtifactColumnId[]; layouts?: SavedArtifactColumnLayout[]; activeLayoutId?: string };
    artifactFilenameTemplate?: string;
    largeTargets?: boolean;
    oneThumbMode?: boolean;
    decryptUsageAlertThresholds?: number[];
    shortcutBindings?: ShortcutBindings;
  };
  if (sessionState.sub !== accountId) return;
  const formattingLocale = prefs.formattingLocale ?? 'system';
  if (formattingLocale !== formattingLocaleState.value) setFormattingLocale(formattingLocale);
  const interfaceLanguage = prefs.interfaceLanguage ?? 'system';
  if (interfaceLanguage !== interfaceLanguageState.value) setInterfaceLanguage(interfaceLanguage);
  if (prefs.theme && prefs.theme !== themePrefState.value) setTheme(prefs.theme);
  if (prefs.accent && prefs.accent !== accentState.value) setAccent(prefs.accent);
  if (prefs.highContrast !== undefined && prefs.highContrast !== highContrastState.value) setHighContrast(prefs.highContrast);
  if (prefs.sound !== undefined && prefs.sound !== soundEnabledState.value) setSoundEnabled(prefs.sound);
  if (prefs.density) setDensity(prefs.density);
  setSidebarPreferences(prefs.sidebarWidth ?? 256, prefs.sidebarCollapsed ?? false);
  confirmedSidebar = { width: sidebarState.width, collapsed: sidebarState.collapsed };
  if (prefs.homeLayouts?.length) setHomeLayoutPreferences(prefs.homeLayouts, prefs.activeHomeLayoutId ?? prefs.homeLayouts[0]!.id);
  if (prefs.viewModes) setHomeViewModes(prefs.viewModes);
  if (prefs.settingsMode) setSettingsMode(prefs.settingsMode);
  setDisplayTimeZone(prefs.displayTimeZone ?? 'system');
  if (prefs.navigationOrder) setNavigationPreferences(prefs.navigationOrder, prefs.pinnedNavigation ?? []);
  if (prefs.artifactLibrary) setArtifactLibraryPreferences(prefs.artifactLibrary.groupByApp, prefs.artifactLibrary.columns, prefs.artifactLibrary.layouts ?? [], prefs.artifactLibrary.activeLayoutId);
  setArtifactFilenameTemplate(prefs.artifactFilenameTemplate ?? '{app}-{version}');
  setLargeTargets(prefs.largeTargets ?? false);
  setOneThumbMode(prefs.oneThumbMode ?? false);
  setDecryptUsageAlertThresholds(prefs.decryptUsageAlertThresholds ?? []);
  if (prefs.shortcutBindings) setShortcutBindings(prefs.shortcutBindings);
  const userId = sessionState.sub?.trim().toLowerCase();
  const migrationKey = userId ? `starredAppsMigrated:${userId}` : undefined;
  const needsMigration = !!migrationKey && !localStorage.getItem(migrationKey);
  const legacyFavorites = needsMigration ? readLegacyStarredApps() : [];
  const favoriteMap = new Map<string, { bundleId: string; trackName: string }>();
  for (const favorite of [...(prefs.appFavorites ?? []), ...legacyFavorites]) {
    const key = favorite.bundleId.trim().toLowerCase();
    if (key && !favoriteMap.has(key)) favoriteMap.set(key, { bundleId: favorite.bundleId.trim(), trackName: favorite.trackName.trim() });
  }
  const favorites = [...favoriteMap.values()].slice(0, 50);
  replaceStarredApps(favorites);
  if (needsMigration) {
    if (legacyFavorites.length === 0 || JSON.stringify(favorites) === JSON.stringify(prefs.appFavorites ?? [])) {
      clearLegacyStarredApps();
      localStorage.setItem(migrationKey!, 'true');
    } else {
      try {
        await pushAppFavoritesPref(favorites);
        clearLegacyStarredApps();
        localStorage.setItem(migrationKey!, 'true');
      } catch {
        return;
      }
    }
  }
}

async function pushDashboardPreference(patch: Record<string, unknown>): Promise<void> {
  if (!sessionState.loggedIn) return;
  const response = await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error('Could not save dashboard preferences');
}

export function pushDensityPref(density: DisplayDensity): Promise<void> {
  setDensity(density);
  return pushDashboardPreference({ density });
}

export function pushSidebarPreferences(width: number, collapsed: boolean): Promise<void> {
  const accountId = sessionState.sub;
  setSidebarPreferences(width, collapsed);
  const requested = { width: sidebarState.width, collapsed: sidebarState.collapsed };
  const save = sidebarPreferenceWrite.then(async () => {
    if (sessionState.sub !== accountId) return;
    await pushDashboardPreference({ sidebarWidth: requested.width, sidebarCollapsed: requested.collapsed });
    if (sessionState.sub === accountId) confirmedSidebar = requested;
  }).catch((error: unknown) => {
    if (sessionState.sub === accountId && sidebarState.width === requested.width && sidebarState.collapsed === requested.collapsed) {
      setSidebarPreferences(confirmedSidebar.width, confirmedSidebar.collapsed);
    }
    throw error;
  });
  sidebarPreferenceWrite = save.catch(() => undefined);
  return save;
}

export function pushDisplayTimeZonePref(displayTimeZone: string): Promise<void> {
  setDisplayTimeZone(displayTimeZone);
  return pushDashboardPreference({ displayTimeZone });
}

export function pushLargeTargetsPref(largeTargets: boolean): Promise<void> {
  setLargeTargets(largeTargets);
  return pushDashboardPreference({ largeTargets });
}

export function pushOneThumbModePref(enabled: boolean): Promise<void> {
  setOneThumbMode(enabled);
  return pushDashboardPreference({ oneThumbMode: enabled });
}

export function pushDecryptUsageAlertThresholds(thresholds: number[]): Promise<void> {
  setDecryptUsageAlertThresholds(thresholds);
  return pushDashboardPreference({ decryptUsageAlertThresholds: thresholds });
}

export function pushNavigationPreferences(order: TabId[], pinned: TabId[]): Promise<void> {
  setNavigationPreferences(order, pinned);
  return pushDashboardPreference({ navigationOrder: order, pinnedNavigation: pinned });
}

export function pushArtifactLibraryPreferences(groupByApp: boolean, columns: ArtifactColumnId[], layouts = artifactLibraryPreferencesState.layouts, activeLayoutId?: string): Promise<void> {
  setArtifactLibraryPreferences(groupByApp, columns, layouts, activeLayoutId);
  return pushDashboardPreference({ artifactLibrary: { groupByApp, columns, layouts, activeLayoutId } });
}

export async function pushArtifactFilenameTemplate(template: string): Promise<void> {
  await pushDashboardPreference({ artifactFilenameTemplate: template });
  setArtifactFilenameTemplate(template);
}

export function pushAppFavoritesPref(favorites: Array<{ bundleId: string; trackName: string }>): Promise<void> {
  const normalized = favorites.slice(0, 50).map(({ bundleId, trackName }) => ({ bundleId, trackName }));
  replaceStarredApps(normalized);
  return pushDashboardPreference({ appFavorites: normalized });
}

export async function pushHomeLayoutPreferences(layouts: HomeLayout[], activeId: string): Promise<void> {
  const previousLayouts = homeLayoutPreferencesState.layouts.map((layout) => ({ ...layout, order: [...layout.order], hidden: [...layout.hidden], collapsed: [...layout.collapsed] }));
  const previousActiveId = homeLayoutPreferencesState.activeId;
  setHomeLayoutPreferences(layouts, activeId);
  if (!sessionState.loggedIn) return;
  try {
    const response = await fetch('/v1/dashboard/me/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeLayouts: layouts, activeHomeLayoutId: activeId }),
    });
    if (!response.ok) throw new Error('Could not save Home layout preferences');
  } catch (error) {
    setHomeLayoutPreferences(previousLayouts, previousActiveId);
    throw error;
  }
}

export function pushHomeViewMode(key: keyof HomeViewModes, mode: HomeViewModes[keyof HomeViewModes]): Promise<void> {
  const viewModes = { ...homeViewModesState.value, [key]: mode };
  setHomeViewModes(viewModes);
  return pushDashboardPreference({ viewModes: { [key]: mode } });
}

export function pushSettingsModePref(mode: SettingsMode): Promise<void> {
  setSettingsMode(mode);
  return pushDashboardPreference({ settingsMode: mode });
}

export interface NotificationPrefs {
  pushOnSuccess?: boolean;
  pushOnFailure?: boolean;
  pushOnAlerts?: boolean;
  pushOnKeyExpiry?: boolean;
  emailOnSuccess?: boolean;
  emailOnFailure?: boolean;
  emailOnAlerts?: boolean;
  emailOnKeyExpiry?: boolean;
  appNotificationPreferences?: Array<{
    bundleId: string;
    pushOnSuccess?: boolean;
    pushOnFailure?: boolean;
    emailOnSuccess?: boolean;
    emailOnFailure?: boolean;
  }>;
  notifyEmail?: string;
}

export async function fetchNotificationPrefs(): Promise<NotificationPrefs & { accountEmail?: string }> {
  const res = await fetch('/v1/dashboard/me/prefs');
  if (!res.ok) return {};
  const prefs = (await res.json()) as NotificationPrefs & { accountEmail?: string };
  return prefs;
}

export async function pushNotificationPrefs(patch: NotificationPrefs): Promise<void> {
  if (!sessionState.loggedIn) return;
  const response = await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error('Could not save notification preferences');
}

export async function pushShortcutBindings(bindings: ShortcutBindings): Promise<void> {
  if (!sessionState.loggedIn) return;
  const response = await fetch('/v1/dashboard/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shortcutBindings: bindings }) });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? 'Shortcut bindings could not be saved');
  setShortcutBindings(bindings);
}

export async function pushThemePref(theme: ThemePref): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  });
}

export async function pushFormattingLocale(preference: FormattingLocalePreference): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formattingLocale: preference }),
  });
}

export async function pushInterfaceLanguage(preference: InterfaceLanguagePreference): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interfaceLanguage: preference }),
  });
}

export async function pushAccentPref(accent: string): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accent }),
  });
}

export async function pushHighContrastPref(highContrast: boolean): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ highContrast }),
  });
}

export async function pushSoundPref(sound: boolean): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sound }),
  });
}

export async function fetchPreferPrimaryDevicePref(): Promise<boolean> {
  const res = await fetch('/v1/dashboard/me/prefs');
  if (!res.ok) return false;
  const prefs = (await res.json()) as { preferPrimaryDevice?: boolean };
  return prefs.preferPrimaryDevice ?? false;
}

export async function pushPreferPrimaryDevicePref(preferPrimaryDevice: boolean): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferPrimaryDevice }),
  });
}

export async function loginRoot(password: string, mfaToken?: string): Promise<{ ok: boolean; error?: string; code?: string; attemptsRemaining?: number }> {
  const res = await fetch('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, mfaToken: mfaToken || undefined }),
  });
  if (res.ok) {
    await refreshSession();
    return { ok: true };
  }
  const data = await res.json().catch(() => ({}) as { error?: string; code?: string; attemptsRemaining?: number });
  if (res.status === 429) return { ok: false, error: data.error };
  return { ok: false, error: data.code === 'mfa_required' ? 'Enter your authenticator code to continue.' : 'Wrong password.', code: data.code, attemptsRemaining: data.attemptsRemaining };
}

export async function refreshSessionTtl(): Promise<boolean> {
  const res = await fetch('/v1/auth/refresh', { method: 'POST' });
  if (!res.ok) return false;
  await refreshSession();
  return true;
}

export async function logout(): Promise<void> {
  await fetch('/v1/auth/logout', { method: 'POST' });
  await refreshSession();
}

export async function logoutEverywhere(): Promise<void> {
  await fetch('/v1/auth/logout-everywhere', { method: 'POST' });
  await refreshSession();
}

export function markLoggedOut(): void {
  resetUserInterfacePreferences();
  resetShortcutBindings();
  replaceStarredApps([]);
  if (sessionState.loggedIn) serverStateCache.clear();
  if (sessionState.sub) clearPersistedTestFlightCatalog(sessionState.sub);
  resetTestFlightCatalogState();
  sessionState.loggedIn = false;
}
