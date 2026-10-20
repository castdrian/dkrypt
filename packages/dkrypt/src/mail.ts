import nodemailer, { type Transporter } from 'nodemailer';
import { config, isEmailEnabled } from '#config.js';
import { trackBackgroundWork } from '#backgroundWork.js';
import { getAuthProfile, listAuthProfiles } from '#identity.js';
import { scopedLogger } from '#logger.js';
import { getUserPrefs } from '#store/state.js';

const log = scopedLogger('mail');

interface TransporterCache {
  host: string;
  port: number;
  user: string;
  currentPassword: string;
  previousPassword: string;
  current?: Transporter;
  previous?: Transporter;
}

let transporterCache: TransporterCache | undefined;

function getTransporter(password: string, slot: 'current' | 'previous'): Transporter | undefined {
  if (!isEmailEnabled()) return undefined;
  if (
    !transporterCache ||
    transporterCache.host !== config.smtpHost ||
    transporterCache.port !== config.smtpPort ||
    transporterCache.user !== config.smtpUser ||
    transporterCache.currentPassword !== config.smtpPass ||
    transporterCache.previousPassword !== config.smtpPassPrevious
  ) {
    transporterCache = {
      host: config.smtpHost,
      port: config.smtpPort,
      user: config.smtpUser,
      currentPassword: config.smtpPass,
      previousPassword: config.smtpPassPrevious,
    };
  }
  if (!transporterCache[slot]) {
    transporterCache[slot] = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: { user: config.smtpUser, pass: password },
    });
  }
  return transporterCache[slot];
}

function isPermanentSmtpAuthenticationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const smtpError = error as { code?: unknown; responseCode?: unknown };
  return smtpError.code === 'EAUTH' && smtpError.responseCode === 535;
}

async function sendMail(message: { from: string; to: string; subject: string; text: string }, userId: string): Promise<void> {
  const currentTransporter = getTransporter(config.smtpPass, 'current');
  if (!currentTransporter) return;
  try {
    await currentTransporter.sendMail(message);
  } catch (error) {
    if (
      !config.smtpPassPrevious ||
      config.smtpPassPrevious === config.smtpPass ||
      !isPermanentSmtpAuthenticationFailure(error)
    ) throw error;
    const previousTransporter = getTransporter(config.smtpPassPrevious, 'previous');
    if (!previousTransporter) throw error;
    await previousTransporter.sendMail(message);
    log.warn('mail delivered with previous SMTP credential', { userId });
  }
}

export interface MailPayload {
  subject: string;
  text: string;
}

export function resolveNotifyEmail(userId: string): string | undefined {
  const custom = getUserPrefs(userId).notifyEmail?.trim();
  return custom || getAuthProfile(userId)?.email;
}

export function sendMailToUser(userId: string, payload: MailPayload): Promise<void> {
  return trackBackgroundWork('mail-notification', () => deliverMailToUser(userId, payload));
}

export function canSendDirectMailToUser(userId: string): boolean {
  return isEmailEnabled() && Boolean(resolveNotifyEmail(userId));
}

export function sendDirectMailToUser(userId: string, payload: MailPayload): Promise<void> {
  const email = resolveNotifyEmail(userId);
  if (!isEmailEnabled() || !email) throw new Error('email delivery is unavailable');
  return trackBackgroundWork('direct-mail-notification', () => sendMail({ from: config.smtpFrom, to: email, subject: payload.subject, text: payload.text }, userId));
}

async function deliverMailToUser(userId: string, payload: MailPayload): Promise<void> {
  if (!isEmailEnabled()) return;

  const email = resolveNotifyEmail(userId);
  if (!email) return;

  try {
    await sendMail({ from: config.smtpFrom, to: email, subject: payload.subject, text: payload.text }, userId);
  } catch (err) {
    log.warn('mail send failed', { userId, error: String(err) });
  }
}

export type MailCategory = 'deviceAlert' | 'keyExpiry';

const CATEGORY_PREF_KEY: Record<MailCategory, 'emailOnAlerts' | 'emailOnKeyExpiry'> = {
  deviceAlert: 'emailOnAlerts',
  keyExpiry: 'emailOnKeyExpiry',
};

export function sendMailToAllSubscribed(payload: MailPayload, category: MailCategory): Promise<void> {
  return trackBackgroundWork('bulk-mail-notification', () => deliverMailToAllSubscribed(payload, category));
}

async function deliverMailToAllSubscribed(payload: MailPayload, category: MailCategory): Promise<void> {
  if (!isEmailEnabled()) return;
  const prefKey = CATEGORY_PREF_KEY[category];
  const recipients = listAuthProfiles().filter((profile) => resolveNotifyEmail(profile.userId) && (getUserPrefs(profile.userId)[prefKey] ?? false));
  await Promise.all(recipients.map((profile) => sendMailToUser(profile.userId, payload)));
}
