import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '#config.js';
import { createAppleAccountRepository, type AppleAccountRepository, type EncryptedAppleAccountRecord } from '#store/appleAccountRepository.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

export interface AppleAccountSecrets {
  appleId: string;
  password: string;
  fairPlayCredential?: string;
  fairPlayCredentials?: Record<string, string>;
}

export interface AppleAccountVaultStatus {
  encryptionReady: boolean;
  accountConfigured: boolean;
  credentialConfigured: boolean;
  fairPlayCredentialCount?: number;
  authenticatedAt?: number;
  accountHint?: string;
  authenticationError?: string;
  storefrontCountry?: string;
}

export interface AppleAccountVault {
  status(): AppleAccountVaultStatus;
  read(): AppleAccountSecrets | undefined;
  saveAccount(appleId: string, password: string, now?: number): AppleAccountVaultStatus;
  saveStorefrontCountry(country: string, now?: number): AppleAccountVaultStatus;
  saveCredential(credential: string, now?: number): AppleAccountVaultStatus;
  saveCredentialForSelector(selector: string, credential: string, now?: number): AppleAccountVaultStatus;
  readSessionSnapshot(): Buffer | undefined;
  saveSessionSnapshot(snapshot: Buffer, now?: number): void;
  clearSessionSnapshot(): void;
  markAuthenticated(now?: number): void;
  markAuthenticationError(error: string): void;
  clear(): boolean;
  close(): void;
}

const VAULT_AAD = Buffer.from('dkrypt:appstore-offline-account:v1');
const SESSION_AAD = Buffer.from('dkrypt:appstore-offline-session:v1');
const MAX_SESSION_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_FAIRPLAY_CREDENTIALS = 128;

function decodeKey(value: string): Buffer | undefined {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 ? decoded : undefined;
}

function accountHint(appleId: string): string {
  const [local, domain] = appleId.split('@');
  if (!local || !domain) return `${appleId.slice(0, 1)}•••`;
  return `${local.slice(0, 1)}•••@${domain}`;
}

function validateCredential(value: string): string {
  const trimmed = value.trim();
  const bytes = /^[0-9a-fA-F]{32}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (bytes.length !== 16) throw new Error('FairPlay credential must be exactly 16 bytes');
  return bytes.toString('base64');
}

function validateSelector(value: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error('FairPlay license selector is invalid');
  return value.toLowerCase();
}

function credentialCount(secrets: AppleAccountSecrets): number {
  const mapped = secrets.fairPlayCredentials ? Object.keys(secrets.fairPlayCredentials).length : 0;
  return mapped + (secrets.fairPlayCredential ? 1 : 0);
}

export function createAppleAccountVault(repository: AppleAccountRepository, keyValue: string): AppleAccountVault {
  const key = decodeKey(keyValue);

  function decryptRecord(record: EncryptedAppleAccountRecord): AppleAccountSecrets {
    if (!key) throw new Error('App Store account encryption key is unavailable or invalid');
    if (record.ciphertext.length > 8192) throw new Error('stored App Store account ciphertext is too large');
    const [ivValue, tagValue, ciphertextValue] = record.ciphertext.split('.');
    if (!ivValue || !tagValue || !ciphertextValue) throw new Error('stored App Store account ciphertext is malformed');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
      decipher.setAAD(VAULT_AAD);
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, 'base64url')),
        decipher.final(),
      ]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as AppleAccountSecrets;
      if (typeof parsed.appleId !== 'string' || typeof parsed.password !== 'string') {
        throw new Error('decrypted App Store account record is malformed');
      }
      return {
        appleId: parsed.appleId,
        password: parsed.password,
        fairPlayCredential: typeof parsed.fairPlayCredential === 'string' ? parsed.fairPlayCredential : undefined,
        fairPlayCredentials: parsed.fairPlayCredentials && typeof parsed.fairPlayCredentials === 'object' && !Array.isArray(parsed.fairPlayCredentials)
          ? parsed.fairPlayCredentials as Record<string, string>
          : undefined,
      };
    } catch {
      throw new Error('unable to decrypt stored App Store account data');
    }
  }

  function encryptSecrets(secrets: AppleAccountSecrets): string {
    if (!key) throw new Error('App Store account encryption key is unavailable or invalid');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(VAULT_AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  function encryptSession(snapshot: Buffer): string {
    if (!key) throw new Error('App Store account encryption key is unavailable or invalid');
    if (snapshot.length > MAX_SESSION_SNAPSHOT_BYTES) throw new Error('App Store provider session is too large');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(SESSION_AAD);
    const ciphertext = Buffer.concat([cipher.update(snapshot), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  function decryptSession(value: string): Buffer {
    if (!key) throw new Error('App Store account encryption key is unavailable or invalid');
    if (value.length > 24 * 1024 * 1024) throw new Error('stored App Store provider session is too large');
    const [ivValue, tagValue, ciphertextValue] = value.split('.');
    if (!ivValue || !tagValue || ciphertextValue === undefined) throw new Error('stored App Store provider session is malformed');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
      decipher.setAAD(SESSION_AAD);
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      const snapshot = Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]);
      if (snapshot.length > MAX_SESSION_SNAPSHOT_BYTES) throw new Error('App Store provider session is too large');
      return snapshot;
    } catch {
      throw new Error('unable to decrypt stored App Store provider session');
    }
  }

  function readCurrent(): { record: EncryptedAppleAccountRecord; secrets: AppleAccountSecrets } | undefined {
    const record = repository.read();
    return record ? { record, secrets: decryptRecord(record) } : undefined;
  }

  function writeSecrets(secrets: AppleAccountSecrets, record: Partial<EncryptedAppleAccountRecord>, now = Date.now()): void {
    const existing = repository.read();
    repository.write({
      id: 'primary',
      accountHint: record.accountHint ?? accountHint(secrets.appleId),
      ciphertext: encryptSecrets(secrets),
      updatedAt: now,
      sessionCiphertext: Object.hasOwn(record, 'sessionCiphertext') ? record.sessionCiphertext : existing?.sessionCiphertext,
      authenticatedAt: record.authenticatedAt,
      authenticationError: record.authenticationError,
      storefrontCountry: Object.hasOwn(record, 'storefrontCountry') ? record.storefrontCountry : existing?.storefrontCountry,
    });
  }

  function status(): AppleAccountVaultStatus {
    const record = repository.read();
    let credentialConfigured = false;
    let fairPlayCredentialCount: number | undefined;
    let authenticationError = record?.authenticationError;
    if (record && key) {
      try {
        fairPlayCredentialCount = credentialCount(decryptRecord(record));
        credentialConfigured = fairPlayCredentialCount > 0;
      } catch {
        authenticationError = 'encryption_key_mismatch';
      }
    }
    return {
      encryptionReady: Boolean(key),
      accountConfigured: Boolean(record),
      credentialConfigured,
      fairPlayCredentialCount,
      authenticatedAt: record?.authenticatedAt,
      accountHint: record?.accountHint,
      authenticationError,
      storefrontCountry: record?.storefrontCountry,
    };
  }

  return {
    status,
    read() {
      const current = readCurrent();
      return current?.secrets;
    },
    saveAccount(appleIdValue, password, now = Date.now()) {
      const appleId = appleIdValue.trim().toLowerCase();
      if (!key) throw new Error('configure APPSTORE_OFFLINE_VAULT_KEY before saving App Store credentials');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(appleId)) throw new Error('enter a valid Apple Account email address');
      if (password.length < 1 || password.length > 1024) throw new Error('Apple Account password length is invalid');
      const current = readCurrent();
      const sameAccount = current?.secrets.appleId === appleId;
      const sameCredentials = sameAccount && current.secrets.password === password;
      writeSecrets({
        appleId,
        password,
        fairPlayCredential: sameAccount ? current.secrets.fairPlayCredential : undefined,
        fairPlayCredentials: sameAccount ? current.secrets.fairPlayCredentials : undefined,
      }, {
        accountHint: accountHint(appleId),
        authenticatedAt: sameCredentials ? current.record.authenticatedAt : undefined,
        sessionCiphertext: sameCredentials ? current.record.sessionCiphertext : undefined,
        storefrontCountry: sameCredentials ? current.record.storefrontCountry : undefined,
      }, now);
      return status();
    },
    saveStorefrontCountry(countryValue, now = Date.now()) {
      const country = countryValue.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw new Error('App Store storefront country is invalid');
      const record = repository.read();
      if (!record) throw new Error('Apple Account is not configured');
      repository.write({ ...record, storefrontCountry: country, updatedAt: now });
      return status();
    },
    saveCredential(credentialValue, now = Date.now()) {
      const current = readCurrent();
      if (!current) throw new Error('configure the Apple Account before adding its FairPlay credential');
      const fairPlayCredential = validateCredential(credentialValue);
      writeSecrets({ ...current.secrets, fairPlayCredential }, {
        accountHint: current.record.accountHint,
        authenticatedAt: current.record.authenticatedAt,
        sessionCiphertext: current.record.sessionCiphertext,
      }, now);
      return status();
    },
    saveCredentialForSelector(selectorValue, credentialValue, now = Date.now()) {
      const current = readCurrent();
      if (!current) throw new Error('configure the Apple Account before adding its FairPlay credential');
      const selector = validateSelector(selectorValue);
      const credential = validateCredential(credentialValue);
      const fairPlayCredentials = { ...current.secrets.fairPlayCredentials, [selector]: credential };
      while (Object.keys(fairPlayCredentials).length > MAX_FAIRPLAY_CREDENTIALS) {
        delete fairPlayCredentials[Object.keys(fairPlayCredentials)[0]!];
      }
      writeSecrets({ ...current.secrets, fairPlayCredentials }, {
        accountHint: current.record.accountHint,
        authenticatedAt: current.record.authenticatedAt,
        sessionCiphertext: current.record.sessionCiphertext,
      }, now);
      return status();
    },
    readSessionSnapshot() {
      const record = repository.read();
      return record?.sessionCiphertext ? decryptSession(record.sessionCiphertext) : undefined;
    },
    saveSessionSnapshot(snapshot, now = Date.now()) {
      const record = repository.read();
      if (!record) throw new Error('Apple Account is not configured');
      repository.write({ ...record, sessionCiphertext: encryptSession(snapshot), updatedAt: now, authenticationError: undefined });
    },
    clearSessionSnapshot() {
      const record = repository.read();
      if (!record?.sessionCiphertext) return;
      const { sessionCiphertext: _sessionCiphertext, ...next } = record;
      repository.write({ ...next, updatedAt: Date.now(), authenticatedAt: undefined, authenticationError: 'session_cleared' });
    },
    markAuthenticated(now = Date.now()) {
      const current = readCurrent();
      if (!current) throw new Error('Apple Account is not configured');
      writeSecrets(current.secrets, { accountHint: current.record.accountHint, authenticatedAt: now, sessionCiphertext: current.record.sessionCiphertext }, now);
    },
    markAuthenticationError(error) {
      const current = repository.read();
      if (!current) return;
      const safeError = /^[a-z0-9_-]{1,80}$/.test(error) ? error : 'authentication_failed';
      repository.write({ ...current, updatedAt: Date.now(), authenticatedAt: undefined, authenticationError: safeError });
    },
    clear() {
      return repository.delete();
    },
    close() {
      repository.close();
    },
  };
}

const database = openStateCollectionDatabase({
  stateDir: config.stateDir,
  filename: config.stateDatabaseFile,
  busyTimeoutMs: config.stateDbBusyTimeoutMs,
}, ['appstore_offline_account']);

const defaultVault = createAppleAccountVault(createAppleAccountRepository(database), config.appStoreOfflineVaultKey);

export const getAppleAccountVaultStatus = defaultVault.status;
export const readAppleAccountSecrets = defaultVault.read;
export const saveAppleAccountCredentials = defaultVault.saveAccount;
export const saveAppleAccountStorefrontCountry = defaultVault.saveStorefrontCountry;
export const saveAppleAccountFairPlayCredential = defaultVault.saveCredential;
export const saveAppleAccountFairPlayCredentialForSelector = defaultVault.saveCredentialForSelector;
export const readAppleAccountSessionSnapshot = defaultVault.readSessionSnapshot;
export const saveAppleAccountSessionSnapshot = defaultVault.saveSessionSnapshot;
export const clearAppleAccountSessionSnapshot = defaultVault.clearSessionSnapshot;
export const markAppleAccountAuthenticated = defaultVault.markAuthenticated;
export const markAppleAccountAuthenticationError = defaultVault.markAuthenticationError;
export const clearAppleAccountCredentials = defaultVault.clear;
export const closeAppleAccountVault = defaultVault.close;
