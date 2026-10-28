import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '#config.js';
import { createIdentityRepository, identityProfileStateRow, isAuthProfileRecord, type IdentityProfileChanges } from '#store/identityRepository.js';
import { openStateCollectionDatabase, writeStateMirror, type StateCollectionReplacement } from '#store/sqlite.js';

export type AuthProvider = 'github' | 'discord' | 'apple';

export interface AuthIdentity {
  provider: AuthProvider;
  providerId: string;
  username: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  source: 'oauth' | 'discord_connection';
  updatedAt: string;
}

export interface AuthProfile {
  userId: string;
  provider: AuthProvider;
  providerId: string;
  username: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  customDisplayName?: string;
  customUsername?: string;
  identities?: AuthIdentity[];
  aliases?: string[];
  updatedAt: string;
}

export interface IdentitySnapshot {
  profiles: AuthProfile[];
}

const identityPath = path.join(config.stateDir, 'identities.json');
const identityDatabase = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['auth_profiles']);
const identityRepository = createIdentityRepository(identityDatabase);

function identityKey(identity: Pick<AuthIdentity, 'provider' | 'providerId'>): string {
  return `${identity.provider}:${identity.providerId}`;
}

function legacyIdentity(profile: AuthProfile): AuthIdentity {
  return {
    provider: profile.provider,
    providerId: profile.providerId,
    username: profile.username,
    displayName: profile.displayName,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
    source: 'oauth',
    updatedAt: profile.updatedAt,
  };
}

function mergeIdentities(...groups: AuthIdentity[][]): AuthIdentity[] {
  const merged = new Map<string, AuthIdentity>();
  for (const identity of groups.flat()) {
    const key = identityKey(identity);
    const existing = merged.get(key);
    if (!existing || existing.source === 'discord_connection' || identity.source === 'oauth') {
      merged.set(key, { ...existing, ...identity });
    }
  }
  return [...merged.values()];
}

function normalizeProfile(profile: AuthProfile): AuthProfile {
  const identities = mergeIdentities(profile.identities ?? [], [legacyIdentity(profile)]);
  const primary = identities.find((identity) => identityKey(identity) === profile.userId)
    ?? identities.find((identity) => identity.source === 'oauth')
    ?? identities.find((identity) => identity.provider === profile.provider && identity.providerId === profile.providerId)
    ?? identities[0];
  const username = profile.customUsername ?? primary?.username ?? profile.username;
  const displayName = profile.customDisplayName ?? primary?.displayName ?? profile.displayName;
  return {
    ...profile,
    username,
    customUsername: username,
    displayName,
    customDisplayName: displayName,
    identities,
    aliases: [...new Set((profile.aliases ?? []).filter((alias) => alias && alias !== profile.userId))],
  };
}

function availableUsername(candidate: string, profiles: AuthProfile[], userId: string): string {
  const cleaned = candidate.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40);
  const base = cleaned.length >= 2 ? cleaned : 'member';
  const used = new Set(['root', 'system', ...profiles.filter((profile) => profile.userId !== userId).map((profile) => profile.username.toLowerCase())]);
  if (!used.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix < 100_000; suffix += 1) {
    const value = `${base.slice(0, 40 - String(suffix).length - 1)}-${suffix}`;
    if (!used.has(value.toLowerCase())) return value;
  }
  throw new Error('no available account username');
}

function normalizeAccountUsernames(profiles: AuthProfile[]): AuthProfile[] {
  const assigned: AuthProfile[] = [];
  for (const profile of profiles) {
    profile.username = availableUsername(profile.username, assigned, profile.userId);
    profile.customUsername = profile.username;
    assigned.push(profile);
  }
  return assigned;
}

function load(): IdentitySnapshot {
  identityRepository.importLegacySnapshot(loadLegacyProfiles);
  const persisted = identityRepository.listAll();
  const profiles = normalizeAccountUsernames(persisted.map(normalizeProfile));
  if (JSON.stringify(persisted) !== JSON.stringify(profiles)) identityRepository.replaceAll(profiles);
  return { profiles };
}

function loadLegacyProfiles(): AuthProfile[] | undefined {
  if (!existsSync(identityPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(identityPath, 'utf8'));
    if (!isIdentitySnapshot(parsed)) throw new Error('identity JSON snapshot is malformed');
    return parsed.profiles.map(normalizeProfile);
  } catch (error) {
    throw new Error(`could not initialize identity state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const state = load();

export function identitySnapshotCollections(snapshot: IdentitySnapshot): StateCollectionReplacement[] {
  return [{
    table: 'auth_profiles',
    rows: snapshot.profiles.map(identityProfileStateRow),
  }];
}

function persistProfiles(changes: IdentityProfileChanges): void {
  identityRepository.applyChanges(changes);
}

function persistIdentitySnapshot(): void {
  identityRepository.replaceAll(state.profiles);
}

export function writeIdentitySnapshotMirror(): void {
  writeStateMirror(identityPath, state);
}

export function closeIdentityDatabase(): void {
  identityRepository.close();
}

export function upsertAuthProfile(profile: AuthProfile): AuthProfile {
  const incoming = normalizeProfile(profile);
  const existing = state.profiles.find((item) => item.userId === incoming.userId);
  if (!existing) {
    incoming.username = availableUsername(incoming.username, state.profiles, incoming.userId);
    incoming.customUsername = incoming.username;
    state.profiles.push(incoming);
    persistProfiles({ upserts: [incoming], deletedUserIds: [] });
    return incoming;
  }

  const customDisplayName = existing.customDisplayName ?? incoming.customDisplayName;
  Object.assign(existing, incoming, {
    username: existing.username,
    customDisplayName,
    customUsername: existing.customUsername ?? incoming.customUsername,
    displayName: customDisplayName ?? existing.displayName,
    identities: mergeIdentities(existing.identities ?? [], incoming.identities ?? []),
    aliases: [...new Set([...(existing.aliases ?? []), ...(incoming.aliases ?? [])])],
  });
  persistProfiles({ upserts: [existing], deletedUserIds: [] });
  return existing;
}

export function upsertAuthIdentity(userId: string, identity: AuthIdentity): AuthProfile {
  const existing = getAuthProfile(userId);
  if (!existing) {
    return upsertAuthProfile({
      userId,
      provider: identity.provider,
      providerId: identity.providerId,
      username: identity.username,
      displayName: identity.displayName,
      email: identity.email,
      avatarUrl: identity.avatarUrl,
      identities: [identity],
      updatedAt: identity.updatedAt,
    });
  }

  existing.identities = mergeIdentities(existing.identities ?? [legacyIdentity(existing)], [identity]);
  if (identity.source === 'oauth') {
    existing.email = identity.email ?? existing.email;
    existing.avatarUrl = existing.avatarUrl ?? identity.avatarUrl;
  }
  existing.updatedAt = identity.updatedAt;
  persistProfiles({ upserts: [existing], deletedUserIds: [] });
  return existing;
}

export function getAuthProfile(userId: string): AuthProfile | undefined {
  return state.profiles.find((profile) => profile.userId === userId || profile.aliases?.includes(userId));
}

export function listAuthProfiles(): AuthProfile[] {
  return state.profiles.map((profile) => structuredClone(profile));
}

export function findAuthProfileByIdentity(provider: AuthProvider, providerId: string): AuthProfile | undefined {
  return state.profiles.find((profile) =>
    (profile.identities ?? [legacyIdentity(profile)]).some(
      (identity) => identity.provider === provider && identity.providerId === providerId,
    ),
  );
}

export function findAuthProfileByEmail(email: string): AuthProfile | undefined {
  const normalizedEmail = email.trim().toLowerCase();
  return state.profiles.find((profile) => profile.email?.trim().toLowerCase() === normalizedEmail
    || (profile.identities ?? [legacyIdentity(profile)]).some((identity) => identity.email?.trim().toLowerCase() === normalizedEmail));
}

export function resolveAuthUserId(userId: string): string {
  return getAuthProfile(userId)?.userId ?? userId;
}

export function mergeAuthProfiles(targetUserId: string, sourceUserId: string): AuthProfile | undefined {
  if (targetUserId === sourceUserId) return getAuthProfile(targetUserId);
  const target = getAuthProfile(targetUserId);
  const source = getAuthProfile(sourceUserId);
  if (!source) return target;

  if (!target) {
    const previousUserId = source.userId;
    source.aliases = [...new Set([...(source.aliases ?? []), source.userId])];
    source.userId = targetUserId;
    persistProfiles({ upserts: [source], deletedUserIds: [previousUserId] });
    return source;
  }

  target.identities = mergeIdentities(
    target.identities ?? [legacyIdentity(target)],
    source.identities ?? [legacyIdentity(source)],
  );
  target.aliases = [...new Set([...(target.aliases ?? []), source.userId, ...(source.aliases ?? [])])];
  target.email = target.email ?? source.email;
  target.avatarUrl = target.avatarUrl ?? source.avatarUrl;
  target.updatedAt = new Date().toISOString();
  state.profiles = state.profiles.filter((profile) => profile !== source);
  persistProfiles({ upserts: [target], deletedUserIds: [source.userId] });
  return target;
}

export function setAuthDisplayName(userId: string, displayName: string): AuthProfile | undefined {
  const profile = getAuthProfile(userId);
  if (!profile) return undefined;
  profile.customDisplayName = displayName;
  profile.displayName = displayName;
  profile.updatedAt = new Date().toISOString();
  persistProfiles({ upserts: [profile], deletedUserIds: [] });
  return profile;
}

export function getLinkedAuthProviders(userId: string): AuthProvider[] {
  const profile = getAuthProfile(userId);
  if (!profile) return [];
  return [...new Set((profile.identities ?? [legacyIdentity(profile)]).map((identity) => identity.provider))];
}

export function getLinkedAuthIdentities(userId: string): Array<Pick<AuthIdentity, 'provider' | 'username' | 'displayName' | 'avatarUrl'>> {
  const profile = getAuthProfile(userId);
  if (!profile) return [];
  return (profile.identities ?? [legacyIdentity(profile)]).map(({ provider, username, displayName, avatarUrl }) => ({ provider, username, displayName, avatarUrl }));
}

export function removeAuthIdentity(userId: string, provider: AuthProvider): AuthProfile | undefined {
  const profile = getAuthProfile(userId);
  if (!profile) return undefined;
  const currentIdentities = profile.identities ?? [legacyIdentity(profile)];
  const removedIdentity = currentIdentities.find((identity) => identity.provider === provider);
  const identities = currentIdentities.filter((identity) => identity.provider !== provider);
  if (!removedIdentity || identities.length === 0) return undefined;
  const primary = identities.find((identity) => identity.source === 'oauth') ?? identities[0];
  profile.identities = identities;
  profile.provider = primary.provider;
  profile.providerId = primary.providerId;
  profile.email = primary.email;
  profile.avatarUrl = primary.avatarUrl;
  profile.aliases = (profile.aliases ?? []).filter((alias) => alias !== `${provider}:${removedIdentity.providerId}`);
  profile.updatedAt = new Date().toISOString();
  persistProfiles({ upserts: [profile], deletedUserIds: [] });
  return profile;
}

export function exportIdentitySnapshot(): IdentitySnapshot {
  return structuredClone(state);
}

export function setAuthUsername(userId: string, username: string): AuthProfile | undefined {
  const profile = getAuthProfile(userId);
  if (!profile) return undefined;
  const requested = username.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/.test(requested)) throw new Error('username must be 2–40 characters using letters, numbers, dots, underscores, or hyphens');
  if (requested.toLowerCase() === 'root' || requested.toLowerCase() === 'system') throw new Error('username is unavailable');
  if (state.profiles.some((other) => other !== profile && other.username.toLowerCase() === requested.toLowerCase())) throw new Error('username is already taken');
  profile.customUsername = requested;
  profile.username = requested;
  profile.updatedAt = new Date().toISOString();
  persistProfiles({ upserts: [profile], deletedUserIds: [] });
  return profile;
}

export function deleteAuthProfile(userId: string): boolean {
  const profile = getAuthProfile(userId);
  if (!profile) return false;
  state.profiles = state.profiles.filter((candidate) => candidate !== profile);
  persistProfiles({ upserts: [], deletedUserIds: [profile.userId] });
  return true;
}

export function isIdentitySnapshot(value: unknown): value is IdentitySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const profiles = (value as Record<string, unknown>).profiles;
  return Array.isArray(profiles) && profiles.every(isAuthProfileRecord);
}

export function replaceIdentitySnapshot(snapshot: IdentitySnapshot, options: { persist?: boolean } = {}): void {
  state.profiles = normalizeAccountUsernames(structuredClone(snapshot.profiles).map(normalizeProfile));
  if (options.persist !== false) persistIdentitySnapshot();
}
