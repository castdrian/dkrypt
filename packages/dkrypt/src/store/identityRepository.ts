import type { Database } from 'bun:sqlite';
import type { AuthProfile } from '#identity.js';

type IdentityProfileRow = { id: string; payload: unknown; updatedAt: number };

export interface IdentityProfileChanges {
  upserts: AuthProfile[];
  deletedUserIds: string[];
}

export interface IdentityRepository {
  listAll(): AuthProfile[];
  findByUserId(userId: string): AuthProfile | undefined;
  save(profile: AuthProfile): void;
  deleteByUserId(userId: string): boolean;
  applyChanges(changes: IdentityProfileChanges): void;
  replaceAll(profiles: AuthProfile[]): void;
  importLegacySnapshot(loadProfiles: () => AuthProfile[] | undefined): void;
  close(): void;
}

const legacyImportMarker = 'auth_profiles_json_imported';

export function isAuthIdentityRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return (identity.provider === 'github' || identity.provider === 'discord' || identity.provider === 'apple')
    && typeof identity.providerId === 'string'
    && typeof identity.username === 'string'
    && typeof identity.displayName === 'string'
    && (identity.source === 'oauth' || identity.source === 'discord_connection')
    && typeof identity.updatedAt === 'string';
}

export function isAuthProfileRecord(value: unknown): value is AuthProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return typeof profile.userId === 'string'
    && (profile.provider === 'github' || profile.provider === 'discord' || profile.provider === 'apple')
    && typeof profile.providerId === 'string'
    && typeof profile.username === 'string'
    && typeof profile.displayName === 'string'
    && (profile.customUsername === undefined || typeof profile.customUsername === 'string')
    && typeof profile.updatedAt === 'string'
    && (profile.identities === undefined || (Array.isArray(profile.identities) && profile.identities.every(isAuthIdentityRecord)))
    && (profile.aliases === undefined || (Array.isArray(profile.aliases) && profile.aliases.every((alias) => typeof alias === 'string')));
}

export function identityProfileUpdatedAt(profile: AuthProfile): number {
  return Date.parse(profile.updatedAt) || Date.now();
}

export function identityProfileStateRow(profile: AuthProfile): IdentityProfileRow {
  if (!isAuthProfileRecord(profile)) throw new Error('identity profile is malformed');
  const normalized = structuredClone(profile);
  return {
    id: normalized.userId,
    payload: { kind: 'profile', value: normalized },
    updatedAt: identityProfileUpdatedAt(normalized),
  };
}

export function createIdentityRepository(database: Database): IdentityRepository {
  const listAllQuery = database.query('SELECT payload FROM auth_profiles ORDER BY rowid ASC;');
  const findByUserIdQuery = database.query('SELECT payload FROM auth_profiles WHERE id = ?;');
  const deleteAllQuery = database.query('DELETE FROM auth_profiles;');
  const countRecordsQuery = database.query('SELECT count(*) AS total FROM auth_profiles;');
  const findMarkerQuery = database.query('SELECT value FROM metadata WHERE key = ?;');
  const saveMarkerQuery = database.query(`
    INSERT INTO metadata (key, value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);
  const upsertQuery = database.query(`
    INSERT INTO auth_profiles (id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
  `);
  const importQuery = database.query(`
    INSERT INTO auth_profiles (id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO NOTHING;
  `);
  const deleteQuery = database.query('DELETE FROM auth_profiles WHERE id = ?;');

  function copy(profile: AuthProfile): AuthProfile {
    return structuredClone(profile);
  }

  function parse(payload: string): AuthProfile {
    const persisted: unknown = JSON.parse(payload);
    const value = typeof persisted === 'object' && persisted !== null && 'value' in persisted
      ? (persisted as { value?: unknown }).value
      : persisted;
    if (!isAuthProfileRecord(value)) throw new Error('identity database profile is malformed');
    return copy(value);
  }

  function write(profile: AuthProfile, query = upsertQuery): void {
    const row = identityProfileStateRow(profile);
    query.run(row.id, JSON.stringify(row.payload), row.updatedAt);
  }

  function listAll(): AuthProfile[] {
    return (listAllQuery.all() as Array<{ payload: string }>).map(({ payload }) => parse(payload));
  }

  function transaction<T>(operation: () => T): T {
    database.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      database.exec('COMMIT;');
      return result;
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }

  return {
    listAll,
    findByUserId(userId) {
      const row = findByUserIdQuery.get(userId) as { payload: string } | null;
      return row ? parse(row.payload) : undefined;
    },
    save(profile) {
      write(profile);
    },
    deleteByUserId(userId) {
      return deleteQuery.run(userId).changes > 0;
    },
    applyChanges(changes) {
      transaction(() => {
        for (const userId of changes.deletedUserIds) deleteQuery.run(userId);
        for (const profile of changes.upserts) write(profile);
      });
    },
    replaceAll(profiles) {
      transaction(() => {
        deleteAllQuery.run();
        for (const profile of profiles) write(profile);
      });
    },
    importLegacySnapshot(loadProfiles) {
      transaction(() => {
        if (findMarkerQuery.get(legacyImportMarker)) {
          return;
        }
        const row = countRecordsQuery.get() as { total: number };
        if (row.total === 0) {
          const profiles = loadProfiles();
          if (!profiles) return;
          for (const profile of profiles) {
            if (!isAuthProfileRecord(profile)) throw new Error('legacy identity profile is malformed');
            write(profile, importQuery);
          }
        }
        saveMarkerQuery.run(legacyImportMarker);
      });
    },
    close() {
      database.close();
    },
  };
}
