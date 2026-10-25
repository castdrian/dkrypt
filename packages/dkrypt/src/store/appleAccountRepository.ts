import type { Database } from 'bun:sqlite';

export interface EncryptedAppleAccountRecord {
  id: 'primary';
  accountHint: string;
  ciphertext: string;
  sessionCiphertext?: string;
  updatedAt: number;
  authenticatedAt?: number;
  authenticationError?: string;
  storefrontCountry?: string;
}

export interface AppleAccountRepository {
  read(): EncryptedAppleAccountRecord | undefined;
  write(record: EncryptedAppleAccountRecord): void;
  delete(): boolean;
  close(): void;
}

export function createAppleAccountRepository(database: Database): AppleAccountRepository {
  const readQuery = database.query('SELECT payload FROM appstore_offline_account WHERE id = ?');
  const writeQuery = database.query(`
    INSERT INTO appstore_offline_account (id, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `);
  const deleteQuery = database.query('DELETE FROM appstore_offline_account WHERE id = ?');

  return {
    read() {
      const row = readQuery.get('primary') as { payload?: string } | null;
      if (!row?.payload) return undefined;
      const record = JSON.parse(row.payload) as EncryptedAppleAccountRecord;
      if (record.id !== 'primary' || typeof record.ciphertext !== 'string' || typeof record.accountHint !== 'string') {
        throw new Error('stored App Store account record is malformed');
      }
      return record;
    },
    write(record) {
      writeQuery.run(record.id, JSON.stringify(record), record.updatedAt);
    },
    delete() {
      return deleteQuery.run('primary').changes > 0;
    },
    close() {
      database.close();
    },
  };
}
