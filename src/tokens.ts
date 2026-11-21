import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TOKEN_STORE, tokenEncryptionKey } from "./config.js";
import * as keychain from "./keychain.js";
import { openDb, type DB } from "./db.js";

// Access-token storage behind one interface:
//   keychain  – macOS login Keychain via the `security` CLI (local laptop mode)
//   db        – AES-256-GCM encrypted rows in SQLite, key from TOKEN_ENCRYPTION_KEY
//               (hosted mode, where there is no Keychain)
// Nothing outside this module decides where tokens live.

let dbConn: DB | null = null;
const db = () => (dbConn ??= openDb());

function encrypt(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenEncryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext: ct.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decrypt(row: { ciphertext: string; iv: string; tag: string }): string {
  const d = createDecipheriv("aes-256-gcm", tokenEncryptionKey(), Buffer.from(row.iv, "base64"));
  d.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(row.ciphertext, "base64")), d.final()]).toString("utf8");
}

export function storeAccessToken(itemId: string, accessToken: string): void {
  if (TOKEN_STORE === "keychain") return keychain.storeAccessToken(itemId, accessToken);
  const enc = encrypt(accessToken);
  db().raw
    .prepare(
      `INSERT INTO tokens (item_id, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`,
    )
    .run(itemId, enc.ciphertext, enc.iv, enc.tag, new Date().toISOString());
}

export function readAccessToken(itemId: string): string {
  if (TOKEN_STORE === "keychain") return keychain.readAccessToken(itemId);
  const row = db().raw.prepare(`SELECT ciphertext, iv, tag FROM tokens WHERE item_id = ?`).get(itemId) as
    | { ciphertext: string; iv: string; tag: string }
    | undefined;
  if (!row) throw new Error(`No access token stored for item ${itemId}. Re-link it with the start_link tool.`);
  return decrypt(row);
}

export function hasAccessToken(itemId: string): boolean {
  try {
    readAccessToken(itemId);
    return true;
  } catch {
    return false;
  }
}

export function deleteAccessToken(itemId: string): void {
  if (TOKEN_STORE === "keychain") return keychain.deleteAccessToken(itemId);
  db().raw.prepare(`DELETE FROM tokens WHERE item_id = ?`).run(itemId);
}

/** Encrypted blob for moving a token between machines that share TOKEN_ENCRYPTION_KEY. */
export function exportEncrypted(itemId: string) {
  return encrypt(readAccessToken(itemId));
}
export function importEncrypted(itemId: string, blob: { ciphertext: string; iv: string; tag: string }) {
  storeAccessToken(itemId, decrypt(blob));
}
