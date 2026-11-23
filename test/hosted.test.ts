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
  const res = { redirect: (_c: number, url: string) => { redirected = url; }, cookie: () => {} } as never;
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

test("oauth: registration rejects redirect hosts outside the allowlist", async () => {
  const db = dbmod.openDb();
  const p = new oauth.SqliteOAuthProvider(db);
  assert.throws(() => p.clientsStore.registerClient!({ redirect_uris: ["https://evil.example/cb"], client_name: "x" } as never), /not allowed/);
  assert.throws(() => p.clientsStore.registerClient!({ redirect_uris: ["http://claude.ai/api/mcp/auth_callback"] } as never), /not allowed/); // https required off-loopback
  assert.throws(() => p.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai.evil.example/cb"] } as never), /not allowed/);
  assert.throws(() => p.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/some/open/redirect?u=https://evil.example"] } as never), /not allowed/); // exact path required off loopback
  assert.throws(() => p.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "x".repeat(101) } as never), /client_name/);
  assert.equal(oauth.redirectUriAllowed("https://claude.ai:8443/api/mcp/auth_callback"), false); // different origin
  assert.equal(oauth.redirectUriAllowed("https://CLAUDE.AI/api/mcp/auth_callback"), true);
  assert.equal(oauth.redirectUriAllowed("http://localhost:1234/anything/here"), true);
  assert.ok(await p.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" } as never));
  assert.ok(await p.clientsStore.registerClient!({ redirect_uris: ["http://localhost:63543/callback"], client_name: "Claude Code" } as never));
  assert.equal(oauth.redirectUriAllowed("https://user:pw@claude.ai/cb"), false);
  db.close();
});

test("oauth: the login page knows which client and redirect host it is approving", async () => {
  const db = dbmod.openDb();
  const p = new oauth.SqliteOAuthProvider(db);
  const client = await p.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" } as never);
  let url = "";
  await p.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/api/mcp/auth_callback", scopes: ["finance:read"] }, { redirect: (_c: number, u: string) => { url = u; }, cookie: () => {} } as never);
  const reqId = new URL(url, "http://x").searchParams.get("req")!;
  assert.deepEqual(p.pendingInfo(reqId), { client_name: "Claude", redirect_to: "https://claude.ai/api/mcp/auth_callback", scopes: ["finance:read"] });
  assert.equal(p.pendingInfo("nope"), null);
  db.close();
});

test("oauth: a sign-in request burns after 3 wrong passphrases; an IP locks after 5; 60 locks everyone", async () => {
  const db = dbmod.openDb();
  const p = new oauth.SqliteOAuthProvider(db);
  const client = await p.clientsStore.registerClient!({ redirect_uris: ["http://127.0.0.1:1/cb"] } as never);
  const pending = async () => {
    let url = "";
    await p.authorize(client, { codeChallenge: "c", redirectUri: "http://127.0.0.1:1/cb" }, { redirect: (_c: number, u: string) => { url = u; }, cookie: () => {} } as never);
    return new URL(url, "http://x").searchParams.get("req")!;
  };
  const r1 = await pending();
  p.completeLogin(r1, "9.9.9.9", "nope");
  p.completeLogin(r1, "9.9.9.9", "nope");
  const burned = p.completeLogin(r1, "9.9.9.9", "nope");
  assert.ok("error" in burned && burned.status === 400);
  assert.ok("error" in p.completeLogin(r1, "9.9.9.9", "open sesame") && (p.completeLogin(r1, "9.9.9.9", "open sesame") as { status: number }).status === 400); // gone
  const r2 = await pending();
  p.completeLogin(r2, "9.9.9.9", "nope");
  p.completeLogin(r2, "9.9.9.9", "nope"); // 5 failures from this IP now
  const locked = p.completeLogin(await pending(), "9.9.9.9", "open sesame");
  assert.ok("error" in locked && locked.status === 429);
  // Other IPs still work until the global budget (60) is spent.
  for (let i = 0; i < 55; i++) p.completeLogin(await pending(), `10.0.0.${i}`, "nope");
  const everyone = p.completeLogin(await pending(), "8.8.8.8", "open sesame");
  assert.ok("error" in everyone && everyone.status === 429);
  // Counters live in SQLite: a new provider instance sees them too.
  const p2 = new oauth.SqliteOAuthProvider(db);
  const still = p2.completeLogin(await pending(), "8.8.4.4", "open sesame");
  assert.ok("error" in still && still.status === 429);
  db.close();
});

test("oauth: authorize answers 400 itself for a disallowed redirect instead of bouncing to it", async () => {
  const db = dbmod.openDb();
  const p = new oauth.SqliteOAuthProvider(db);
  const client = await p.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" } as never);
  let status = 0, redirected = "", body = "";
  const res = { redirect: (_c: number, u: string) => { redirected = u; }, cookie: () => {}, status(c: number) { status = c; return this; }, type() { return this; }, send(b: string) { body = b; } } as never;
  // Simulate a client whose registered URI predates a stricter allowlist: the SDK would pass it through.
  await p.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/legacy/callback" }, res);
  assert.equal(status, 400);
  assert.equal(redirected, "");
  assert.match(body, /not allowed/);
  db.close();
});

test("oauth: a pending request is bound to the browser that started it", async () => {
  const db = dbmod.openDb();
  const p = new oauth.SqliteOAuthProvider(db);
  const client = await p.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" } as never);
  let url = "", cookieName = "", cookieVal = "", cookieOpts: Record<string, unknown> = {};
  const res = { redirect: (_c: number, u: string) => { url = u; }, cookie: (n: string, v: string, o: Record<string, unknown>) => { cookieName = n; cookieVal = v; cookieOpts = o; } } as never;
  await p.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/api/mcp/auth_callback" }, res);
  const reqId = new URL(url, "http://x").searchParams.get("req")!;
  assert.equal(cookieName, oauth.bindCookieName(reqId));
  assert.notEqual(oauth.bindCookieName("aaaaaaaaaaaaaaaaaaaa"), oauth.bindCookieName("bbbbbbbbbbbbbbbbbbbb")); // two flows, two cookies
  assert.ok(cookieVal.length >= 40);
  assert.equal(cookieOpts.httpOnly, true);
  assert.equal(cookieOpts.sameSite, "lax");
  assert.equal(cookieOpts.path, "/login");
  assert.equal(p.bindMatches(reqId, cookieVal), true);
  assert.equal(p.bindMatches(reqId, "forged"), false);
  assert.equal(p.bindMatches(reqId, undefined), false);
  assert.equal(p.bindMatches("someone-elses-request-id", cookieVal), false);
  assert.equal(oauth.cookieValue(`a=1; ${cookieName}=${cookieVal}; b=2`, cookieName), cookieVal);
  assert.equal(oauth.cookieValue(undefined, cookieName), undefined);
  db.close();
});

test("oauth: a client that requests no scopes is granted all of them; unknown scopes are dropped", () => {
  assert.deepEqual(oauth.grantedScopes(undefined), ["finance:read", "finance:link"]);
  assert.deepEqual(oauth.grantedScopes([]), ["finance:read", "finance:link"]);
  assert.deepEqual(oauth.grantedScopes(["finance:read"]), ["finance:read"]);
  assert.deepEqual(oauth.grantedScopes(["bogus"]), ["finance:read", "finance:link"]);
  assert.deepEqual(oauth.grantedScopes(["finance:link", "bogus"]), ["finance:link"]);
});

test("login page CSP form-action allows the callback origins, otherwise browsers block the post-login redirect", () => {
  const fa = oauth.formActionSources();
  assert.match(fa, /'self'/);
  assert.match(fa, /https:\/\/claude\.ai/);
  assert.match(fa, /https:\/\/claude\.com/);
  assert.match(fa, /http:\/\/localhost:\*/);
  assert.match(fa, /http:\/\/127\.0\.0\.1:\*/);
  assert.doesNotMatch(fa, /auth_callback/); // origins only, no paths
});
