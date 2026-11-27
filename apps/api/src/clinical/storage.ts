import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { config } from '../config.js';

const MAGIC = Buffer.from('MDR1');

/**
 * Medical files are encrypted with AES-256-GCM before they touch the disk. Each file gets a random
 * key-derivation salt and IV; the stored layout is MAGIC | salt(16) | iv(12) | tag(16) | ciphertext.
 * The storage key is random and carries no patient information.
 */
export async function storeEncrypted(orgId: string, bytes: Buffer): Promise<{ storageKey: string; sha256: string }> {
  const salt = randomBytes(16); const iv = randomBytes(12);
  const key = createHash('sha256').update(Buffer.concat([config.fileKey, salt])).digest();
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(bytes), c.final()]);
  const storageKey = `${orgId}/${randomUUID()}`;
  const blob = Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), enc]);
  if (config.storageInDb) {
    await ownerQuery(`INSERT INTO demo_file_blobs(storage_key, blob) VALUES ($1, $2)`, [storageKey, blob]);
  } else {
    const path = join(config.storageDir, storageKey);
    await mkdir(join(config.storageDir, orgId), { recursive: true, mode: 0o700 });
    await writeFile(path, blob, { mode: 0o600, flag: 'wx' });
  }
  return { storageKey, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function readDecrypted(storageKey: string): Promise<Buffer> {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(storageKey)) throw new Error('bad storage key');
  const blob = config.storageInDb
    ? (await ownerQuery<{ blob: Buffer }>(`SELECT blob FROM demo_file_blobs WHERE storage_key = $1`, [storageKey]))[0]?.blob
    : await readFile(join(config.storageDir, storageKey));
  if (!blob) throw new Error('file not found');
  if (!blob.subarray(0, 4).equals(MAGIC)) throw new Error('unknown file format');
  const salt = blob.subarray(4, 20), iv = blob.subarray(20, 32), tag = blob.subarray(32, 48);
  const key = createHash('sha256').update(Buffer.concat([config.fileKey, salt])).digest();
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(48)), d.final()]);
}

/** Accepted upload types, checked against the file's first bytes as well as the declared type. */
export const ALLOWED_TYPES: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/heic': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
};

/**
 * Demo servers on hosts without a shared disk (serverless) keep the encrypted file bytes in the demo database instead,
 * through the owner connection, so every instance sees every upload. Never used on a real clinic's server.
 */
let ownerPool: any = null;
let tableReady = false;
async function ownerQuery<R = any>(sql: string, params: unknown[]): Promise<R[]> {
  if (!ownerPool) {
    const pg = createRequire(import.meta.url)('pg');
    ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  }
  if (!tableReady) {
    await ownerPool.query(`CREATE TABLE IF NOT EXISTS demo_file_blobs (storage_key text PRIMARY KEY, blob bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    tableReady = true;
  }
  try { return (await ownerPool.query(sql, params)).rows; }
  catch (e: any) {
    // A demo reset drops the schema: create the table again once and retry.
    if (e?.code !== '42P01') throw e;
    tableReady = false; return ownerQuery(sql, params);
  }
}
