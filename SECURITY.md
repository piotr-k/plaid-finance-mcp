# Security

## Reporting a vulnerability

Open a private security advisory on this repository's Security tab (GitHub → Security → Advisories →
Report a vulnerability). Please do not file a public issue for anything exploitable. This is a one-person
project; expect an acknowledgement within a week.

## Security model

- `.env`, databases, `exports/`, `accounts.json` and `fly.toml` are git-ignored.
- Local mode opens no ports. `npm run link` makes outbound calls to Plaid and opens a Plaid-hosted page;
  Plaid handles the banks' OAuth redirects on its own HTTPS domain, so no redirect URI is registered.
- Tokens: Keychain service `plaid-mcp/<env>` (one entry per bank) or an AES-256-GCM column in SQLite.
- Tool output and logs never include `access_token`, `link_token`, `public_token` or API keys; the smoke
  test asserts this.
- Hosted mode: OAuth 2.1 with PKCE, hashed authorization codes and tokens, 30-day access and 90-day refresh
  tokens. Clients may only register redirect URIs matching `ALLOWED_REDIRECTS`: by default the exact claude.ai
  and claude.com callback URLs, plus loopback for Claude Code. The sign-in page names the client and the exact
  address that will receive the code, so you can refuse a request you did not start, and it cannot be
  framed. Each sign-in is also bound to the browser that started it with an HttpOnly cookie set at
  /authorize, so a forwarded sign-in link cannot be completed by anyone else. Wrong passphrases are limited
  to 3 per sign-in request, 5 per IP and 60 overall per 15 minutes, counted in SQLite so a restart does not
  reset them. The passphrase must be at least 8 characters; use 16 or more. Plaid webhooks are verified
  (ES256, five-minute window) and key lookups for unknown key ids are negative-cached and rate-limited.
- `TRUST_PROXY` defaults to 1 on Fly and 0 elsewhere; set it to your proxy hop count if you run behind
  another reverse proxy, otherwise throttling cannot see real client addresses.
- Bearer tokens need the `finance:read` scope; the link tools additionally need `finance:link`. Live balance
  calls are limited to one per bank per minute because Plaid bills them.
- If a token is ever exposed, call `/item/access_token/invalidate` and rotate the secret in the Plaid
  Dashboard.

## What has been done

A static security audit and an adversarial review were run on 2026-11-21, and every finding was fixed
the same day. That is a review, not an audit by a third party, and the project is maintained by one
person. See [docs/disclaimer.md](docs/disclaimer.md).
