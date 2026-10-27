import webpush from 'web-push';
import { trackBackgroundWork } from '#backgroundWork.js';
import { scopedLogger } from '#logger.js';
import { getOrCreateVapidKeys, getPushSubscriptions, getUserPrefs, getUsersWithPushSubscriptions, removePushSubscription } from '#store/state.js';

const log = scopedLogger('push');

let configured = false;

const VAPID_SUBJECT = 'mailto:push@dkrypt.local';

function ensureConfigured(): void {
  if (configured) return;
  const { publicKey, privateKey } = getOrCreateVapidKeys();
  webpush.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);
  configured = true;
}

export function getVapidPublicKey(): string {
  return getOrCreateVapidKeys().publicKey;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  jobUrl?: string;
  tag?: string;
  silent?: boolean;
  renotify?: boolean;
  actions?: { action: string; title: string }[];
}

export function sendPushToUser(username: string, payload: PushPayload): Promise<void> {
  return trackBackgroundWork('push-notification', () => deliverPushToUser(username, payload));
}

async function deliverPushToUser(username: string, payload: PushPayload): Promise<void> {
  try {
    ensureConfigured();
    const subs = getPushSubscriptions(username);
    if (subs.length === 0) return;

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, JSON.stringify(payload));
        } catch (err) {
          const statusCode = err instanceof webpush.WebPushError ? err.statusCode : undefined;
          if (statusCode === 404 || statusCode === 410) {
            removePushSubscription(username, sub.endpoint);
            return;
          }
          log.warn('push send failed', { username, error: String(err) });
        }
      }),
    );
  } catch (err) {
    log.warn('push send failed', { username, error: String(err) });
  }
}

export type PushCategory = 'deviceAlert' | 'keyExpiry';

const CATEGORY_PREF_KEY: Record<PushCategory, 'pushOnAlerts' | 'pushOnKeyExpiry'> = {
  deviceAlert: 'pushOnAlerts',
  keyExpiry: 'pushOnKeyExpiry',
};

export function sendPushToAllSubscribed(payload: PushPayload, category: PushCategory): Promise<void> {
  return trackBackgroundWork('bulk-push-notification', () => deliverPushToAllSubscribed(payload, category));
}

async function deliverPushToAllSubscribed(payload: PushPayload, category: PushCategory): Promise<void> {
  const prefKey = CATEGORY_PREF_KEY[category];
  const usernames = getUsersWithPushSubscriptions().filter((u) => getUserPrefs(u)[prefKey] ?? true);
  await Promise.all(usernames.map((u) => sendPushToUser(u, payload)));
}
