import { randomUUID } from 'node:crypto';
import { config } from '#config.js';
import type { AuthIdentity } from '#identity.js';
import { findAuthProfileByIdentity } from '#identity.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

interface PendingOauthLink {
  id: string;
  ownerId: string;
  identity: AuthIdentity;
  createdAt: number;
  expiresAt: number;
}

const database = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['pending_oauth_links']);

export function createPendingOauthLink(ownerId: string, identity: AuthIdentity): PendingOauthLink {
  const createdAt = Date.now();
  const link: PendingOauthLink = { id: randomUUID(), ownerId, identity, createdAt, expiresAt: createdAt + 10 * 60_000 };
  database.query('DELETE FROM pending_oauth_links WHERE expires_at < ?').run(createdAt);
  database.query('INSERT INTO pending_oauth_links (id, payload, updated_at, owner_id, expires_at) VALUES (?, ?, ?, ?, ?)').run(link.id, JSON.stringify(link), createdAt, ownerId, link.expiresAt);
  return link;
}

export function getPendingOauthLink(id: string, ownerId: string): PendingOauthLink | undefined {
  const row = database.query('SELECT payload FROM pending_oauth_links WHERE id = ? AND owner_id = ? AND expires_at > ?').get(id, ownerId, Date.now()) as { payload: string } | null;
  return row ? JSON.parse(row.payload) as PendingOauthLink : undefined;
}

export function pendingOauthLinkPreview(link: PendingOauthLink): { provider: AuthIdentity['provider']; willMerge: boolean; categories: string[]; expiresAt: number } {
  const existing = findAuthProfileByIdentity(link.identity.provider, link.identity.providerId);
  return { provider: link.identity.provider, willMerge: Boolean(existing && existing.userId !== link.ownerId), categories: existing && existing.userId !== link.ownerId ? ['sign-in methods', 'roles and permissions', 'jobs and artifacts', 'watches and preferences', 'billing and subscriptions'] : ['sign-in methods'], expiresAt: link.expiresAt };
}

export function deletePendingOauthLink(id: string, ownerId: string): void {
  database.query('DELETE FROM pending_oauth_links WHERE id = ? AND owner_id = ?').run(id, ownerId);
}

export function closeOauthLinkReviewRepository(): void {
  database.close();
}
