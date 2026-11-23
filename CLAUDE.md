# plaid-finance-mcp — project notes

Read-only Plaid MCP server. README.md is the user guide. PLAID_PLAN.md is the Plaid build-kit state and
is git-ignored (it is a personal build log); it lives on the maintainer's machine. Machine- and
deployment-specific notes belong in `CLAUDE.local.md` (also git-ignored), not here.

## Architecture (src/)
- `config.ts` loads `.env` relative to the project root; `PLAID_ENV` picks API host, secret
  (`PLAID_SECRET_<ENV>`, falling back to `PLAID_SECRET`), `data/plaid-<env>.db` and Keychain service
  `plaid-mcp/<env>`. Log only to stderr.
- `keychain.ts` wraps `security -i` (stdin) so tokens never appear in argv. `tokens.ts` chooses Keychain vs
  AES-256-GCM-in-SQLite by `TOKEN_STORE` (default: keychain on macOS, db elsewhere); all code reads tokens
  through it.
- `db.ts` better-sqlite3; `applySync` writes all pages + cursor in one transaction and deletes the
  pending row a posted transaction points at.
- `plaid.ts` single `PlaidClient` (SDK v51, Fern-generated: `plaid().transactions.sync`, `.accounts.get`,
  `.accounts.getBalance`, `.liabilities.get`, `.link.createToken`, `.item.exchangePublicToken`).
  Errors: `err.body.error_code`; use `plaidError()` / `describeError()`.
- `sync.ts` buffered /transactions/sync with mutation restart; `refreshAccounts` via /accounts/get.
- `liabilities.ts` /liabilities/get per item with credit/loan accounts; `promo_end` only from accounts.json.
- `export.ts` CSV, sign flipped (negative = money out).
- `tools.ts` registers the MCP tools for both modes; `server.ts` is the stdio entry, `http-server.ts` the
  hosted entry (Express + Streamable HTTP, stateless, one server per request, OAuth 2.1 via the SDK's
  `mcpAuthRouter` with `oauth.ts`: SQLite-backed provider, passphrase login page, hashed codes/tokens).
- `hosted-link.ts` is the one Hosted Link flow used by the CLI (`link.ts`), `start_link` and the LINK
  webhook. Duplicate rule (`findDuplicate`): a new Item is removed only when one of its account masks already
  belongs to an existing Item at the same institution. Same bank with different masks (a second person's
  own login) is kept. Every outcome logs a `duplicate check:` line. Accounts without a mask never count.
- `webhooks.ts` verifies the Plaid JWT (ES256, kid-cached key, 5-min max age, raw-body sha256) and
  dispatches TRANSACTIONS/ITEM/LIABILITIES/LINK codes; work is serialized through `enqueue`.
- Hardening (2026-11-21, after a /cso audit): registration allowlist `redirectUriAllowed` (exact https URLs via `ALLOWED_REDIRECTS`,
  loopback hosts any path) + consent page naming client and exact redirect target + CSP frame-ancestors none;
  `authorize()` answers 400 itself for a disallowed URL (throwing would make the SDK redirect there); login
  failures in SQLite `login_failures` (3 per request, 5 per IP, 60 global per 15 min); `clientIp` trusts
  Fly-Client-IP only when FLY_APP_NAME is set; `TRUST_PROXY` defaults 1 on Fly, 0 elsewhere; /mcp runs bearer
  auth (requiredScopes finance:read) before JSON parsing and link tools need finance:link; webhook `keyFor`
  validates kid, negative-caches only definitive failures, coalesces, 20 lookups/min; hosted `unlink` gated by
  `HOSTED_UNLINK`; get_balances one live call per item per minute; client_name capped at 100 chars;
  pending requests bound to the starting browser via the HttpOnly `mcp_authorize` cookie (`bind_hash` column,
  additive migration in db.ts) and enforced in the login router before the passphrase is compared. Keep these when touching oauth.ts or webhooks.ts.
- `cli.ts` items/sync/export/unlink/reset-login/export-items.
- No redirect URI: production rejects http://localhost redirect URIs (HTTPS only), so Hosted Link is the
  only laptop-friendly way to link OAuth banks. Do not reintroduce a local Link page without HTTPS.

- `scripts/setup-hosted.ts` (`npm run setup:hosted`) drives the Fly deploy: CLI/login checks, fly.toml from the
  template (`renderFlyToml`, tested), app + volume (idempotent), key generation into .env, hidden passphrase (12+),
  `fly secrets set --stage` with one argv element per secret (no shell), deploy, /health poll, connect URLs.
- `scripts/setup.ts` is the first-run wizard (`npm run setup`): toolchain checks, hidden-input Plaid keys into
  `.env` (0600), build, sandbox smoke, prints the `claude mcp add` line. Pure helpers `mergeEnv`/`parseEnv` are tested.

## Testing
- `npm test` (unit), `PLAID_ENV=sandbox npm run smoke` (live sandbox, two personas, through the real MCP
  server). `.env` holds both secrets; `PLAID_ENV` picks one.
- The smoke test spawns the server with `getDefaultEnvironment()` + `PLAID_ENV=sandbox`; the MCP stdio
  client filters env by default, so without that the child reads `.env` and may hit production.
- Sandbox data is inconsistent (card payments can carry the wrong sign); never tune parsing to it.
- Hosted server locally: see test/hosted.test.ts (token store, OAuth register → authorize → login → token →
  refresh → revoke, lockout). `requireBearerAuth` needs `InvalidTokenError` for a 401.

## Deploy
- `fly.example.toml` is the template; the real `fly.toml` is git-ignored. Secrets via `fly secrets set`
  reading values out of `.env` with grep/cut so they never print. Quote carefully: an unmatched quote once
  set PLAID_CLIENT_ID to "" silently.
- `reconcileItemsOnBoot` points every item's webhook at PUBLIC_URL and syncs never-synced items, so a boot
  with missing secrets recovers on the next one.

## Rules
- Never print, log or return access/link/public tokens or `.env` values. Never `cat .env`.
- Read-only Plaid products only. Do not add auth/transfer/payment endpoints.
- Before changing Plaid-touching code consult the Plaid MCP `build_guidance`; re-run
  `build_check_acceptance` before claiming it works (see PLAID_PLAN.md).
- Keep CSV columns exactly `date,account,description,amount,pending`.
- Keep the repo free of personal data: example files use made-up masks, docs use `<app>` placeholders,
  and the deployment's display name comes from `APP_NAME` (never hardcode it).

## Decisions log
- 2026-11-19: Node+TS over Python (MCP SDK + Plaid SDK are first-class in TS). `security` CLI over keytar.
  365-day history. Liabilities added at user request. Localhost Link page replaced by Hosted Link after
  production rejected the http redirect URI. Hosted mode on Fly with OAuth so claude.ai connectors and
  cloud routines can use it. Acceptance rounds 1–3 PASS.
- 2026-11-20: Duplicate detection relaxed from institution-level to account-mask overlap so a second person
  can link their own account at an already-linked bank. Acceptance re-run: PASS. Deployed.
- 2026-11-21: Repo prepared for open source: personal identifiers scrubbed, `fly.example.toml`, MIT license,
  README rewritten for first-time users, local notes moved to `CLAUDE.local.md`.
- 2026-11-21: /cso audit (run 1795271036741-7c28a7cf1e454f22) found: client-blind consent page with open registration (high), spoofable/in-memory login throttle (medium), webhook key-lookup amplification (low). All fixed the same day: redirect-host allowlist, consent page naming client + redirect host, CSP/XFO, SQLite-backed 3/5/20 failure budgets, Fly header trusted only on Fly, TRUST_PROXY, kid validation + negative cache + coalescing + 5/min lookups, empty-body 401, hosted unlink behind HOSTED_UNLINK. Verified by 16 unit tests, sandbox smoke and a local hosted boot with curl.
- 2026-11-21 (later): adversarial subagent review of the fixes found 7 issues; all addressed: exact-URL redirect allowlist (ALLOWED_REDIRECTS), authorize() 400 instead of error-redirect, TRUST_PROXY default 0 off-Fly, global login budget 60, /mcp auth before JSON parsing, requiredScopes finance:read + finance:link for link tools, get_balances 1/min/item, webhook negative cache only for definitive Plaid answers (20 lookups/min), client_name cap. Live tokens all carry both scopes, so the scope checks do not break existing sessions. 17/17 tests, smoke OK, acceptance PASS.
