import { config } from '#config.js';
import { trackBackgroundWork } from '#backgroundWork.js';
import { createHmac, randomUUID } from 'node:crypto';
import { log } from '#logger.js';
import { sendMailToAllSubscribed, type MailCategory } from '#mail.js';
import { sendPushToAllSubscribed, type PushCategory } from '#push.js';
import { getEffectiveSettings, recordWebhookDelivery, type DashboardSettings } from '#store/state.js';
import { postJsonWithRetry } from '#util/webhookRetry.js';

export type NotifyEvent =
  | 'keyRequest'
  | 'appStoreAutomationSuccess'
  | 'testFlightAutomationSuccess'
  | 'appStoreAutomationFailure'
  | 'testFlightAutomationFailure'
  | 'keyExpiringSoon'
  | 'deviceOffline'
  | 'deviceBatteryHot'
  | 'deviceBatteryLow'
  | 'diskFull'
  | 'deviceStorageLow'
  | 'testFlightBridgeDown'
  | 'jobCompleted'
  | 'queueSloBreach'
  | 'cryptoBillingSuccess'
  | 'cryptoBillingFailure';

const EVENT_SETTING_KEY: Record<NotifyEvent, keyof DashboardSettings> = {
  keyRequest: 'notifyOnKeyRequest',
  appStoreAutomationSuccess: 'notifyOnAutomationSuccess',
  testFlightAutomationSuccess: 'notifyOnAutomationSuccess',
  appStoreAutomationFailure: 'notifyOnAutomationFailure',
  testFlightAutomationFailure: 'notifyOnAutomationFailure',
  keyExpiringSoon: 'notifyOnKeyExpiringSoon',
  deviceOffline: 'notifyOnDeviceOffline',
  deviceBatteryHot: 'notifyOnDeviceBatteryHot',
  deviceBatteryLow: 'notifyOnDeviceBatteryLow',
  diskFull: 'notifyOnDiskFull',
  deviceStorageLow: 'notifyOnDeviceStorageLow',
  testFlightBridgeDown: 'notifyOnTestFlightBridgeDown',
  jobCompleted: 'notifyOnJobCompleted',
  queueSloBreach: 'notifyOnQueueSloBreach',
  cryptoBillingSuccess: 'notifyOnAutomationSuccess',
  cryptoBillingFailure: 'notifyOnAutomationFailure',
};

export const EMBED_COLOR = {
  info: 0x5b8cff,
  ok: 0x3ecf8e,
  warn: 0xf5a623,
  err: 0xf2545b,
} as const;

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface NotifyEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: EmbedField[];
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const WEBHOOK_USERNAME = 'dkrypt';

const WEBHOOK_AVATAR_URL = `${config.publicBaseUrl}/favicon.png`;

interface PendingDigest {
  url: string;
  format: DashboardSettings['notifyFormat'];
  entries: string[];
}

const pendingDigests = new Map<string, PendingDigest>();
let lastDigestKey: string | undefined;

function flattenEmbed(embed: NotifyEmbed): string {
  const lines = [`**${embed.title}**`];
  if (embed.description) lines.push(embed.description);
  for (const f of embed.fields ?? []) lines.push(`${f.name}: ${f.value.replace(/```/g, '')}`);
  return lines.join('\n');
}

function buildPayload(embed: NotifyEmbed, format: DashboardSettings['notifyFormat']): Record<string, unknown> {
  if (format === 'plain') {
    const text = truncate(flattenEmbed(embed), 2000);
    return { content: text, text, username: WEBHOOK_USERNAME, icon_url: WEBHOOK_AVATAR_URL };
  }

  return {
    username: WEBHOOK_USERNAME,
    avatar_url: WEBHOOK_AVATAR_URL,
    embeds: [
      {
        title: truncate(embed.title, 256),
        description: embed.description ? truncate(embed.description, 4096) : undefined,
        color: embed.color,
        fields: embed.fields
          ?.slice(0, 25)
          .map((f) => ({ name: truncate(f.name, 256), value: truncate(f.value, 1024), inline: f.inline })),
        footer: { text: 'dkrypt', icon_url: WEBHOOK_AVATAR_URL },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function webhookSignature(secret: string, timestamp: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;
}

function webhookSigningConfigError(): string | undefined {
  const current = config.outboundWebhookSecret;
  const previous = config.outboundWebhookSecretPrevious;
  if (!previous) return undefined;
  if (current.length >= 16 && previous.length >= 16 && current !== previous) return undefined;
  return 'outbound webhook signing rotation is invalid: current and previous secrets must be distinct and at least 16 characters';
}

function webhookHeaders(event: string, payload: Record<string, unknown>, eventId: string): Record<string, string> {
  const signingConfigError = webhookSigningConfigError();
  if (signingConfigError) throw new Error(signingConfigError);
  if (!config.outboundWebhookSecret) return { 'X-Dkrypt-Event': event, 'X-Dkrypt-Event-Id': eventId };
  const timestamp = new Date().toISOString();
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'X-Dkrypt-Event': event,
    'X-Dkrypt-Event-Id': eventId,
    'X-Dkrypt-Timestamp': timestamp,
    'X-Dkrypt-Signature': webhookSignature(config.outboundWebhookSecret, timestamp, body),
  };
  if (config.outboundWebhookSecretPrevious && config.outboundWebhookSecretPrevious !== config.outboundWebhookSecret) {
    headers['X-Dkrypt-Signature-Previous'] = webhookSignature(config.outboundWebhookSecretPrevious, timestamp, body);
  }
  return headers;
}

function targetHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

function redactWebhookError(error: string | undefined, url: string): string | undefined {
  if (!error) return undefined;
  let redacted = error.replaceAll(url, 'webhook endpoint');
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== '/') redacted = redacted.replaceAll(parsed.pathname, '/[redacted]');
    if (parsed.search) redacted = redacted.replaceAll(parsed.search, '');
  } catch {}
  return redacted;
}

function isWithinQuietHours(now: Date, start: string, end: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  return startMinutes < endMinutes ? current >= startMinutes && current < endMinutes : current >= startMinutes || current < endMinutes;
}

function isSuccessNotification(event: NotifyEvent, embed: NotifyEmbed): boolean {
  return event === 'appStoreAutomationSuccess' || event === 'testFlightAutomationSuccess' || event === 'cryptoBillingSuccess' || (event === 'jobCompleted' && embed.color === EMBED_COLOR.ok);
}

function queueDigest(url: string, format: DashboardSettings['notifyFormat'], embed: NotifyEmbed): void {
  const key = `${url}|${format}`;
  const digest = pendingDigests.get(key) ?? { url, format, entries: [] };
  digest.entries.push(flattenEmbed(embed));
  pendingDigests.set(key, digest);
}

function digestKey(mode: DashboardSettings['notifySuccessMode'], now: Date): string | undefined {
  if (mode === 'instant') return undefined;
  if (now.getHours() !== 9) return undefined;
  if (mode === 'daily') return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (now.getDay() !== 1) return undefined;
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-weekly`;
}

async function postWebhook(
  url: string,
  embed: NotifyEmbed,
  format: DashboardSettings['notifyFormat'],
  event: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const payload = buildPayload(embed, format);
  let result;
  try {
    result = await postJsonWithRetry(url, payload, webhookHeaders(event, payload, randomUUID()));
  } catch (error) {
    result = { ok: false, error: String(error), durationMs: 0 };
  }
  result = { ...result, error: redactWebhookError(result.error, url) };
  recordWebhookDelivery({
    kind: event === 'jobCompleted' ? 'job' : 'automation',
    event,
    targetHost: targetHost(url),
    ok: result.ok,
    status: result.status,
    error: result.error,
    durationMs: result.durationMs,
  });
  return result;
}

const PUSH_EVENT_CATEGORY: Partial<Record<NotifyEvent, PushCategory>> = {
  keyExpiringSoon: 'keyExpiry',
  deviceOffline: 'deviceAlert',
  deviceBatteryHot: 'deviceAlert',
  deviceBatteryLow: 'deviceAlert',
  diskFull: 'deviceAlert',
  deviceStorageLow: 'deviceAlert',
  testFlightBridgeDown: 'deviceAlert',
};

const MAIL_EVENT_CATEGORY: Partial<Record<NotifyEvent, MailCategory>> = {
  keyExpiringSoon: 'keyExpiry',
  deviceOffline: 'deviceAlert',
  deviceBatteryHot: 'deviceAlert',
  deviceBatteryLow: 'deviceAlert',
  diskFull: 'deviceAlert',
  deviceStorageLow: 'deviceAlert',
  testFlightBridgeDown: 'deviceAlert',
};

export function notify(event: NotifyEvent, embed: NotifyEmbed, webhookUrlOverride?: string): Promise<void> {
  return trackBackgroundWork(`notification:${event}`, () => sendNotification(event, embed, webhookUrlOverride));
}

async function sendNotification(event: NotifyEvent, embed: NotifyEmbed, webhookUrlOverride?: string): Promise<void> {
  const settings = getEffectiveSettings();
  if (!settings[EVENT_SETTING_KEY[event]]) return;

  const pushCategory = PUSH_EVENT_CATEGORY[event];
  if (pushCategory) {
    void sendPushToAllSubscribed({ title: embed.title, body: embed.description ?? embed.title }, pushCategory)
      .catch((error: unknown) => log.warn('push notification dispatch failed', { event, error: String(error) }));
  }

  const mailCategory = MAIL_EVENT_CATEGORY[event];
  if (mailCategory) {
    void sendMailToAllSubscribed({ subject: embed.title, text: embed.description ?? embed.title }, mailCategory)
      .catch((error: unknown) => log.warn('mail notification dispatch failed', { event, error: String(error) }));
  }

  const url = webhookUrlOverride || settings.notifyWebhookUrl;
  if (!url) return;
  if (isSuccessNotification(event, embed)) {
    if (isWithinQuietHours(new Date(), settings.notifyQuietHoursStart, settings.notifyQuietHoursEnd)) {
      if (settings.notifySuccessMode !== 'instant') queueDigest(url, settings.notifyFormat, embed);
      return;
    }
    if (settings.notifySuccessMode !== 'instant') {
      queueDigest(url, settings.notifyFormat, embed);
      return;
    }
  }
  const result = await postWebhook(url, embed, settings.notifyFormat, event);
  if (!result.ok) log.warn('notify webhook failed', { event, status: result.status, error: result.error });
}

export async function flushNotificationDigests(now = new Date()): Promise<void> {
  const settings = getEffectiveSettings();
  const key = digestKey(settings.notifySuccessMode, now);
  if (!key || key === lastDigestKey || pendingDigests.size === 0) return;
  lastDigestKey = key;
  const digests = [...pendingDigests.values()];
  pendingDigests.clear();
  await Promise.all(
    digests.map(async (digest) => {
      const embed: NotifyEmbed = {
        title: settings.notifySuccessMode === 'weekly' ? 'Weekly dkrypt automation digest' : 'Daily dkrypt automation digest',
        description: digest.entries.slice(-20).join('\n\n'),
        color: EMBED_COLOR.ok,
      };
      const result = await postWebhook(digest.url, embed, digest.format, 'automationDigest');
      if (!result.ok) log.warn('notification digest webhook failed', { status: result.status, error: result.error });
    }),
  );
}

export function startNotificationDigestScheduler(): void {
  notificationDigestTimer ??= setInterval(() => {
    void trackBackgroundWork('notification-digest-flush', flushNotificationDigests)
      .catch((error: unknown) => log.warn('notification digest flush failed', { error: String(error) }));
  }, 60_000).unref();
}

let notificationDigestTimer: NodeJS.Timeout | undefined;

export async function stopNotificationDigestScheduler(): Promise<void> {
  if (notificationDigestTimer) clearInterval(notificationDigestTimer);
  notificationDigestTimer = undefined;
  await flushNotificationDigests();
}

export async function sendTestNotification(urlOverride?: string, pinnedAddresses?: readonly string[]): Promise<{ ok: boolean; error?: string; status?: number; durationMs: number; eventId?: string; targetHost?: string; signatureIncluded?: boolean; signatureAcknowledged?: boolean }> {
  const settings = getEffectiveSettings();
  const url = urlOverride || settings.notifyWebhookUrl;
  if (!url) return { ok: false, error: 'no webhook URL configured', durationMs: 0 };

  const payload = buildPayload(
    { title: 'Test notification', description: 'This is what a notification from dkrypt looks like.', color: EMBED_COLOR.info },
    settings.notifyFormat,
  );
  const signingConfigError = webhookSigningConfigError();
  if (signingConfigError) return { ok: false, error: signingConfigError, durationMs: 0, targetHost: targetHost(url) };
  const eventId = randomUUID();
  const headers = webhookHeaders('testNotification', payload, eventId);
  try {
    const result = await postJsonWithRetry(url, payload, headers, pinnedAddresses);
    const error = redactWebhookError(result.error, url);
    recordWebhookDelivery({ kind: 'automation', event: 'testNotification', targetHost: targetHost(url), ok: result.ok, status: result.status, error, durationMs: result.durationMs });
    return {
      ok: result.ok,
      ...(result.ok ? {} : { error: error ?? `webhook returned HTTP ${result.status}` }),
      status: result.status,
      durationMs: result.durationMs,
      eventId,
      targetHost: targetHost(url),
      signatureIncluded: Boolean(headers['X-Dkrypt-Signature']),
      ...(result.signatureAcknowledged ? { signatureAcknowledged: true } : {}),
    };
  } catch (error) {
    return { ok: false, error: redactWebhookError(String(error), url), durationMs: 0, eventId, targetHost: targetHost(url), signatureIncluded: Boolean(headers['X-Dkrypt-Signature']) };
  }
}
