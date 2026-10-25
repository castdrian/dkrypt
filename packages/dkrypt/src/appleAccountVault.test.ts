import { afterEach, expect, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppleAccountVault } from '#appleAccountVault.js';
import { createAppleAccountRepository } from '#store/appleAccountRepository.js';
import { openStateCollectionDatabase, readStateCollection } from '#store/sqlite.js';

const temporaryDirectories: string[] = [];
const vaultKey = Buffer.alloc(32, 7).toString('base64url');

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createVault(stateDir: string, key = vaultKey) {
  const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['appstore_offline_account']);
  return createAppleAccountVault(createAppleAccountRepository(database), key);
}

test('Apple Account secrets are encrypted in SQLite and survive reopening with the external key', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-apple-vault-'));
  temporaryDirectories.push(stateDir);
  const vault = createVault(stateDir);
  vault.saveAccount('Admin@icloud.com', 'account-password');
  vault.saveStorefrontCountry('DE');
  vault.saveCredential(Buffer.alloc(16, 9).toString('hex'));
  vault.saveCredentialForSelector('a'.repeat(64), Buffer.alloc(16, 11).toString('base64'));
  const sessionSnapshot = Buffer.from('provider-session-secret');
  vault.saveSessionSnapshot(sessionSnapshot);
  sessionSnapshot.fill(0);
  vault.markAuthenticated(1234);
  const inspectDatabase = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['appstore_offline_account']);
  const rows = readStateCollection(inspectDatabase, 'appstore_offline_account') as Array<Record<string, unknown>>;
  inspectDatabase.close();
  expect(JSON.stringify(rows)).not.toContain('account-password');
  expect(JSON.stringify(rows)).not.toContain(Buffer.alloc(16, 9).toString('hex'));
  expect(JSON.stringify(rows)).not.toContain(Buffer.alloc(16, 11).toString('base64'));
  expect(JSON.stringify(rows)).not.toContain('provider-session-secret');
  vault.close();

  const reopened = createVault(stateDir);
  try {
    expect(reopened.read()).toMatchObject({ appleId: 'admin@icloud.com', password: 'account-password' });
    expect(Buffer.from(reopened.read()!.fairPlayCredential!, 'base64')).toEqual(Buffer.alloc(16, 9));
    expect(Buffer.from(reopened.read()!.fairPlayCredentials!['a'.repeat(64)]!, 'base64')).toEqual(Buffer.alloc(16, 11));
    expect(reopened.readSessionSnapshot()?.toString()).toBe('provider-session-secret');
    expect(reopened.status()).toMatchObject({
      encryptionReady: true,
      accountConfigured: true,
      credentialConfigured: true,
      authenticatedAt: 1234,
      accountHint: 'a•••@icloud.com',
      storefrontCountry: 'DE',
    });
  } finally {
    reopened.close();
  }
});

test('Apple Account vault refuses a missing or wrong external key', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-apple-vault-key-'));
  temporaryDirectories.push(stateDir);
  const initial = createVault(stateDir);
  initial.saveAccount('admin@icloud.com', 'account-password');
  initial.saveSessionSnapshot(Buffer.from('provider-session-secret'));
  initial.close();

  const wrongKey = createVault(stateDir, Buffer.alloc(32, 8).toString('base64url'));
  try {
    expect(() => wrongKey.read()).toThrow('unable to decrypt');
    expect(wrongKey.status()).toMatchObject({ authenticationError: 'encryption_key_mismatch', credentialConfigured: false });
    expect(() => wrongKey.readSessionSnapshot()).toThrow('unable to decrypt');
  } finally {
    wrongKey.close();
  }
});

test('Apple Account vault migrates legacy keychain passphrases out of decrypted secrets', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-apple-vault-legacy-'));
  temporaryDirectories.push(stateDir);
  const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['appstore_offline_account']);
  const repository = createAppleAccountRepository(database);
  const key = Buffer.alloc(32, 7);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('dkrypt:appstore-offline-account:v1'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({
      appleId: 'admin@icloud.com',
      password: 'account-password',
      keychainPassphrase: 'legacy-helper-passphrase',
      fairPlayCredential: Buffer.alloc(16, 3).toString('base64'),
    }), 'utf8'),
    cipher.final(),
  ]);
  repository.write({
    id: 'primary',
    accountHint: 'a•••@icloud.com',
    ciphertext: `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`,
    updatedAt: 1,
  });
  const vault = createAppleAccountVault(repository, key.toString('base64url'));

  try {
    const secrets = vault.read();
    expect(secrets).toMatchObject({ appleId: 'admin@icloud.com', password: 'account-password' });
    expect(secrets).not.toHaveProperty('keychainPassphrase');
    expect(vault.status().credentialConfigured).toBe(true);
  } finally {
    vault.close();
  }
});

test('Apple Account vault validates credentials and invalidates account-bound keys on account change', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-apple-vault-validation-'));
  temporaryDirectories.push(stateDir);
  const vault = createVault(stateDir);
  try {
    expect(() => vault.saveCredential(Buffer.alloc(15, 1).toString('hex'))).toThrow('configure the Apple Account');
    vault.saveAccount('first@icloud.com', 'first-password');
    vault.saveCredential(Buffer.alloc(16, 1).toString('base64'));
    vault.saveCredentialForSelector('b'.repeat(64), Buffer.alloc(16, 2).toString('base64'));
    expect(() => vault.saveCredential(Buffer.alloc(17, 1).toString('base64'))).toThrow('exactly 16 bytes');
    vault.saveAccount('second@icloud.com', 'second-password');
    expect(vault.status().credentialConfigured).toBe(false);
    expect(vault.status().storefrontCountry).toBeUndefined();
    expect(vault.read()?.fairPlayCredentials).toBeUndefined();
  } finally {
    vault.close();
  }
});
