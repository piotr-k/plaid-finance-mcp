import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";

// Hosted-mode pieces run against a throwaway data dir and key.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "plaid-hosted-"));
process.env.TOKEN_STORE = "db";
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.MCP_PASSPHRASE = "open sesame";
process.env.PLAID_ENV = "sandbox";

let tokens: typeof import("../src/tokens.js");
let oauth: typeof import("../src/oauth.js");
let dbmod: typeof import("../src/db.js");
before(async () => {
  tokens = await import("../src/tokens.js");
  oauth = await import("../src/oauth.js");
  dbmod = await import("../src/db.js");
});

test("encrypted token store round-trips and export/import works", () => {
  tokens.storeAccessToken("item-a", "access-sandbox-abc123");
  assert.equal(tokens.readAccessToken("item-a"), "access-sandbox-abc123");
  const blob = tokens.exportEncrypted("item-a");
  assert.notEqual(blob.ciphertext, "access-sandbox-abc123");
  tokens.importEncrypted("item-b", blob);
  assert.equal(tokens.readAccessToken("item-b"), "access-sandbox-abc123");
  tokens.deleteAccessToken("item-a");
  assert.equal(tokens.hasAccessToken("item-a"), false);
});

test("oauth: register → authorize → login → code → tokens → verify → refresh → revoke", async () => {
  const db = dbmod.openDb();
  const p = new oauth.SqliteOAuthProvider(db);
  const client = await p.clientsStore.registerClient!({ redirect_uris: ["http://127.0.0.1:1/cb"], client_name: "t" } as never);
  assert.ok(client.client_id);
  assert.deepEqual(await p.clientsStore.getClient(client.client_id), client);

  let redirected = "";
  const res = { redirect: (_c: number, url: string) => { redirected = url; } } as never;
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await p.authorize(client, { codeChallenge: challenge, redirectUri: "http://127.0.0.1:1/cb", state: "s1", scopes: ["finance:read"] }, res);
  const reqId = new URL(redirected, "http://x").searchParams.get("req")!;

  const bad = p.completeLogin(reqId, "1.2.3.4", "wrong");
  assert.ok("error" in bad && bad.status === 401);
  const ok = p.completeLogin(reqId, "1.2.3.4", "open sesame");
  assert.ok("redirect" in ok);
  const cb = new URL(ok.redirect);
  assert.equal(cb.searchParams.get("state"), "s1");
  const code = cb.searchParams.get("code")!;
  assert.equal(await p.challengeForAuthorizationCode(client, code), challenge);

  const t = await p.exchangeAuthorizationCode(client, code, verifier, "http://127.0.0.1:1/cb");
  assert.equal(t.token_type, "bearer");
  await assert.rejects(() => p.exchangeAuthorizationCode(client, code, verifier), /Invalid or expired/); // single use
  const info = await p.verifyAccessToken(t.access_token);
  assert.equal(info.clientId, client.client_id);
  await assert.rejects(() => p.verifyAccessToken("garbage"));

  const t2 = await p.exchangeRefreshToken(client, t.refresh_token!);
  await assert.rejects(() => p.exchangeRefreshToken(client, t.refresh_token!)); // rotated
  await p.revokeToken!(client, { token: t2.access_token });
  await assert.rejects(() => p.verifyAccessToken(t2.access_token));
  db.close();
});

test("oauth: wrong passphrase 5 times locks that IP", async () => {
  const db = dbmod.openDb();
  const p = new oauth.SqliteOAuthProvider(db);
  const client = await p.clientsStore.registerClient!({ redirect_uris: ["http://127.0.0.1:1/cb"] } as never);
  let url = "";
  await p.authorize(client, { codeChallenge: "c", redirectUri: "http://127.0.0.1:1/cb" }, { redirect: (_c: number, u: string) => { url = u; } } as never);
  const reqId = new URL(url, "http://x").searchParams.get("req")!;
  for (let i = 0; i < 5; i++) p.completeLogin(reqId, "9.9.9.9", "nope");
  const r = p.completeLogin(reqId, "9.9.9.9", "open sesame");
  assert.ok("error" in r && r.status === 429);
  db.close();
});
