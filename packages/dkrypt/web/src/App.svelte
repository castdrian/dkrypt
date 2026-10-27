<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import { startAuthentication } from "@simplewebauthn/browser";
	import {
		Command,
		Download,
		Eye,
		EyeOff,
		KeyRound,
		Lock,
		LogOut,
		Maximize2,
		MessageSquareWarning,
		Monitor,
		Minimize2,
		Moon,
		Pencil,
		PanelRightOpen,
		PanelLeftClose,
		PanelLeftOpen,
		Sun,
		Trash2,
		Volume2,
		VolumeX,
	} from "lucide-svelte";
	import { Toaster } from "svelte-sonner";
	import CommandPalette from "#components/CommandPalette.svelte";
	import ConfirmModal from "#components/ConfirmModal.svelte";
	import PromptModal from "#components/PromptModal.svelte";
	import ConnectionBanner from "#components/ConnectionBanner.svelte";
	import MaintenanceBanner from "#components/MaintenanceBanner.svelte";
	import UpdateAvailableBanner from "#components/UpdateAvailableBanner.svelte";
	import HeaderOnlineUsers from "#components/HeaderOnlineUsers.svelte";
	import BackgroundTaskTray from "#components/BackgroundTaskTray.svelte";
	import QueueDock from "#components/QueueDock.svelte";
	import Login from "#components/Login.svelte";
	import MfaVerification from "#components/MfaVerification.svelte";
	import LegalPage from "#components/LegalPage.svelte";
	import NotificationBell from "#components/NotificationBell.svelte";
	import WhatsNewButton from "#components/WhatsNewButton.svelte";
	import ContactPage from "#components/ContactPage.svelte";
	import DiagnosticReportDialog from "#components/DiagnosticReportDialog.svelte";
	import TabIcon from "#components/TabIcon.svelte";
	import NotificationPreferences from "#features/notifications/NotificationPreferences.svelte";
	import PublicPricing from "#components/PublicPricing.svelte";
	import PublicStatus from "#components/PublicStatus.svelte";
	import SessionExpiryBanner from "#components/SessionExpiryBanner.svelte";
	import FreeTierBanner from "#components/FreeTierBanner.svelte";
	import SessionsDialog from "#components/SessionsDialog.svelte";
	import OnboardingTour from "#components/OnboardingTour.svelte";
	import ShortcutsHelp from "#components/ShortcutsHelp.svelte";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Avatar from "#lib/components/ui/Avatar.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import { buttonVariants } from "#lib/components/ui/variants";
	import { cn } from "#lib/utils";
	import { DISCORD_INVITE_URL, KOFI_URL } from "#lib/constants";
	import { myDecryptsState } from "#lib/decrypts.svelte";
	import { connectLive, disconnectLive, liveState } from "#lib/live.svelte";
	import {
		registerServiceWorker,
	} from "#lib/push";
	import {
		initInstallPromptWatcher,
		initPwaUpdateWatcher,
		promptPwaInstall,
		pwaState,
	} from "#lib/pwa.svelte";
	import { PermissionFlag } from "#lib/permissions";
	import { shortcutBindingsState } from "#lib/shortcuts.svelte";
	import {
		logout,
		logoutEverywhere,
		permissionsSummary,
		pushAccentPref,
		pushDensityPref,
		pushSidebarPreferences,
		pushHighContrastPref,
		pushFormattingLocale,
		pushInterfaceLanguage,
		pushSoundPref,
		pushThemePref,
		refreshSession,
		sessionBits,
		sessionCanViewOperationalDashboard,
		sessionCanSeeSettings,
		sessionHasAnyPermission,
		sessionHasPermission,
		sessionPermissionKeys,
		sessionState,
		updateProfile,
	} from "#lib/session.svelte";
	import { accountExportUrl, deleteAccount, reauthenticate, reauthenticateWithPasskey } from "#lib/api";
	import {
		ACCENT_PRESETS,
		accentState,
		confirmDialog,
		promptDialog,
		initAccent,
		initDensity,
		initLargeTargets,
		initOneThumbMode,
		initScreenSharePrivacy,
		initHighContrast,
		initFormattingLocale,
		initTheme,
		initUrlTabSync,
		openHelp,
		openPalette,
		setAccent,
		setActiveTab,
		setHighContrast,
		setFormattingLocale,
		setFocusView,
		setInterfaceLanguage,
		setSoundEnabled,
		setTheme,
		setScreenSharePrivacy,
		setSidebarPreferences,
		densityState,
		navigationPreferencesState,
		sidebarState,
		screenSharePrivacyState,
		screenReaderAnnouncementState,
		artifactDetailJumpState,
		jobDetailJumpState,
		showToast,
		soundEnabledState,
		highContrastState,
		formattingLocaleState,
		focusViewState,
		interfaceLanguageState,
		systemLocalesState,
		tabState,
		themePrefState,
		themeState,
		type TabId,
	} from "#lib/ui.svelte";
	import { isFormattingLocalePreference, isInterfaceLanguagePreference, resolveInterfaceLanguage } from "#lib/locale";
	import { translateMessage, translatePermissionLabel, type MessageKey } from "#lib/messages";
	import { createVisitedTabs } from "#lib/visitedTabs.svelte";
	import { getQueryParam } from "#lib/urlState";

	import Docs from "#tabs/Docs.svelte";
	import Billing from "#features/billing/BillingPage.svelte";
	import Home from "#tabs/Home.svelte";
	import StatusPanel from "#features/devices/StatusPanel.svelte";
	import Insights from "#tabs/Insights.svelte";
	import Keys from "#tabs/Keys.svelte";
	import Logs from "#tabs/Logs.svelte";
	import Settings from "#tabs/Settings.svelte";

initTheme();
initDensity();
	initLargeTargets();
	initOneThumbMode();
	initScreenSharePrivacy();
	initHighContrast();
	initFormattingLocale();
	initAccent();
	initUrlTabSync();
	const interfaceLanguage = $derived(resolveInterfaceLanguage(interfaceLanguageState.value, systemLocalesState.value));
	const msg = (key: MessageKey) => translateMessage(key, interfaceLanguage);
	const themeLabel = $derived(themePrefState.value === "auto" ? msg("appearance.autoPreference") : themePrefState.value === "light" ? msg("appearance.lightPreference") : msg("appearance.darkPreference"));
	const accentMessageKeys: Record<string, MessageKey> = {
		blue: "appearance.accentBlue",
		teal: "appearance.accentTeal",
		purple: "appearance.accentPurple",
		pink: "appearance.accentPink",
		orange: "appearance.accentOrange",
		green: "appearance.accentGreen",
	};
	const accentLabel = (id: string) => msg(accentMessageKeys[id] ?? "appearance.accentColor");

	const publicPage = {
		"/pricing": "pricing",
		"/terms": "terms",
		"/privacy": "privacy",
		"/refund-policy": "refund",
		"/contact": "contact",
		"/status": "status",
	}[location.pathname] as
		| "pricing"
		| "terms"
		| "privacy"
		| "refund"
		| "contact"
		| "status"
		| undefined;

	let homeRef: Home | undefined = $state();
	const mountedTabs = createVisitedTabs(() => tabState.active);
	let loggingOut = $state(false);
	let loggingOutEverywhere = $state(false);
	let sessionsDialogOpen = $state(false);
	let diagnosticReportOpen = $state(false);
	let accountMenuOpen = $state(false);
	let editingProfileName = $state(false);
	let profileNameDraft = $state("");
	let profileUsernameDraft = $state("");
	let savingProfileName = $state(false);
	let sessionChecked = $state(false);
	let mobileStatusOpen = $state(false);
	let mobileSwipeStartX = $state<number | null>(null);
	let sidebarDrag = $state<{ pointerId: number; startX: number; startWidth: number } | null>(null);
	let passkeys = $state<Array<{ id: string; name?: string; createdAt: number; lastUsedAt?: number }>>([]);
	let passkeyBusy = $state(false);
	let appliedDeepLink = '';

	const otherOnlineUsers = $derived(
		liveState.onlineUsers.filter((u) => u.userId !== sessionState.sub).map((u) => u.userId),
	);

	function initials(name: string): string {
		return name.slice(0, 2).toUpperCase();
	}

	function saveSidebar(width: number, collapsed: boolean): void {
		void pushSidebarPreferences(width, collapsed).catch(() => showToast("Could not save sidebar preferences.", "error"));
	}

	function onSidebarResizeStart(event: PointerEvent): void {
		if (sidebarState.collapsed) return;
		event.preventDefault();
		event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId);
		sidebarDrag = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarState.width };
	}

	function onSidebarResizeMove(event: PointerEvent): void {
		if (!sidebarDrag || sidebarDrag.pointerId !== event.pointerId) return;
		setSidebarPreferences(sidebarDrag.startWidth + event.clientX - sidebarDrag.startX, false);
	}

	function onSidebarResizeEnd(event: PointerEvent): void {
		if (!sidebarDrag || sidebarDrag.pointerId !== event.pointerId) return;
		const previousWidth = sidebarDrag.startWidth;
		const nextWidth = sidebarState.width;
		sidebarDrag = null;
		setSidebarPreferences(previousWidth, false);
		saveSidebar(nextWidth, false);
	}

	function onSidebarResizeCancel(event: PointerEvent): void {
		if (!sidebarDrag || sidebarDrag.pointerId !== event.pointerId) return;
		setSidebarPreferences(sidebarDrag.startWidth, false);
		sidebarDrag = null;
	}

	function onSidebarResizeKeydown(event: KeyboardEvent): void {
		const delta = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
		const next = event.key === "Home" ? 200 : event.key === "End" ? 360 : sidebarState.width + delta;
		if (!delta && event.key !== "Home" && event.key !== "End") return;
		event.preventDefault();
		event.stopPropagation();
		saveSidebar(next, false);
	}

	const myGrantedPermissions = $derived(sessionPermissionKeys());

	async function loadPasskeys(): Promise<void> {
		if (!sessionState.loggedIn) return;
		const response = await fetch("/v1/auth/passkeys");
		if (!response.ok) return;
		const data = (await response.json()) as { passkeys?: typeof passkeys };
		passkeys = data.passkeys ?? [];
	}

	async function registerPasskey(): Promise<void> {
		passkeyBusy = true;
		try {
			const optionsResponse = await fetch("/v1/auth/passkeys/register/options", { method: "POST" });
			if (!optionsResponse.ok) {
				showToast("Re-authenticate before adding a passkey.", "error");
				return;
			}
			const { startRegistration } = await import("@simplewebauthn/browser");
			const credential = await startRegistration({ optionsJSON: await optionsResponse.json() });
			const name = await promptDialog("Name this passkey (optional)", { confirmLabel: "Save passkey" });
			if (name === null) return;
			const response = await fetch("/v1/auth/passkeys/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...credential, name }),
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
				showToast(body.message ?? body.error ?? "Passkey registration failed.", "error");
				return;
			}
			await loadPasskeys();
			showToast("Passkey added.", "success");
		} catch (error) {
			showToast(error instanceof Error ? error.message : "Passkey registration was canceled.", "error");
		} finally {
			passkeyBusy = false;
		}
	}

	async function removePasskey(id: string): Promise<void> {
		if (!(await confirmDialog("Remove this passkey?", { confirmLabel: "Remove", variant: "destructive" }))) return;
		passkeyBusy = true;
		try {
			const response = await fetch(`/v1/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
			if (!response.ok) {
				showToast("Re-authenticate before removing a passkey.", "error");
				return;
			}
			await loadPasskeys();
			showToast("Passkey removed.", "success");
		} finally {
			passkeyBusy = false;
		}
	}

	$effect(() => {
		if (sessionState.loggedIn) void loadPasskeys();
	});

	void registerServiceWorker().then((registration) => {
		if (registration) initPwaUpdateWatcher(registration);
	});
	initInstallPromptWatcher();

	const TABS: { id: TabId; label: MessageKey; requires?: bigint[] }[] = [
		{ id: "home", label: "nav.home" },
		{ id: "billing", label: "nav.plans" },
		{
			id: "keys",
			label: "nav.apiKeys",
			requires: [
				PermissionFlag.requestApiKeys,
				PermissionFlag.createApiKeys,
				PermissionFlag.viewApiKeys,
				PermissionFlag.manageApiKeys,
			],
		},
		{ id: "logs", label: "nav.logs", requires: [PermissionFlag.viewLogs] },
		{ id: "insights", label: "nav.insights" },
		{ id: "docs", label: "nav.docs" },
		{ id: "settings", label: "nav.settings" },
	];

	const visibleTabs = $derived.by(() => {
		const accessibleTabs = TABS.filter((t) => {
			if (t.id === "settings") return sessionCanSeeSettings();
			if (t.id === "keys" && sessionState.freeTier) return false;
			if (t.id === "insights" && !sessionCanViewOperationalDashboard()) return false;
			return !t.requires || sessionHasAnyPermission(t.requires);
		});
		const order = navigationPreferencesState.order;
		return [...accessibleTabs].sort((left, right) => {
			const leftPinned = navigationPreferencesState.pinned.includes(left.id);
			const rightPinned = navigationPreferencesState.pinned.includes(right.id);
			return Number(rightPinned) - Number(leftPinned) || order.indexOf(left.id) - order.indexOf(right.id);
		});
	});
	const canViewOperationalDashboard = $derived(sessionCanViewOperationalDashboard());
	const pinnedTabs = $derived(visibleTabs.filter((tab) => navigationPreferencesState.pinned.includes(tab.id)));
	const unpinnedTabs = $derived(visibleTabs.filter((tab) => !navigationPreferencesState.pinned.includes(tab.id)));

	async function doLogout(): Promise<void> {
		loggingOut = true;
		try {
			await logout();
		} finally {
			loggingOut = false;
		}
	}

	async function doLogoutEverywhere(): Promise<void> {
		if (
			!(await confirmDialog(
				"Sign out every device and browser signed in as you, including this one?",
				{ confirmLabel: "Log out everywhere" },
			))
		)
			return;
		loggingOutEverywhere = true;
		try {
			await logoutEverywhere();
		} finally {
			loggingOutEverywhere = false;
		}
	}

	async function tryPasskeyReauthentication(): Promise<boolean> {
		try {
			const optionsResponse = await fetch("/v1/auth/passkeys/reauth/options", { method: "POST" });
			if (!optionsResponse.ok) return false;
			const credential = await startAuthentication({ optionsJSON: await optionsResponse.json() });
			const result = await reauthenticateWithPasskey(credential);
			if (!result.ok) showToast(result.error ?? "Reauthentication failed.", "error");
			return result.ok;
		} catch (error) {
			showToast(error instanceof Error ? error.message : "Passkey reauthentication was canceled.", "error");
			return false;
		}
	}

	async function doDeleteAccount(): Promise<void> {
		if (sessionState.sub === "root") return;
		if (!(await confirmDialog("Delete your dkrypt account and personal data? This cannot be undone.", { confirmLabel: "Continue", variant: "destructive" }))) return;
		const confirmation = await promptDialog("Type DELETE MY ACCOUNT to confirm.", { confirmLabel: "Confirm deletion" });
		if (confirmation !== "DELETE MY ACCOUNT") {
			showToast("Account deletion was not confirmed.", "error");
			return;
		}
		const passkeyReauthenticated = passkeys.length > 0 ? await tryPasskeyReauthentication() : false;
		if (!passkeyReauthenticated && sessionState.sub === "root") {
			const password = await promptDialog("Enter your administrator password to continue.", { type: "password" });
			if (!password) return;
			const reauth = await reauthenticate({ password });
			if (!reauth.ok) {
				showToast(reauth.error ?? "Reauthentication failed.", "error");
				return;
			}
		} else if (!passkeyReauthenticated && sessionState.mfa?.enabled) {
			const mfaToken = await promptDialog("Enter your authenticator or recovery code to continue.", { type: "password" });
			if (!mfaToken) return;
			const reauth = await reauthenticate({ mfaToken });
			if (!reauth.ok) {
				showToast(reauth.error ?? "Reauthentication failed.", "error");
				return;
			}
		}
		const result = await deleteAccount(confirmation);
		if (!result.ok) {
			showToast(result.error ?? "The account could not be deleted.", "error");
			return;
		}
		accountMenuOpen = false;
		window.location.assign("/");
	}

	function startEditingProfileName(): void {
		profileNameDraft = sessionState.displayName ?? "";
		profileUsernameDraft = sessionState.username ?? "";
		editingProfileName = true;
	}

	function connectIdentity(provider: "github" | "discord"): void {
		window.location.assign(`/v1/auth/${provider}/connect`);
	}

	async function disconnectIdentity(provider: "github" | "discord"): Promise<void> {
		const previewResponse = await fetch(`/v1/auth/connections/${provider}/preview`);
		if (!previewResponse.ok) {
			showToast("Could not review this sign-in method.", "error");
			return;
		}
		const preview = await previewResponse.json() as { canUnlink: boolean; affectedCategories: string[] };
		if (!preview.canUnlink) {
			showToast("Connect another usable sign-in method before removing this one.", "error");
			return;
		}
		if (!(await confirmDialog(`Disconnect ${provider === "github" ? "GitHub" : "Discord"}? This changes ${preview.affectedCategories.join(' and ')}.`, { confirmLabel: "Disconnect", variant: "destructive" }))) return;
		if (passkeys.length > 0 && !(await tryPasskeyReauthentication())) return;
		const response = await fetch(`/v1/auth/connections/${provider}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: 'DISCONNECT' }) });
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			showToast(body.error ?? "Could not disconnect this sign-in method.", "error");
			return;
		}
		await refreshSession();
		showToast(`${provider === "github" ? "GitHub" : "Discord"} disconnected.`, "success");
	}

	let processedLinkReview = false;
	$effect(() => {
		if (!sessionChecked || !sessionState.loggedIn || processedLinkReview) return;
		const id = new URLSearchParams(location.search).get('link_review');
		if (!id) return;
		processedLinkReview = true;
		void (async () => {
			const response = await fetch(`/v1/auth/link-review/${encodeURIComponent(id)}`);
			if (!response.ok) { showToast('Account link review expired. Try connecting again.', 'error'); return; }
			const preview = await response.json() as { provider: string; willMerge: boolean; categories: string[] };
			const action = preview.willMerge ? 'MERGE ACCOUNTS' : 'LINK ACCOUNT';
			const accepted = await confirmDialog(`${preview.willMerge ? 'Merge accounts' : 'Link sign-in method'} with ${preview.provider}? Affected data: ${preview.categories.join(', ')}. No other account identity is shown.`, { confirmLabel: preview.willMerge ? 'Merge accounts' : 'Link account', variant: preview.willMerge ? 'destructive' : 'default' });
			if (!accepted) return;
			if (passkeys.length > 0 && !(await tryPasskeyReauthentication())) return;
			const confirmResponse = await fetch(`/v1/auth/link-review/${encodeURIComponent(id)}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: action }) });
			if (!confirmResponse.ok) { const body = await confirmResponse.json().catch(() => ({})); showToast(body.message ?? body.error ?? 'Sign in again to confirm this account change.', 'error'); return; }
			const url = new URL(location.href);
			url.searchParams.delete('link_review');
			history.replaceState(null, '', url.pathname + url.search + url.hash);
			await refreshSession();
			showToast(preview.willMerge ? 'Accounts merged' : 'Sign-in method linked', 'success');
		})();
	});

	async function saveProfileName(): Promise<void> {
		savingProfileName = true;
		try {
			const result = await updateProfile(profileNameDraft, profileUsernameDraft);
			if (!result.ok) {
				showToast(
					result.error ?? "Could not update profile name.",
					"error",
				);
				return;
			}
			editingProfileName = false;
			showToast("Profile updated.", "success");
		} finally {
			savingProfileName = false;
		}
	}

	$effect(() => {
		void refreshSession().finally(() => {
			sessionChecked = true;
		});
	});

	$effect(() => {
		if (!sessionChecked || !sessionState.loggedIn) return;
		const deepLinkKey = `${sessionState.sub}:${location.search}`;
		if (deepLinkKey === appliedDeepLink) return;
		appliedDeepLink = deepLinkKey;
		const jobId = getQueryParam('job');
		const artifactId = getQueryParam('artifact');
		if (jobId) {
			jobDetailJumpState.id = jobId;
			setActiveTab('home');
		} else if (artifactId) {
			artifactDetailJumpState.id = artifactId;
			setActiveTab('home');
		}
	});

	$effect(() => {
		if (sessionState.loggedIn) connectLive();
		else disconnectLive();
	});

	$effect(() => {
		if (
			sessionState.loggedIn &&
			!visibleTabs.some((t) => t.id === tabState.active)
		)
			setActiveTab("home");
	});

	const BASE_TITLE = "dkrypt";

	$effect(() => {
		if (publicPage) {
			const title = {
				pricing: "Pricing",
				terms: "Terms of Service",
				privacy: "Privacy Notice",
				refund: "Refund Policy",
				contact: "Contact",
				status: "Service Status",
			}[publicPage];
			document.title = `${title} · ${BASE_TITLE}`;
			return;
		}
		if (!sessionState.loggedIn) {
			document.title = BASE_TITLE;
			return;
		}
		const active = liveState.overview?.activeJobs.length ?? 0;
		const failed = myDecryptsState.items.filter(
			(d) => d.status === "failed",
		).length;
		const count = active + failed;
		document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
	});

	let awaitingTabJump = $state(false);
	let tabJumpTimer: ReturnType<typeof setTimeout> | undefined;

	function onKeydown(e: KeyboardEvent): void {
		const typingInField = ["INPUT", "TEXTAREA", "SELECT"].includes(
			(document.activeElement as HTMLElement)?.tagName ?? "",
		);
		const bindings = shortcutBindingsState.value;
		if (((e.metaKey || e.ctrlKey) && `Mod+${e.key.toUpperCase()}` === bindings.palette) || (!e.metaKey && !e.ctrlKey && !e.altKey && !typingInField && e.key.toLowerCase() === bindings.palette)) {
			e.preventDefault();
			openPalette();
			return;
		}
		if (awaitingTabJump) {
			awaitingTabJump = false;
			clearTimeout(tabJumpTimer);
			const target = (['home', 'billing', 'keys', 'logs', 'insights', 'docs', 'settings'] as TabId[]).find((tab) => bindings[tab] === e.key.toLowerCase());
			if (target && visibleTabs.some((t) => t.id === target)) {
				e.preventDefault();
				setActiveTab(target);
			}
			return;
		}
		if (e.key === bindings.jumpPrefix && !typingInField) {
			e.preventDefault();
			awaitingTabJump = true;
			tabJumpTimer = setTimeout(() => (awaitingTabJump = false), 900);
			return;
		}
		if (e.key === bindings.focusSearch && !typingInField && tabState.active === "home") {
			e.preventDefault();
			homeRef?.focusSearch();
			return;
		}
		if (e.key === bindings.batch && !typingInField && tabState.active === "home") {
			e.preventDefault();
			homeRef?.openBatch();
			return;
		}
		if (e.key === bindings.help && !typingInField) {
			e.preventDefault();
			openHelp();
		}
	}

	function onMobilePointerDown(event: PointerEvent): void {
		if (window.innerWidth >= 1024) return;
		mobileSwipeStartX = event.clientX;
	}

	function onMobilePointerUp(event: PointerEvent): void {
		if (window.innerWidth >= 1024 || mobileSwipeStartX === null) return;
		const distance = event.clientX - mobileSwipeStartX;
		if (!mobileStatusOpen && mobileSwipeStartX >= window.innerWidth - 32 && distance < -48) mobileStatusOpen = true;
		if (mobileStatusOpen && distance > 64) mobileStatusOpen = false;
		mobileSwipeStartX = null;
	}

	const THEME_CYCLE = ["dark", "light", "auto"] as const;

	function cycleTheme(): void {
		const next =
			THEME_CYCLE[
				(THEME_CYCLE.indexOf(themePrefState.value) + 1) %
					THEME_CYCLE.length
			];
		setTheme(next);
		void pushThemePref(next);
	}

	function chooseAccent(id: string): void {
		setAccent(id);
		void pushAccentPref(id);
	}

	function toggleSound(): void {
		const next = !soundEnabledState.value;
		setSoundEnabled(next);
		void pushSoundPref(next);
	}

	function toggleHighContrast(): void {
		const next = !highContrastState.value;
		setHighContrast(next);
		void pushHighContrastPref(next);
	}

	function chooseDensity(value: string): void {
		if (value !== "comfortable" && value !== "compact") return;
		void pushDensityPref(value);
	}

	function chooseFormattingLocale(value: string): void {
		if (!isFormattingLocalePreference(value)) return;
		setFormattingLocale(value);
		void pushFormattingLocale(value);
	}

	function chooseInterfaceLanguage(value: string): void {
		if (!isInterfaceLanguagePreference(value)) return;
		setInterfaceLanguage(value);
		void pushInterfaceLanguage(value);
	}

	function localizedPermissionsSummary(): string {
		const summary = permissionsSummary(sessionBits());
		if (summary === "administrator") return msg("account.permissionAdministrator");
		if (summary === "viewer") return msg("account.permissionViewer");
		return msg("account.permissionCustom");
	}
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onMobilePointerDown} onpointerup={onMobilePointerUp} />

<Toaster theme={themeState.value} richColors position="bottom-right" />

{#if publicPage === "pricing"}
	<PublicPricing />
{:else if publicPage === "terms"}
	<LegalPage document="terms" />
{:else if publicPage === "privacy"}
	<LegalPage document="privacy" />
{:else if publicPage === "refund"}
	<LegalPage document="refund" />
{:else if publicPage === "contact"}
	<ContactPage />
{:else if publicPage === "status"}
	<PublicStatus />
{:else if !sessionChecked}
	<div class="min-h-screen"></div>
{:else if !sessionState.loggedIn}
	<Login />
{:else if sessionState.mfa?.required}
	<MfaVerification />
{:else}
	<div class="app-shell min-h-screen bg-background">
		{#if canViewOperationalDashboard}
			<MaintenanceBanner />
		{:else if liveState.overview?.serviceStatus}
			<div class="border-b border-border bg-panel px-4 py-2 text-center text-xs text-muted" role="status">{liveState.overview.serviceStatus === "operational" ? "All systems operational" : "dkrypt is in maintenance mode. Some requests may be delayed."}</div>
		{/if}
		<div class="flex min-h-screen">
			<aside class="app-sidebar relative hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex" style:width={`${sidebarState.collapsed ? 64 : sidebarState.width}px`} style:display={focusViewState.enabled ? 'none' : undefined}>
				<div class={cn("border-b border-sidebar-border", sidebarState.collapsed ? "px-2 py-3" : "px-4 py-4")}>
					<div class={cn("flex items-center gap-3", sidebarState.collapsed && "flex-col gap-1")}>
						<div class="bg-sidebar-primary/15 flex size-9 items-center justify-center rounded-lg">
							<Lock class="size-4 text-sidebar-primary" aria-hidden="true" />
						</div>
						{#if !sidebarState.collapsed}<div class="min-w-0 flex-1">
							<div class="text-sm font-semibold tracking-tight text-sidebar-foreground">dkrypt</div>
							<div class="truncate text-xs text-sidebar-foreground/60" lang={interfaceLanguage}>{msg("brand.operationsConsole")}</div>
						</div>{/if}
						<Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" onclick={() => saveSidebar(sidebarState.width, !sidebarState.collapsed)} aria-label={sidebarState.collapsed ? "Expand sidebar" : "Collapse sidebar"} title={sidebarState.collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!sidebarState.collapsed}>
							{#if sidebarState.collapsed}<PanelLeftOpen class="h-4 w-4" />{:else}<PanelLeftClose class="h-4 w-4" />{/if}
						</Button>
					</div>
				</div>
				<nav class={cn("flex flex-1 flex-col gap-1 overflow-y-auto", sidebarState.collapsed ? "p-2" : "p-4")} aria-label={msg("nav.workspace")} lang={interfaceLanguage}>
					{#if !sidebarState.collapsed}<div class="mb-2 px-3 text-[10px] font-semibold tracking-[0.14em] text-sidebar-foreground/65 uppercase">{msg("nav.workspace")}</div>{/if}
					{#if pinnedTabs.length > 0}
						{#if sidebarState.collapsed}<div class="my-2 border-t border-sidebar-border" role="separator" aria-label="Pinned"></div>{:else}<div class="mb-2 mt-3 px-3 text-[10px] font-semibold tracking-[0.14em] text-sidebar-foreground/65 uppercase">Pinned</div>{/if}
					{/if}
					{#each pinnedTabs as t (t.id)}
						<Button
							variant={tabState.active === t.id ? "secondary" : "ghost"}
							class={cn("group w-full gap-3 text-sm", sidebarState.collapsed ? "justify-center px-2" : "justify-start px-3", tabState.active === t.id ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" : "text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground")}
							onclick={() => setActiveTab(t.id)}
							title={sidebarState.collapsed ? msg(t.label) : undefined}
							aria-label={sidebarState.collapsed ? msg(t.label) : undefined}
							aria-current={tabState.active === t.id ? "page" : undefined}
						>
							<TabIcon id={t.id} class="size-4" />
							{#if !sidebarState.collapsed}<span>{msg(t.label)}</span>{/if}
						</Button>
					{/each}
					{#if unpinnedTabs.length > 0 && pinnedTabs.length > 0}
						{#if sidebarState.collapsed}<div class="my-2 border-t border-sidebar-border" role="separator" aria-label="More navigation items"></div>{:else}<div class="mb-2 mt-3 px-3 text-[10px] font-semibold tracking-[0.14em] text-sidebar-foreground/65 uppercase">More</div>{/if}
					{/if}
					{#each unpinnedTabs as t (t.id)}
						<Button
							variant={tabState.active === t.id ? "secondary" : "ghost"}
							class={cn("group w-full gap-3 text-sm", sidebarState.collapsed ? "justify-center px-2" : "justify-start px-3", tabState.active === t.id ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" : "text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground")}
							onclick={() => setActiveTab(t.id)}
							title={sidebarState.collapsed ? msg(t.label) : undefined}
							aria-label={sidebarState.collapsed ? msg(t.label) : undefined}
							aria-current={tabState.active === t.id ? "page" : undefined}
						>
							<TabIcon id={t.id} class="size-4" />
							{#if !sidebarState.collapsed}<span>{msg(t.label)}</span>{/if}
						</Button>
					{/each}
				</nav>
				{#if !sidebarState.collapsed}
					<button type="button" aria-label={`Resize sidebar, ${sidebarState.width} pixels wide. Use arrow keys to adjust.`} title="Drag to resize sidebar" class="absolute inset-y-0 right-0 w-2 cursor-col-resize touch-none bg-transparent hover:bg-sidebar-primary/40 focus-visible:bg-sidebar-primary/40 focus-visible:outline-none" onpointerdown={onSidebarResizeStart} onpointermove={onSidebarResizeMove} onpointerup={onSidebarResizeEnd} onpointercancel={onSidebarResizeCancel} onkeydown={onSidebarResizeKeydown}></button>
				{/if}
			</aside>
			<div class="min-w-0 flex-1">
		<header style:display={focusViewState.enabled ? 'none' : undefined}
			class="glass-topbar sticky top-0 z-30 flex flex-wrap items-center gap-3 px-3 py-3 sm:px-5 lg:flex-nowrap xl:px-8"
		>
			<div class="flex items-center gap-3 lg:hidden">
				<Lock class="brand-mark" aria-hidden="true" />
				<h1 class="text-[15px] font-semibold tracking-tight">dkrypt</h1>
			</div>
			<div class="hidden min-w-0 flex-1 lg:block">
				<div class="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase" lang={interfaceLanguage}>{msg("nav.workspace")}</div>
				<div class="truncate text-sm font-semibold text-foreground" lang={interfaceLanguage}>{msg(visibleTabs.find((tab) => tab.id === tabState.active)?.label ?? "nav.workspace")}</div>
			</div>
			<div class="min-w-0 flex flex-1 flex-wrap items-center justify-end gap-2.5 lg:flex-none">
				<HeaderOnlineUsers />
				<BackgroundTaskTray />
				<a
					href="https://github.com/castdrian/dkrypt"
					target="_blank"
					rel="noopener noreferrer"
					class={buttonVariants("secondary", "icon")}
					aria-label="Open dkrypt on GitHub"
					title="Open dkrypt on GitHub"
				>
					<svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 3.5c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>
				</a>
				<a
					href={DISCORD_INVITE_URL}
					target="_blank"
					rel="noopener noreferrer"
					class={buttonVariants("discord", "icon")}
					lang={interfaceLanguage}
					aria-label={msg("social.discord")}
					title={msg("social.discord")}
				>
					<svg width="19" height="15" viewBox="0 0 64 48" fill="none" aria-hidden="true">
						<path d="M40.575 0C39.9562 1.09866 39.4006 2.2352 38.8954 3.397C34.0967 2.67719 29.2096 2.67719 24.3982 3.397C23.9057 2.2352 23.3374 1.09866 22.7186 0C18.2104 0.770324 13.8157 2.12155 9.64839 4.02841C1.38951 16.2652 -0.845688 28.1863 0.265599 39.9432C5.10222 43.517 10.5197 46.2447 16.2909 47.9874C17.5916 46.2447 18.7407 44.3883 19.7257 42.4562C17.8568 41.7616 16.0509 40.8903 14.3208 39.88C14.7755 39.5517 15.2175 39.2107 15.6468 38.8824C25.7873 43.6559 37.5316 43.6559 47.6847 38.8824C48.1141 39.236 48.5561 39.577 49.0107 39.88C47.2806 40.9029 45.4748 41.7616 43.5931 42.4688C44.5781 44.4009 45.7273 46.2573 47.028 48C52.7991 46.2573 58.2167 43.5422 63.0533 39.9684C64.3666 26.3299 60.8055 14.5099 53.6452 4.04104C49.4905 2.13418 45.0959 0.782952 40.5876 0.0252565L40.575 0ZM21.1401 32.7072C18.0209 32.7072 15.4321 29.8785 15.4321 26.3804C15.4321 22.8824 17.9199 20.041 21.1275 20.041C24.3351 20.041 26.886 22.895 26.8354 26.3804C26.7848 29.8658 24.3224 32.7072 21.1401 32.7072ZM42.1788 32.7072C39.047 32.7072 36.4834 29.8785 36.4834 26.3804C36.4834 22.8824 38.9712 20.041 42.1788 20.041C45.3864 20.041 47.9246 22.895 47.8741 26.3804C47.8236 29.8658 45.3611 32.7072 42.1788 32.7072Z" fill="currentColor" />
					</svg>
				</a>
				<a
					href={KOFI_URL}
					target="_blank"
					rel="noopener noreferrer"
					class={buttonVariants("secondary", "icon")}
					lang={interfaceLanguage}
					aria-label={msg("social.kofi")}
					title={msg("social.kofi")}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="currentColor"
						aria-hidden="true"
					>
						<path
							d="M11.351 2.715c-2.7 0-4.986.025-6.83.26C2.078 3.285 0 5.154 0 8.61c0 3.506.182 6.13 1.585 8.493 1.584 2.701 4.233 4.182 7.662 4.182h.83c4.209 0 6.494-2.234 7.637-4a9.5 9.5 0 0 0 1.091-2.338C21.792 14.688 24 12.22 24 9.208v-.415c0-3.247-2.13-5.507-5.792-5.87-1.558-.156-2.65-.208-6.857-.208m0 1.947c4.208 0 5.09.052 6.571.182 2.624.311 4.13 1.584 4.13 4v.39c0 2.156-1.792 3.844-3.87 3.844h-.935l-.156.649c-.208 1.013-.597 1.818-1.039 2.546-.909 1.428-2.545 3.064-5.922 3.064h-.805c-2.571 0-4.831-.883-6.078-3.195-1.09-2-1.298-4.155-1.298-7.506 0-2.181.857-3.402 3.012-3.714 1.533-.233 3.559-.26 6.39-.26m6.547 2.287c-.416 0-.65.234-.65.546v2.935c0 .311.234.545.65.545 1.324 0 2.051-.754 2.051-2s-.727-2.026-2.052-2.026m-10.39.182c-1.818 0-3.013 1.48-3.013 3.142 0 1.533.858 2.857 1.949 3.897.727.701 1.87 1.429 2.649 1.896a1.47 1.47 0 0 0 1.507 0c.78-.467 1.922-1.195 2.623-1.896 1.117-1.039 1.974-2.364 1.974-3.897 0-1.662-1.247-3.142-3.039-3.142-1.065 0-1.792.545-2.338 1.298-.493-.753-1.246-1.298-2.312-1.298"
						/>
					</svg>
				</a>
				<Button
					variant="secondary"
					size="icon"
					onclick={cycleTheme}
					lang={interfaceLanguage}
					aria-label="{msg('appearance.theme')}: {themeLabel} ({msg('appearance.clickToCycle')})"
					title="{msg('appearance.theme')}: {themeLabel} ({msg('appearance.clickToCycle')})"
				>
					{#if themePrefState.value === "auto"}
						<Monitor class="h-4 w-4" />
					{:else if themePrefState.value === "light"}
						<Sun class="h-4 w-4" />
					{:else}
						<Moon class="h-4 w-4" />
					{/if}
				</Button>
				<Button
					variant="secondary"
					size="icon"
					class="hidden lg:inline-flex"
					onclick={() => setFocusView(true)}
					aria-label="Enter focus view"
					title="Enter focus view"
				>
					<Maximize2 class="h-4 w-4" />
				</Button>
				<Button
					variant="secondary"
					size="icon"
					onclick={openPalette}
					lang={interfaceLanguage}
					aria-label={msg("command.open")}
					title={msg("command.title")}
				>
					<Command class="h-4 w-4" />
				</Button>
				{#if sessionState.loggedIn}
					<Button variant="ghost" size="icon" onclick={() => (diagnosticReportOpen = true)} aria-label="Report an issue" title="Report an issue"><MessageSquareWarning class="h-4 w-4" /></Button>
				{/if}
				<Button
					variant={screenSharePrivacyState.enabled ? "secondary" : "ghost"}
					size="icon"
					aria-pressed={screenSharePrivacyState.enabled}
					aria-label={screenSharePrivacyState.enabled ? "Turn off screen-share privacy" : "Turn on screen-share privacy"}
					title={screenSharePrivacyState.enabled ? "Screen-share privacy is on" : "Mask sensitive identifiers while screen sharing"}
					onclick={() => setScreenSharePrivacy(!screenSharePrivacyState.enabled)}
				>
					{#if screenSharePrivacyState.enabled}<EyeOff class="h-4 w-4" />{:else}<Eye class="h-4 w-4" />{/if}
				</Button>
				{#if screenSharePrivacyState.enabled}<Badge variant="secondary" class="hidden text-[10px] sm:inline-flex">Privacy on</Badge>{/if}
				<WhatsNewButton />
				<NotificationBell />
				<DropdownMenu.Root bind:open={accountMenuOpen}>
					<DropdownMenu.Trigger
						class="relative shrink-0 cursor-pointer rounded-full border border-border transition-colors hover:border-primary"
						lang={interfaceLanguage}
						aria-label={`${msg("account.menu")} ${initials(sessionState.displayName ?? sessionState.sub ?? "")}`}
						title={msg("account.menu")}
					>
						<Avatar
							src={sessionState.avatarUrl}
							fallback={initials(sessionState.displayName ?? sessionState.sub ?? "")}
							class="size-9"
						/>
						{#if otherOnlineUsers.length > 0}
							<span
								class="bg-ok border-panel absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2"
							></span>
						{/if}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content
							class="account-menu z-50 max-h-[calc(100dvh-5rem)] w-72 overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md"
							lang={interfaceLanguage}
							sideOffset={8}
							align="end"
						>
							{#if editingProfileName}
								<form
									class="mb-3 grid gap-2"
									onsubmit={(event) => {
										event.preventDefault();
										void saveProfileName();
									}}
								>
									<Input
										aria-label={msg("account.profileName")}
										maxlength={64}
										bind:value={profileNameDraft}
										class="h-8"
										autofocus
									/>
									<Input
										aria-label="Username"
										maxlength={40}
										bind:value={profileUsernameDraft}
										class="h-8"
									/>
									<div class="flex gap-2">
									<Button
										size="sm"
										type="submit"
										loading={savingProfileName}>{msg("account.save")}</Button
									>
									<Button
										size="sm"
										type="button"
										variant="secondary"
										onclick={() =>
											(editingProfileName = false)}
										>{msg("account.cancel")}</Button
									>
									</div>
								</form>
							{:else}
								<div class="mb-1 flex items-center gap-1.5">
									<div
										class="min-w-0 flex-1 truncate text-sm font-medium"
									>
						<span data-sensitive="true">{sessionState.displayName ?? sessionState.sub}</span>
									</div>
									{#if sessionState.sub !== "root"}
										<Button
											variant="ghost"
											size="icon"
											class="h-7 w-7"
											onclick={startEditingProfileName}
											aria-label={msg("account.editProfileName")}
											title={msg("account.editProfileName")}
										>
											<Pencil class="h-3.5 w-3.5" />
										</Button>
									{/if}
								</div>
								{#if sessionState.username}
									<div
										class="mb-1 truncate text-xs text-muted"
									>
						<span data-sensitive="true">@{sessionState.username}</span>
									</div>
								{/if}
							{/if}
							<div class="mb-3 text-xs text-muted">
								{localizedPermissionsSummary()}
							</div>
							{#if sessionState.identities?.length}
								<div class="mb-3 flex flex-col gap-1.5">
									{#each sessionState.identities as identity (`${identity.provider}:${identity.username}`)}
										<div
											class="flex min-w-0 items-center gap-2 text-xs text-muted"
										>
											{#if identity.avatarUrl}
												<img
													src={identity.avatarUrl}
													alt=""
													class="h-5 w-5 shrink-0 rounded-full object-cover"
												/>
											{/if}
											<span class="font-medium text-text"
												>{identity.provider === "github"
													? "GitHub"
													: "Discord"}</span
											>
						<span class="min-w-0 flex-1 break-all" data-sensitive="true"
											>{identity.displayName} · @{identity.username}</span
										>
											{#if (sessionState.identities?.length ?? 0) > 1}
											<Button
												variant="link"
												size="sm"
												class="ml-auto h-auto shrink-0 p-0 text-xs text-muted hover:text-destructive"
												onclick={() => disconnectIdentity(identity.provider)}
											>
											{msg("account.disconnect")}
											</Button>
											{/if}
										</div>
									{/each}
								</div>
							{/if}
							{#if sessionState.sub !== "root"}
								<div class="border-border mb-3 border-t pt-3">
									<div class="mb-1.5 text-[11px] text-muted">{msg("account.loginConnections")}</div>
									<div class="flex flex-wrap gap-1.5">
										{#if sessionState.githubOauthEnabled && !sessionState.linkedProviders?.includes("github")}
											<Button size="sm" variant="secondary" onclick={() => connectIdentity("github")}>{msg("account.connectGitHub")}</Button>
										{/if}
										{#if sessionState.discordOauthEnabled && !sessionState.linkedProviders?.includes("discord")}
											<Button size="sm" variant="secondary" onclick={() => connectIdentity("discord")}>{msg("account.connectDiscord")}</Button>
										{/if}
										{#if sessionState.linkedProviders?.length === 2}
											<span class="text-xs text-muted">{msg("account.providersConnected")}</span>
										{/if}
									</div>
								</div>
							{/if}
								{#if myGrantedPermissions.length > 0}
									<div class="mb-3 flex flex-wrap gap-1.5">
									{#each myGrantedPermissions as label (label)}
										<Badge variant="default">{translatePermissionLabel(label, interfaceLanguage)}</Badge>
									{/each}
									</div>
								{/if}
								<div class="border-border mb-3 border-t pt-3">
									<div class="mb-1.5 flex items-center justify-between gap-2">
										<div>
											<div class="text-[13px]">{msg("account.passkeys")}</div>
											<div class="text-[11px] text-muted">{msg("account.passkeysDescription")}</div>
										</div>
										<Button size="sm" variant="secondary" loading={passkeyBusy} onclick={() => void registerPasskey()}>
											<KeyRound class="h-3.5 w-3.5" />
											{msg("account.addPasskey")}
										</Button>
									</div>
									{#if passkeys.length > 0}
										<div class="flex flex-col gap-1.5">
											{#each passkeys as passkey (passkey.id)}
												<div class="flex items-center gap-2 text-xs text-muted">
													<KeyRound class="h-3.5 w-3.5 shrink-0" />
													<span class="min-w-0 flex-1 truncate">{passkey.name ?? msg("account.unnamedPasskey")}</span>
													<Button variant="link" size="sm" class="h-auto shrink-0 p-0 text-xs text-muted hover:text-destructive" onclick={() => void removePasskey(passkey.id)}>{msg("account.removePasskey")}</Button>
												</div>
											{/each}
										</div>
									{:else}
										<div class="text-[11px] text-muted">{msg("account.noPasskeys")}</div>
									{/if}
								</div>

								{#if otherOnlineUsers.length > 0}
								<div class="border-border mb-3 border-t pt-3">
									<div class="mb-1.5 text-[11px] text-muted">
										{otherOnlineUsers.length} {msg(otherOnlineUsers.length === 1 ? "account.otherUserOnline" : "account.otherUsersOnline")}
									</div>
									<div class="flex flex-wrap gap-1">
										{#each otherOnlineUsers as u (u)}
											<Badge variant="secondary" title={u}
												>{u}</Badge
											>
										{/each}
									</div>
								</div>
							{/if}

							<div class="border-border mb-3 border-t pt-3" lang={interfaceLanguage}>
								<div class="mb-2 text-[11px] font-semibold text-muted">{msg("appearance.title")}</div>
								<div class="mb-1.5 flex items-center justify-between gap-3">
									<div class="text-[13px]">{msg("appearance.jobSound")}</div>
									<Button
										variant="secondary"
										size="icon"
										onclick={toggleSound}
										aria-label={msg("appearance.toggleJobSound")}
										title={soundEnabledState.value ? msg("appearance.soundOn") : msg("appearance.soundOff")}
									>
										{#if soundEnabledState.value}
											<Volume2 class="h-4 w-4" />
										{:else}
											<VolumeX class="h-4 w-4" />
										{/if}
									</Button>
				</div>
				<div class="mb-2 flex items-center justify-between gap-3">
					<label for="display-density" class="text-[13px]">{msg("appearance.density")}</label>
					<select
						id="display-density"
						class="rounded-md border border-border bg-background px-2 py-1 text-xs text-text focus-visible:ring-2 focus-visible:ring-accent"
						value={densityState.value}
						onchange={(event) => chooseDensity(event.currentTarget.value)}
					>
						<option value="comfortable">{msg("appearance.comfortable")}</option>
						<option value="compact">{msg("appearance.compact")}</option>
					</select>
				</div>
				<div class="mb-2 flex items-center justify-between gap-3">
									<div>
										<div class="text-[13px]">{msg("appearance.highContrast")}</div>
										<div class="text-[11px] text-muted">{msg("appearance.highContrastDescription")}</div>
									</div>
									<Button
										variant="secondary"
										size="sm"
										onclick={toggleHighContrast}
										aria-label={msg("appearance.highContrastMode")}
										aria-pressed={highContrastState.value}
									>
										{highContrastState.value ? msg("appearance.on") : msg("appearance.off")}
									</Button>
								</div>
								<div class="mb-3 flex items-center justify-between gap-3">
									<label for="interface-language" class="text-[13px]">{msg("appearance.interfaceLanguage")}</label>
									<select
										id="interface-language"
										class="rounded-md border border-border bg-background px-2 py-1 text-xs text-text focus-visible:ring-2 focus-visible:ring-accent"
										value={interfaceLanguageState.value}
										onchange={(event) => chooseInterfaceLanguage(event.currentTarget.value)}
										aria-label={msg("appearance.interfaceLanguage")}
									>
										<option value="system">{msg("appearance.system")}</option>
										<option value="en">{msg("appearance.english")}</option>
										<option value="de">{msg("appearance.german")}</option>
									</select>
								</div>
								<div class="mb-3 flex items-center justify-between gap-3">
									<label for="formatting-locale" class="text-[13px]">{msg("appearance.dateNumberFormat")}</label>
									<select
										id="formatting-locale"
										class="rounded-md border border-border bg-background px-2 py-1 text-xs text-text focus-visible:ring-2 focus-visible:ring-accent"
										value={formattingLocaleState.value}
										onchange={(event) => chooseFormattingLocale(event.currentTarget.value)}
										aria-label={msg("appearance.dateNumberFormat")}
									>
										<option value="system">{msg("appearance.system")}</option>
										<option value="en">{msg("appearance.english")}</option>
										<option value="de">{msg("appearance.german")}</option>
									</select>
								</div>
								<div class="mb-1.5 text-[11px] text-muted">{msg("appearance.accentColor")}</div>
								<div class="flex flex-wrap gap-1.5">
									{#each ACCENT_PRESETS as preset (preset.id)}
										{@const label = `${msg("appearance.accentColor")}: ${accentLabel(preset.id)}`}
										<Button
											variant="ghost"
											size="icon"
											class="h-5 w-5 rounded-full border-2 p-0"
											style="background-color: {themeState.value ===
											'light'
												? preset.light
												: preset.dark}; border-color: {accentState.value ===
											preset.id
												? 'var(--color-text)'
												: 'transparent'};"
											onclick={() =>
												chooseAccent(preset.id)}
											aria-pressed={accentState.value === preset.id}
											aria-label={label}
											title={label}
										></Button>
									{/each}
								</div>
							</div>

							<NotificationPreferences {interfaceLanguage} />

							{#if pwaState.canInstall}
								<div class="border-border mb-3 border-t pt-3">
									<Button
										variant="secondary"
										size="sm"
										class="w-full justify-start"
										onclick={() => void promptPwaInstall()}
									>
										<Download class="h-3.5 w-3.5" />
										{msg("pwa.installApp")}
									</Button>
								</div>
							{/if}

							<div
								class="border-border flex flex-col gap-1.5 border-t pt-3"
							>
								<a
									class="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-8 w-full items-center justify-start gap-2 rounded-md px-3 text-xs font-medium transition-colors"
									href={accountExportUrl()}
									download
									onclick={() => (accountMenuOpen = false)}
								>
									<Download class="h-3.5 w-3.5" />
									{msg("account.exportMyData")}
								</a>
								<Button
									variant="secondary"
									size="sm"
									class="w-full justify-start"
									onclick={() => {
										accountMenuOpen = false;
										sessionsDialogOpen = true;
									}}
								>
									<Monitor class="h-3.5 w-3.5" />
									{msg("account.manageSessions")}
								</Button>
								<Button
									variant="secondary"
									size="sm"
									class="w-full justify-start"
									loading={loggingOut}
									onclick={doLogout}
								>
									<LogOut class="h-3.5 w-3.5" />
									{msg("account.logOut")}
								</Button>
								<Button
									variant="destructive"
									size="sm"
									class="w-full"
									loading={loggingOutEverywhere}
									onclick={doLogoutEverywhere}
								>
									{msg("account.logOutEverywhere")}
								</Button>
								{#if sessionState.sub !== "root"}
									<Button
										variant="destructive"
										size="sm"
										class="w-full"
										onclick={() => void doDeleteAccount()}
									>
										<Trash2 class="h-3.5 w-3.5" />
										{msg("account.deleteAccount")}
									</Button>
								{/if}
							</div>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		</header>
		<main
			class={cn("mx-auto px-3 pt-4 sm:px-5 sm:pt-5 lg:px-6 lg:pb-6", focusViewState.enabled ? "max-w-none px-4 pb-6 sm:px-8" : sidebarState.collapsed ? "max-w-[2200px] pb-[calc(5rem+env(safe-area-inset-bottom))]" : "max-w-[1760px] pb-[calc(5rem+env(safe-area-inset-bottom))]")}
		>
			{#if sessionState.freeTier}
				<FreeTierBanner />
			{/if}
			<SessionExpiryBanner />
			<ConnectionBanner />
			<UpdateAvailableBanner />
			<div
				class={tabState.active === "docs" ? "grid grid-cols-1 items-start" : "grid grid-cols-1 items-start gap-4 min-[1440px]:grid-cols-[minmax(0,1fr)_340px] min-[1440px]:gap-5"}
			>
				<div class="workspace-content min-w-0">
					{#if mountedTabs.home}
						<div class:hidden={tabState.active !== "home"}>
							<Home bind:this={homeRef} />
						</div>
					{/if}
					{#if mountedTabs.billing}
						<div class:hidden={tabState.active !== "billing"}>
							<Billing />
						</div>
					{/if}
					{#if mountedTabs.keys}
						<div class:hidden={tabState.active !== "keys"}>
							<Keys />
						</div>
					{/if}
					{#if sessionHasPermission(PermissionFlag.viewLogs) && mountedTabs.logs}
						<div class:hidden={tabState.active !== "logs"}>
							<Logs />
						</div>
					{/if}
					{#if mountedTabs.insights}
						<div class:hidden={tabState.active !== "insights"}>
							<Insights />
						</div>
					{/if}
					{#if mountedTabs.docs}
						<div class:hidden={tabState.active !== "docs"}>
							<Docs />
						</div>
					{/if}
					{#if sessionCanSeeSettings() && mountedTabs.settings}
						<div class:hidden={tabState.active !== "settings"}>
							<Settings />
						</div>
					{/if}
				</div>
				{#if canViewOperationalDashboard && tabState.active !== "docs" && !focusViewState.enabled}
					<div class="hidden min-w-0 flex-col gap-4 min-[1440px]:sticky min-[1440px]:top-6 min-[1440px]:flex">
						<StatusPanel />
					</div>
				{/if}
			</div>
		</main>
		{#if focusViewState.enabled}
			<Button variant="secondary" size="icon" class="fixed top-3 right-3 z-50 shadow-lg" onclick={() => setFocusView(false)} aria-label="Exit focus view" title="Exit focus view"><Minimize2 class="h-4 w-4" /></Button>
		{/if}
		{#if canViewOperationalDashboard && !focusViewState.enabled}
		<Button
			variant="outline"
			size="icon"
			class="fixed top-1/2 right-0 z-40 h-20 w-8 -translate-y-1/2 rounded-l-lg rounded-r-none min-[1440px]:hidden"
			onclick={() => (mobileStatusOpen = true)}
			aria-label="Open status drawer"
		>
			<PanelRightOpen class="h-4 w-4" />
		</Button>
		{/if}
		{#if canViewOperationalDashboard && mobileStatusOpen && !focusViewState.enabled}
			<Button
				variant="ghost"
				type="button"
			class="fixed inset-0 z-40 h-auto w-auto rounded-none bg-black/35 p-0 hover:bg-black/35 min-[1440px]:hidden"
				onclick={() => (mobileStatusOpen = false)}
				aria-label="Close status drawer"
			></Button>
		{/if}
		{#if canViewOperationalDashboard}
		<aside style:display={focusViewState.enabled ? 'none' : undefined}
			class={cn(
				"fixed top-0 right-0 z-50 h-[100dvh] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto border-l border-border bg-panel p-3 pt-[max(0.75rem,env(safe-area-inset-top))] shadow-2xl transition-transform duration-200 min-[1440px]:hidden",
				mobileStatusOpen ? "translate-x-0" : "translate-x-full",
			)}
			aria-label="Status drawer"
			aria-hidden={!mobileStatusOpen}
			inert={!mobileStatusOpen}
		>
			<div class="mb-3 flex items-center justify-between">
				<span class="text-sm font-semibold">Status</span>
				<Button size="sm" variant="secondary" onclick={() => (mobileStatusOpen = false)}>Close</Button>
			</div>
			<StatusPanel />
		</aside>
		{/if}
		<nav style:display={focusViewState.enabled ? 'none' : undefined} class="mobile-primary-nav fixed z-40 flex overflow-x-auto border border-border bg-card p-1 shadow-lg lg:hidden" aria-label={msg("nav.primary")} lang={interfaceLanguage}>
			{#each visibleTabs as t (t.id)}
				<Button
					variant={tabState.active === t.id ? "secondary" : "ghost"}
					class={cn(
						"min-w-13 flex-1 flex-col gap-0.5 rounded-md py-2 text-[10.5px]",
						tabState.active === t.id ? "text-primary" : "text-muted-foreground",
					)}
					onclick={() => setActiveTab(t.id)}
					aria-current={tabState.active === t.id ? "page" : undefined}
					aria-label={msg(t.label)}
				>
						<TabIcon id={t.id} class="size-5" />
					<span class="mobile-tab-label">{msg(t.label)}</span>
				</Button>
			{/each}
		</nav>
	</div>
	</div>
	</div>
{/if}

<QueueDock />
<ConfirmModal />
<PromptModal />
<CommandPalette />
<ShortcutsHelp />
{#if sessionState.loggedIn}<DiagnosticReportDialog bind:open={diagnosticReportOpen} />{/if}
<span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{screenReaderAnnouncementState.text}</span>
<OnboardingTour />
<SessionsDialog
	open={sessionsDialogOpen}
	onOpenChange={(v) => (sessionsDialogOpen = v)}
/>
