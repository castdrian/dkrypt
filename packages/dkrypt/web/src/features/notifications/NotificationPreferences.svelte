<script lang="ts">
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Checkbox from "#lib/components/ui/Checkbox.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import { disablePush, enablePush, getExistingPushSubscription, pushSupported } from "#lib/push";
import { fetchNotificationPrefs, pushNotificationPrefs, sessionState, type NotificationPrefs } from "#lib/session.svelte";
	import { showToast } from "#lib/ui.svelte";
	import { translateMessage, type MessageKey } from "#lib/messages";
	import type { InterfaceLanguage } from "#lib/locale";
	import { testEmail, testPush } from "#lib/api";
	import { X } from "lucide-svelte";

	let { interfaceLanguage }: { interfaceLanguage: InterfaceLanguage } = $props();

	const msg = (key: MessageKey) => translateMessage(key, interfaceLanguage);
	type NotificationPreferenceKey =
		| "pushOnSuccess"
		| "pushOnFailure"
		| "pushOnAlerts"
		| "pushOnKeyExpiry"
		| "emailOnSuccess"
		| "emailOnFailure"
		| "emailOnAlerts"
		| "emailOnKeyExpiry";
	type NotificationPreferenceValues = Required<
		Pick<NotificationPrefs, NotificationPreferenceKey>
	>;
	type NotificationPreferenceCategory = {
		label: MessageKey;
		pushKey: NotificationPreferenceKey;
		pushLabel: MessageKey;
		emailKey: NotificationPreferenceKey;
		emailLabel: MessageKey;
	};
	const notificationCategories: NotificationPreferenceCategory[] = [
		{
			label: "notifications.successfulDecrypts",
			pushKey: "pushOnSuccess",
			pushLabel: "notifications.pushSuccessfulDecrypts",
			emailKey: "emailOnSuccess",
			emailLabel: "notifications.emailSuccessfulDecrypts",
		},
		{
			label: "notifications.failedDecrypts",
			pushKey: "pushOnFailure",
			pushLabel: "notifications.pushFailedDecrypts",
			emailKey: "emailOnFailure",
			emailLabel: "notifications.emailFailedDecrypts",
		},
		{
			label: "notifications.deviceSystemAlerts",
			pushKey: "pushOnAlerts",
			pushLabel: "notifications.pushDeviceSystemAlerts",
			emailKey: "emailOnAlerts",
			emailLabel: "notifications.emailDeviceSystemAlerts",
		},
		{
			label: "notifications.apiKeyExpiring",
			pushKey: "pushOnKeyExpiry",
			pushLabel: "notifications.pushApiKeyExpiring",
			emailKey: "emailOnKeyExpiry",
			emailLabel: "notifications.emailApiKeyExpiring",
		},
	];
	function preferencesWithDefaults(
		prefs: NotificationPrefs,
	): NotificationPreferenceValues {
		return {
			pushOnSuccess: prefs.pushOnSuccess ?? true,
			pushOnFailure: prefs.pushOnFailure ?? true,
			pushOnAlerts: prefs.pushOnAlerts ?? true,
			pushOnKeyExpiry: prefs.pushOnKeyExpiry ?? true,
			emailOnSuccess: prefs.emailOnSuccess ?? false,
			emailOnFailure: prefs.emailOnFailure ?? false,
			emailOnAlerts: prefs.emailOnAlerts ?? false,
			emailOnKeyExpiry: prefs.emailOnKeyExpiry ?? false,
		};
	}
	type NotifPermission = NotificationPermission | "unsupported";
	let notifPermission = $state<NotifPermission>(
		typeof Notification === "undefined" ? "unsupported" : Notification.permission,
	);
	let pushEnabled = $state(false);
	let enablingPush = $state(false);
	let sendingTestPush = $state(false);
	let notificationPreferences = $state(preferencesWithDefaults({}));
	let appNotificationPreferences = $state<NonNullable<NotificationPrefs["appNotificationPreferences"]>>([]);
	let appBundleId = $state("");
	let appFormError = $state("");
	let accountEmail = $state<string | undefined>(undefined);
	let notifyEmail = $state("");
	let emailDownloadLinksOnSuccess = $state(false);
	let emailOnBillingReminders = $state(false);
	let sendingTestEmail = $state(false);
	let appPreferenceWrite = Promise.resolve();

	$effect(() => {
		if (!sessionState.loggedIn) return;
		if (pushSupported()) {
			void getExistingPushSubscription().then((subscription) => {
				pushEnabled = !!subscription;
			});
		}
		void fetchNotificationPrefs().then((prefs) => {
			notificationPreferences = preferencesWithDefaults(prefs);
			accountEmail = prefs.accountEmail;
			notifyEmail = prefs.notifyEmail ?? "";
			emailDownloadLinksOnSuccess = prefs.emailDownloadLinksOnSuccess ?? false;
			emailOnBillingReminders = prefs.emailOnBillingReminders ?? false;
			appNotificationPreferences = prefs.appNotificationPreferences ?? [];
		});
	});

	async function savePreference(
		key: NotificationPreferenceKey,
		value: boolean,
	): Promise<void> {
		notificationPreferences[key] = value;
		await pushNotificationPrefs({ [key]: value });
	}

	async function saveNotifyEmail(): Promise<void> {
		await pushNotificationPrefs({ notifyEmail: notifyEmail.trim() });
	}

	async function saveDeliveryPreference(key: "emailDownloadLinksOnSuccess" | "emailOnBillingReminders", value: boolean): Promise<void> {
		if (key === "emailDownloadLinksOnSuccess") emailDownloadLinksOnSuccess = value;
		else emailOnBillingReminders = value;
		await pushNotificationPrefs({ [key]: value });
	}

	function appPreferenceValue(bundleId: string, key: "pushOnSuccess" | "pushOnFailure" | "emailOnSuccess" | "emailOnFailure"): boolean {
		const appPreference = appNotificationPreferences.find((preference) => preference.bundleId === bundleId);
		return appPreference?.[key] ?? notificationPreferences[key];
	}

	function saveAppNotificationPreferences(next: NonNullable<NotificationPrefs["appNotificationPreferences"]>): void {
		appNotificationPreferences = next;
		const snapshot = next.map((preference) => ({ ...preference }));
		appPreferenceWrite = appPreferenceWrite.catch(() => undefined).then(async () => {
			await pushNotificationPrefs({ appNotificationPreferences: snapshot });
		}).catch(() => {
			showToast("App notification settings could not be saved. Try again.", "error");
		});
	}

	function addAppNotificationPreference(): void {
		const bundleId = appBundleId.trim().toLowerCase();
		if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(bundleId)) {
			appFormError = "Enter a valid app bundle ID, such as com.example.app.";
			return;
		}
		if (appNotificationPreferences.some((preference) => preference.bundleId === bundleId)) {
			appFormError = "That app already has notification settings.";
			return;
		}
		if (appNotificationPreferences.length >= 50) {
			appFormError = "You can configure up to 50 apps.";
			return;
		}
		appFormError = "";
		appBundleId = "";
		saveAppNotificationPreferences([...appNotificationPreferences, { bundleId }]);
	}

	function updateAppNotificationPreference(bundleId: string, key: "pushOnSuccess" | "pushOnFailure" | "emailOnSuccess" | "emailOnFailure", value: boolean): void {
		saveAppNotificationPreferences(appNotificationPreferences.map((preference) => preference.bundleId === bundleId ? { ...preference, [key]: value } : preference));
	}

	function removeAppNotificationPreference(bundleId: string): void {
		saveAppNotificationPreferences(appNotificationPreferences.filter((preference) => preference.bundleId !== bundleId));
	}

	async function sendTestEmail(): Promise<void> {
		sendingTestEmail = true;
		try {
			await testEmail();
		} finally {
			sendingTestEmail = false;
		}
	}

	async function enableNotifications(): Promise<void> {
		if (typeof Notification === "undefined") return;
		notifPermission = await Notification.requestPermission();
		if (notifPermission !== "granted" || !pushSupported()) return;
		enablingPush = true;
		try {
			pushEnabled = await enablePush();
		} catch {
			showToast("Couldn't enable push notifications - try again", "error");
		} finally {
			enablingPush = false;
		}
	}

	async function disableNotifications(): Promise<void> {
		enablingPush = true;
		try {
			await disablePush();
			pushEnabled = false;
		} finally {
			enablingPush = false;
		}
	}

	async function sendTestPush(): Promise<void> {
		sendingTestPush = true;
		try {
			await testPush();
		} finally {
			sendingTestPush = false;
		}
	}
</script>

<section class="border-border mb-3 border-t pt-3" lang={interfaceLanguage} aria-label={msg("notifications.title")}>
	<div class="flex items-center justify-between gap-3">
		<div class="text-[13px]">{msg("notifications.title")}</div>
		{#if notifPermission === "granted" && pushEnabled}
			<Button size="sm" variant="secondary" loading={enablingPush} onclick={disableNotifications}>{msg("notifications.disablePush")}</Button>
		{:else if notifPermission === "denied"}
			<Badge variant="destructive" title={msg("notifications.browserBlockedTitle")}>{msg("notifications.pushBlocked")}</Badge>
		{:else if notifPermission !== "unsupported"}
			<Button size="sm" variant="secondary" loading={enablingPush} onclick={enableNotifications}>{msg("notifications.enablePush")}</Button>
		{/if}
	</div>

	<Input
		type="email"
		class="mt-2 h-8 text-xs"
		placeholder={accountEmail ?? msg("notifications.emailAddress")}
		bind:value={notifyEmail}
		onblur={saveNotifyEmail}
	/>

	<div class="mt-3 grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1.5 text-xs text-muted">
		<div></div>
		<div class="text-center">{msg("notifications.pushColumn")}</div>
		<div class="text-center">{msg("notifications.emailColumn")}</div>

		{#each notificationCategories as category (category.label)}
			<div>{msg(category.label)}</div>
			<Checkbox
				class="justify-self-center"
				checked={notificationPreferences[category.pushKey]}
				onCheckedChange={(value) => savePreference(category.pushKey, value)}
				aria-label={msg(category.pushLabel)}
			/>
			<Checkbox
				class="justify-self-center"
				checked={notificationPreferences[category.emailKey]}
				onCheckedChange={(value) => savePreference(category.emailKey, value)}
				aria-label={msg(category.emailLabel)}
			/>
		{/each}
	</div>
	<div class="mt-3 space-y-2 border-t border-border/70 pt-3 text-xs text-muted">
		<label class="flex min-h-9 items-center gap-2"><Checkbox checked={emailDownloadLinksOnSuccess} onCheckedChange={(value) => saveDeliveryPreference("emailDownloadLinksOnSuccess", value)} aria-label={msg("notifications.emailDownloadLinks")} /><span>{msg("notifications.emailDownloadLinks")} <span class="block text-[11px]">{msg("notifications.emailDownloadLinksDescription")}</span></span></label>
		<label class="flex min-h-9 items-center gap-2"><Checkbox checked={emailOnBillingReminders} onCheckedChange={(value) => saveDeliveryPreference("emailOnBillingReminders", value)} aria-label={msg("notifications.emailBillingReminders")} /><span>{msg("notifications.emailBillingReminders")} <span class="block text-[11px]">{msg("notifications.emailBillingRemindersDescription")}</span></span></label>
	</div>

	<details class="mt-4 rounded-lg border border-border/70 px-3 py-2.5">
		<summary class="cursor-pointer text-xs font-medium">{msg("notifications.appSpecific")}</summary>
		<p class="mt-2 text-[11px] text-muted">{msg("notifications.appSpecificDescription")}</p>
		<div class="mt-3 flex flex-col gap-2 sm:flex-row">
			<Input class="h-8 min-w-0 flex-1 text-xs" placeholder={msg("notifications.bundleIdPlaceholder")} bind:value={appBundleId} oninput={() => appFormError = ""} />
			<Button size="sm" variant="secondary" onclick={addAppNotificationPreference}>{msg("notifications.addApp")}</Button>
		</div>
		{#if appFormError}<p class="mt-1 text-xs text-err" role="alert">{appFormError}</p>{/if}
		{#if appNotificationPreferences.length}
			<div class="mt-3 space-y-2">
				{#each appNotificationPreferences as preference (preference.bundleId)}
					<div class="rounded-lg border border-border/70 p-3">
						<div class="flex items-start justify-between gap-3">
							<code class="min-w-0 break-all text-xs">{preference.bundleId}</code>
							<Button size="icon" variant="ghost" class="h-7 w-7 shrink-0" aria-label={`${msg("notifications.removeApp")} ${preference.bundleId}`} onclick={() => removeAppNotificationPreference(preference.bundleId)}><X class="h-3.5 w-3.5" /></Button>
						</div>
						<div class="mt-2 grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1.5 text-xs text-muted">
							<div></div><div class="text-center">{msg("notifications.successfulDecrypts")}</div><div class="text-center">{msg("notifications.failedDecrypts")}</div>
							<div>{msg("notifications.pushColumn")}</div>
							<Checkbox class="justify-self-center" checked={appPreferenceValue(preference.bundleId, "pushOnSuccess")} onCheckedChange={(value) => updateAppNotificationPreference(preference.bundleId, "pushOnSuccess", value)} aria-label={`${msg("notifications.pushColumn")} ${msg("notifications.successfulDecrypts")} ${preference.bundleId}`} />
							<Checkbox class="justify-self-center" checked={appPreferenceValue(preference.bundleId, "pushOnFailure")} onCheckedChange={(value) => updateAppNotificationPreference(preference.bundleId, "pushOnFailure", value)} aria-label={`${msg("notifications.pushColumn")} ${msg("notifications.failedDecrypts")} ${preference.bundleId}`} />
							<div>{msg("notifications.emailColumn")}</div>
							<Checkbox class="justify-self-center" checked={appPreferenceValue(preference.bundleId, "emailOnSuccess")} onCheckedChange={(value) => updateAppNotificationPreference(preference.bundleId, "emailOnSuccess", value)} aria-label={`${msg("notifications.emailColumn")} ${msg("notifications.successfulDecrypts")} ${preference.bundleId}`} />
							<Checkbox class="justify-self-center" checked={appPreferenceValue(preference.bundleId, "emailOnFailure")} onCheckedChange={(value) => updateAppNotificationPreference(preference.bundleId, "emailOnFailure", value)} aria-label={`${msg("notifications.emailColumn")} ${msg("notifications.failedDecrypts")} ${preference.bundleId}`} />
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</details>

	<div class="mt-3 flex gap-2">
		{#if notifPermission === "granted" && pushEnabled}
			<Button size="sm" variant="secondary" loading={sendingTestPush} onclick={sendTestPush}>{msg("notifications.testPush")}</Button>
		{/if}
		<Button size="sm" variant="secondary" loading={sendingTestEmail} onclick={sendTestEmail}>{msg("notifications.testEmail")}</Button>
	</div>
</section>
