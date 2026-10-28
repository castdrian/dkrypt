import { toast } from 'svelte-sonner';
import { getQueryParam, setQueryParams } from '#lib/urlState';
import { normalizeFormattingLocalePreference, normalizeInterfaceLanguagePreference, type FormattingLocalePreference, type InterfaceLanguagePreference } from '#lib/locale';
import { DEFAULT_HOME_LAYOUT, DEFAULT_HOME_VIEW_MODES, type HomeLayout, type HomeViewModes } from '#lib/homeLayouts';
import { clearUnsavedFormWarnings, unsavedFormsState } from '#lib/formDrafts.svelte';
import type { SignupRequestContinuation } from '#lib/requestContinuation';

export type Theme = 'dark' | 'light';
export type ThemePref = Theme | 'auto';

function readStoredFormattingLocale(): FormattingLocalePreference {
  return normalizeFormattingLocalePreference(localStorage.getItem('formattingLocale'));
}

export const formattingLocaleState = $state<{ value: FormattingLocalePreference }>({ value: readStoredFormattingLocale() });
export const systemLocalesState = $state<{ value: string[] }>({ value: [...navigator.languages] });

function readStoredInterfaceLanguage(): InterfaceLanguagePreference {
  return normalizeInterfaceLanguagePreference(localStorage.getItem('interfaceLanguage'));
}

export const interfaceLanguageState = $state<{ value: InterfaceLanguagePreference }>({ value: readStoredInterfaceLanguage() });

export function setInterfaceLanguage(preference: InterfaceLanguagePreference): void {
  interfaceLanguageState.value = preference;
  localStorage.setItem('interfaceLanguage', preference);
}

export function setFormattingLocale(preference: FormattingLocalePreference): void {
  formattingLocaleState.value = preference;
  localStorage.setItem('formattingLocale', preference);
}

export function initFormattingLocale(): void {
  window.addEventListener('languagechange', () => {
    systemLocalesState.value = [...navigator.languages];
  });
}

function readStoredThemePref(): ThemePref {
  const stored = localStorage.getItem('theme');
  return stored === 'dark' || stored === 'light' ? stored : 'auto';
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const themePrefState = $state<{ value: ThemePref }>({ value: readStoredThemePref() });
export const themeState = $state<{ value: Theme }>({
  value: themePrefState.value === 'auto' ? systemTheme() : themePrefState.value,
});

export function setTheme(pref: ThemePref): void {
  themePrefState.value = pref;
  if (pref === 'auto') localStorage.removeItem('theme');
  else localStorage.setItem('theme', pref);

  const resolved = pref === 'auto' ? systemTheme() : pref;
  themeState.value = resolved;
  document.documentElement.setAttribute('data-theme', resolved);
  applyAccent(accentState.value);
}

export function initTheme(): void {
  document.documentElement.setAttribute('data-theme', themeState.value);

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (themePrefState.value !== 'auto') return;
    const resolved = systemTheme();
    themeState.value = resolved;
    document.documentElement.setAttribute('data-theme', resolved);
    applyAccent(accentState.value);
  });
}

export interface AccentPreset {
  id: string;
  label: string;
  dark: string;
  light: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'blue', label: 'Blue', dark: '#5b8cff', light: '#3b66d6' },
  { id: 'teal', label: 'Teal', dark: '#2dd4bf', light: '#0d9488' },
  { id: 'purple', label: 'Purple', dark: '#a78bfa', light: '#7c3aed' },
  { id: 'pink', label: 'Pink', dark: '#f472b6', light: '#db2777' },
  { id: 'orange', label: 'Orange', dark: '#fb923c', light: '#ea580c' },
  { id: 'green', label: 'Green', dark: '#4ade80', light: '#16a34a' },
];

function readStoredAccent(): string {
  const stored = localStorage.getItem('accent');
  return stored && ACCENT_PRESETS.some((p) => p.id === stored) ? stored : 'blue';
}

export const accentState = $state<{ value: string }>({ value: readStoredAccent() });

function readStoredHighContrast(): boolean {
  return localStorage.getItem('highContrast') === 'true';
}

export const highContrastState = $state<{ value: boolean }>({ value: readStoredHighContrast() });

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const [l1, l2] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

function bestContrastText(bgHex: string): string {
  const white = '#ffffff';
  const nearBlack = '#14161a';
  return contrastRatio(white, bgHex) >= contrastRatio(nearBlack, bgHex) ? white : nearBlack;
}

function applyAccent(id: string): void {
  const preset = ACCENT_PRESETS.find((p) => p.id === id) ?? ACCENT_PRESETS[0];
  const accent = highContrastState.value
    ? themeState.value === 'light' ? '#003f8c' : '#a8d7ff'
    : themeState.value === 'light' ? preset.light : preset.dark;
  document.documentElement.style.setProperty('--color-accent', accent);
  document.documentElement.style.setProperty('--color-accent-contrast', bestContrastText(accent));
}

export function setAccent(id: string): void {
  accentState.value = id;
  localStorage.setItem('accent', id);
  applyAccent(id);
}

export function initAccent(): void {
  applyAccent(accentState.value);
}

export function setHighContrast(enabled: boolean): void {
  highContrastState.value = enabled;
  localStorage.setItem('highContrast', String(enabled));
  if (enabled) document.documentElement.setAttribute('data-high-contrast', 'true');
  else document.documentElement.removeAttribute('data-high-contrast');
  applyAccent(accentState.value);
}

export function initHighContrast(): void {
  if (highContrastState.value) document.documentElement.setAttribute('data-high-contrast', 'true');
}

export const soundEnabledState = $state<{ value: boolean }>({ value: localStorage.getItem('soundEnabled') === 'true' });

export function setSoundEnabled(enabled: boolean): void {
  soundEnabledState.value = enabled;
  localStorage.setItem('soundEnabled', String(enabled));
}

export type DisplayDensity = 'comfortable' | 'compact';
export type SettingsMode = 'basic' | 'advanced';
export type ArtifactColumnId = 'app' | 'bundleId' | 'version' | 'source' | 'size' | 'created';
export interface SavedArtifactColumnLayout { id: string; name: string; groupByApp: boolean; columns: ArtifactColumnId[] }

export const densityState = $state<{ value: DisplayDensity }>({ value: 'comfortable' });
export const sidebarState = $state<{ width: number; collapsed: boolean }>({ width: 256, collapsed: false });
export const settingsModeState = $state<{ value: SettingsMode }>({ value: 'basic' });
export const displayTimeZoneState = $state<{ value: string }>({ value: 'system' });
export const largeTargetsState = $state<{ value: boolean }>({ value: false });
export const oneThumbModeState = $state<{ value: boolean }>({ value: false });
export const decryptUsageAlertThresholdsState = $state<{ value: number[] }>({ value: [] });
export const navigationPreferencesState = $state<{ order: TabId[]; pinned: TabId[] }>({
  order: ['home', 'billing', 'keys', 'logs', 'insights', 'docs', 'settings'],
  pinned: [],
});
export const artifactLibraryPreferencesState = $state<{ groupByApp: boolean; columns: ArtifactColumnId[]; layouts: SavedArtifactColumnLayout[]; activeLayoutId?: string }>({
  groupByApp: false,
  columns: ['app', 'bundleId', 'version', 'source', 'size'],
  layouts: [],
});
export const artifactFilenameTemplateState = $state<{ value: string }>({ value: '{app}-{version}' });
export const screenSharePrivacyState = $state<{ enabled: boolean }>({ enabled: sessionStorage.getItem('screensharePrivacy') === 'true' });
export const homeLayoutPreferencesState = $state<{ layouts: HomeLayout[]; activeId: string }>({
  layouts: [{ ...DEFAULT_HOME_LAYOUT, order: [...DEFAULT_HOME_LAYOUT.order], hidden: [], collapsed: [] }],
  activeId: DEFAULT_HOME_LAYOUT.id,
});
export const homeViewModesState = $state<{ value: HomeViewModes }>({ value: { ...DEFAULT_HOME_VIEW_MODES } });

export function setDensity(density: DisplayDensity): void {
  densityState.value = density;
  document.documentElement.setAttribute('data-density', density);
}

export function setSidebarPreferences(width: number, collapsed: boolean): void {
  sidebarState.width = Math.max(200, Math.min(360, Math.round(width)));
  sidebarState.collapsed = collapsed;
}

export function initDensity(): void {
  document.documentElement.setAttribute('data-density', densityState.value);
}

export function setDisplayTimeZone(timeZone: string): void {
  displayTimeZoneState.value = timeZone || 'system';
}

export function setLargeTargets(enabled: boolean): void {
  largeTargetsState.value = enabled;
  if (enabled) document.documentElement.setAttribute('data-large-targets', 'true');
  else document.documentElement.removeAttribute('data-large-targets');
}

export function setOneThumbMode(enabled: boolean): void {
  oneThumbModeState.value = enabled;
  if (enabled) document.documentElement.setAttribute('data-one-thumb', 'true');
  else document.documentElement.removeAttribute('data-one-thumb');
}

export function initOneThumbMode(): void {
  if (oneThumbModeState.value) document.documentElement.setAttribute('data-one-thumb', 'true');
}

export function setDecryptUsageAlertThresholds(thresholds: number[]): void {
  decryptUsageAlertThresholdsState.value = [...thresholds].sort((a, b) => a - b);
}

export function initLargeTargets(): void {
  if (largeTargetsState.value) document.documentElement.setAttribute('data-large-targets', 'true');
}

export function setNavigationPreferences(order: TabId[], pinned: TabId[]): void {
  navigationPreferencesState.order = [...order];
  navigationPreferencesState.pinned = [...pinned];
}

export function setArtifactLibraryPreferences(groupByApp: boolean, columns: ArtifactColumnId[], layouts: SavedArtifactColumnLayout[] = artifactLibraryPreferencesState.layouts, activeLayoutId?: string): void {
  artifactLibraryPreferencesState.groupByApp = groupByApp;
  artifactLibraryPreferencesState.columns = [...columns];
  artifactLibraryPreferencesState.layouts = layouts.map((layout) => ({ ...layout, columns: [...layout.columns] }));
  artifactLibraryPreferencesState.activeLayoutId = activeLayoutId;
}

export function setArtifactFilenameTemplate(template: string): void {
  artifactFilenameTemplateState.value = template;
}

export function setScreenSharePrivacy(enabled: boolean): void {
  screenSharePrivacyState.enabled = enabled;
  if (enabled) {
    sessionStorage.setItem('screensharePrivacy', 'true');
    document.documentElement.setAttribute('data-screenshare-privacy', 'true');
  } else {
    sessionStorage.removeItem('screensharePrivacy');
    document.documentElement.removeAttribute('data-screenshare-privacy');
  }
}

export function initScreenSharePrivacy(): void {
  if (screenSharePrivacyState.enabled) document.documentElement.setAttribute('data-screenshare-privacy', 'true');
}

export function setSettingsMode(mode: SettingsMode): void {
  settingsModeState.value = mode;
}

export function setHomeLayoutPreferences(layouts: HomeLayout[], activeId: string): void {
  homeLayoutPreferencesState.layouts = layouts.map((layout) => ({
    ...layout,
    order: [...layout.order],
    hidden: [...layout.hidden],
    collapsed: [...layout.collapsed],
  }));
  homeLayoutPreferencesState.activeId = activeId;
}

export function setHomeViewModes(viewModes: Partial<HomeViewModes>): void {
  homeViewModesState.value = { ...DEFAULT_HOME_VIEW_MODES, ...viewModes };
}

export function resetUserInterfacePreferences(): void {
  setDensity('comfortable');
  setSidebarPreferences(256, false);
  setSettingsMode('basic');
  setDisplayTimeZone('system');
  setLargeTargets(false);
  setNavigationPreferences(['home', 'billing', 'keys', 'logs', 'insights', 'docs', 'settings'], []);
  setArtifactLibraryPreferences(false, ['app', 'bundleId', 'version', 'source', 'size'], [], undefined);
  setArtifactFilenameTemplate('{app}-{version}');
  setHomeLayoutPreferences([{ ...DEFAULT_HOME_LAYOUT, order: [...DEFAULT_HOME_LAYOUT.order], hidden: [], collapsed: [] }], DEFAULT_HOME_LAYOUT.id);
  setHomeViewModes(DEFAULT_HOME_VIEW_MODES);
}

export interface ToastHistoryEntry {
  id: string;
  message: string;
  type: 'success' | 'error';
  ts: number;
  downloadUrl?: string;
}

const MAX_TOAST_HISTORY = 20;
const TOAST_HISTORY_KEY = 'toastHistory';

function loadToastHistory(): ToastHistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(TOAST_HISTORY_KEY) ?? '[]') as ToastHistoryEntry[];
  } catch {
    return [];
  }
}

export const toastHistoryState = $state<{ items: ToastHistoryEntry[] }>({ items: loadToastHistory() });

function persistToastHistory(): void {
  try {
    localStorage.setItem(TOAST_HISTORY_KEY, JSON.stringify(toastHistoryState.items));
  } catch {
    // localStorage can throw (quota exceeded, private browsing) - state stays correct in-memory either way.
  }
}

export function clearToastHistory(): void {
  toastHistoryState.items = [];
  persistToastHistory();
}

export function showToast(
  message: string,
  type: 'success' | 'error' = 'success',
  options?: { track?: boolean; action?: { label: string; onClick: () => void }; id?: string; downloadUrl?: string; duration?: number },
): void {
  const toastOptions = options?.action || options?.id || options?.duration !== undefined
    ? { action: options.action, id: options.id, duration: options.duration }
    : undefined;
  if (type === 'error') toast.error(message, toastOptions);
  else toast.success(message, toastOptions);

  const track = options?.track ?? type === 'error';
  if (!track) return;

  toastHistoryState.items = [{ id: crypto.randomUUID(), message, type, ts: Date.now(), downloadUrl: options?.downloadUrl }, ...toastHistoryState.items].slice(0, MAX_TOAST_HISTORY);
  persistToastHistory();
}

export const screenReaderAnnouncementState = $state<{ text: string }>({ text: '' });
const announcedKeys = new Map<string, number>();
let announcementTimer: ReturnType<typeof setTimeout> | undefined;

export function announceScreenReader(message: string, key = message): void {
  const now = Date.now();
  const lastAnnouncedAt = announcedKeys.get(key);
  if (lastAnnouncedAt !== undefined && now - lastAnnouncedAt < 30_000) return;
  announcedKeys.set(key, now);
  if (announcedKeys.size > 200) announcedKeys.delete(announcedKeys.keys().next().value as string);
  if (announcementTimer) clearTimeout(announcementTimer);
  screenReaderAnnouncementState.text = '';
  announcementTimer = setTimeout(() => {
    screenReaderAnnouncementState.text = message;
  }, 40);
}

interface ConfirmState {
  open: boolean;
  message: string;
  variant: 'destructive' | 'default';
  confirmLabel: string;
  resolve?: (value: boolean) => void;
}

export const confirmState = $state<ConfirmState>({ open: false, message: '', variant: 'destructive', confirmLabel: 'Confirm' });

export function confirmDialog(
  message: string,
  options?: { variant?: 'destructive' | 'default'; confirmLabel?: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.open = true;
    confirmState.message = message;
    confirmState.variant = options?.variant ?? 'destructive';
    confirmState.confirmLabel = options?.confirmLabel ?? 'Confirm';
    confirmState.resolve = resolve;
  });
}

export function resolveConfirm(result: boolean): void {
  confirmState.open = false;
  confirmState.resolve?.(result);
  confirmState.resolve = undefined;
}

interface PromptState {
  open: boolean;
  message: string;
  value: string;
  type: 'text' | 'password';
  confirmLabel: string;
  resolve?: (value: string | null) => void;
}

export const promptState = $state<PromptState>({ open: false, message: '', value: '', type: 'text', confirmLabel: 'Continue' });

export function promptDialog(message: string, options?: { value?: string; type?: 'text' | 'password'; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    promptState.open = true;
    promptState.message = message;
    promptState.value = options?.value ?? '';
    promptState.type = options?.type ?? 'text';
    promptState.confirmLabel = options?.confirmLabel ?? 'Continue';
    promptState.resolve = resolve;
  });
}

export function resolvePrompt(value: string | null): void {
  promptState.open = false;
  promptState.resolve?.(value);
  promptState.resolve = undefined;
  promptState.value = '';
}

export const paletteState = $state<{ open: boolean }>({ open: false });
export const focusViewState = $state<{ enabled: boolean }>({ enabled: false });

export function setFocusView(enabled: boolean): void {
  focusViewState.enabled = enabled;
}

export function openPalette(): void {
  paletteState.open = true;
}

export function closePalette(): void {
  paletteState.open = false;
}

export const helpState = $state<{ open: boolean }>({ open: false });

export function openHelp(): void {
  helpState.open = true;
}

export function closeHelp(): void {
  helpState.open = false;
}

export const historyJumpState = $state<{ bundleId: string | null; failureCategory: string | null }>({ bundleId: null, failureCategory: null });

export function jumpToHistoryBundleId(bundleId: string): void {
  historyJumpState.bundleId = bundleId;
  setActiveTab('home');
}

export function jumpToHistoryFailureCategory(category: string): void {
  historyJumpState.failureCategory = category;
  setActiveTab('home');
}

export const keyUsageJumpState = $state<{ keyId: string | null }>({ keyId: null });

export function jumpToKeyUsage(keyId: string): void {
  keyUsageJumpState.keyId = keyId;
  setActiveTab('keys');
}

export const userJumpState = $state<{ username: string | null }>({ username: null });

export function jumpToUser(username: string): void {
  userJumpState.username = username;
  setActiveTab('settings');
  setSettingsSubtab('users');
}

export const focusSearchJumpState = $state<{ requested: boolean; bundleId: string | null }>({ requested: false, bundleId: null });

export function requestFocusSearch(bundleId?: string): void {
  focusSearchJumpState.requested = true;
  focusSearchJumpState.bundleId = bundleId ?? null;
  setActiveTab('home');
}

export const jobDetailJumpState = $state<{ id: string | null }>({ id: null });
export const artifactDetailJumpState = $state<{ id: string | null }>({ id: null });
export const appDetailJumpState = $state<{ bundleId: string | null }>({ bundleId: null });
export const decryptSearchJumpState = $state<{ bundleId: string | null }>({ bundleId: null });
export const signupDecryptContinuationState = $state<{ request: SignupRequestContinuation | null }>({ request: null });
export const deviceDetailJumpState = $state<{ id: string | null }>({ id: null });
export const logSearchJumpState = $state<{ value: { query: string; scope?: string } | null }>({ value: null });

export const batchDecryptJumpState = $state<{ requested: boolean }>({ requested: false });

export function requestOpenBatch(): void {
  batchDecryptJumpState.requested = true;
  setActiveTab('home');
}

export type TabId = 'home' | 'billing' | 'keys' | 'logs' | 'insights' | 'docs' | 'settings';

const VALID_TAB_IDS: TabId[] = ['home', 'billing', 'keys', 'logs', 'insights', 'docs', 'settings'];

function readInitialTab(): TabId {
  const params = new URLSearchParams(window.location.search);
  if (params.has('url') || params.has('text') || params.has('title')) return 'home';
  const fromUrl = getQueryParam('tab');
  if (fromUrl && VALID_TAB_IDS.includes(fromUrl as TabId)) return fromUrl as TabId;
  return (localStorage.getItem('activeTab') as TabId | null) ?? 'home';
}

export const tabState = $state<{ active: TabId; settingsSubtab: string }>({
  active: readInitialTab(),
  settingsSubtab: getQueryParam('stab') ?? localStorage.getItem('activeSettingsSubtab') ?? 'personalization',
});

let navigationReviewPending = false;
const pendingNavigationActions: Array<() => void> = [];

function navigateWithUnsavedReview(action: () => void, onCancel?: () => void): void {
  if (unsavedFormsState.ids.length === 0) {
    action();
    return;
  }
  pendingNavigationActions.push(action);
  if (navigationReviewPending) return;
  navigationReviewPending = true;
  void confirmDialog('You have unsaved changes. Leave this view?', { variant: 'default', confirmLabel: 'Leave view' })
    .then((confirmed) => {
      if (!confirmed) {
        onCancel?.();
        return;
      }
      clearUnsavedFormWarnings();
      for (const navigationAction of pendingNavigationActions.splice(0)) navigationAction();
    })
    .finally(() => {
      pendingNavigationActions.splice(0);
      navigationReviewPending = false;
    });
}

function applyActiveTab(tab: TabId): void {
  tabState.active = tab;
  localStorage.setItem('activeTab', tab);
  setQueryParams({ tab, stab: tab === 'settings' ? tabState.settingsSubtab : undefined });
  window.scrollTo(0, 0);
}

export function setActiveTab(tab: TabId): void {
  if (tab === tabState.active) return;
  navigateWithUnsavedReview(() => applyActiveTab(tab));
}

function applySettingsSubtab(subtab: string): void {
  tabState.settingsSubtab = subtab;
  localStorage.setItem('activeSettingsSubtab', subtab);
  setQueryParams({ stab: subtab });
  window.scrollTo(0, 0);
}

export function setSettingsSubtab(subtab: string): void {
  if (subtab === tabState.settingsSubtab) return;
  navigateWithUnsavedReview(() => applySettingsSubtab(subtab));
}

export function initUrlTabSync(): void {
  let synchronizedUrl = window.location.href;
  window.addEventListener('popstate', () => {
    const tab = getQueryParam('tab');
    const stab = getQueryParam('stab');
    const nextTab = tab && VALID_TAB_IDS.includes(tab as TabId) ? tab as TabId : tabState.active;
    const nextSubtab = stab ?? tabState.settingsSubtab;
    const artifactId = getQueryParam('artifact');
    const jobId = getQueryParam('job');
    const applyLocation = () => {
      if (nextTab !== tabState.active) applyActiveTab(nextTab);
      if (nextSubtab !== tabState.settingsSubtab) applySettingsSubtab(nextSubtab);
      if (artifactId) {
        artifactDetailJumpState.id = artifactId;
        jobDetailJumpState.id = null;
        if (tabState.active !== 'home') applyActiveTab('home');
      } else if (jobId) {
        jobDetailJumpState.id = jobId;
        artifactDetailJumpState.id = null;
        if (tabState.active !== 'home') applyActiveTab('home');
      } else {
        artifactDetailJumpState.id = '';
        jobDetailJumpState.id = '';
      }
      synchronizedUrl = window.location.href;
    };
    const routeChanged = nextTab !== tabState.active || nextSubtab !== tabState.settingsSubtab;
    if (routeChanged && unsavedFormsState.ids.length > 0) {
      navigateWithUnsavedReview(applyLocation, () => {
        window.history.replaceState(window.history.state, '', synchronizedUrl);
      });
      return;
    }
    applyLocation();
  });
}
