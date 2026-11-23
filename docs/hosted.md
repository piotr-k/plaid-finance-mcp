# Hosted mode (Fly.io)

The same code runs as an always-on HTTPS service on a machine you own, so the data is reachable when you
are not at your computer. Start with local mode working ([README](../README.md)), then come here.

## What changes from local mode

- `dist/http-server.js` serves MCP over Streamable HTTP at `/mcp`, protected by OAuth 2.1. It is a
  single-user server: clients register dynamically and the login page asks for your `MCP_PASSPHRASE`.
- Access tokens are AES-256-GCM encrypted in SQLite with `TOKEN_ENCRYPTION_KEY`.
- `/plaid/webhook` verifies Plaid's signature and syncs as banks post updates. A daily sync at 09:00 UTC
  catches anything missed.
- Two extra tools, `start_link` and `link_status`. A third, `unlink`, is off by default because it is
  destructive and callable by the model; set `HOSTED_UNLINK=true` to expose it, or unlink from the
  machine with `fly ssh console -C "node dist/cli.js unlink <item_id>"`.
- Linking the same bank twice is fine when it is a different login, for example a second person's own
  account. A new connection is removed as a duplicate only when one of its account masks is already
  linked at that bank. The server log says which check fired (`duplicate check: ...`).

## Deploy with the wizard

```bash
brew install flyctl && fly auth login            # or https://fly.io/docs/flyctl/install/
npm run setup:hosted
```

The hosted wizard asks for an app name, region and display name, writes `fly.toml`, creates the app and
its volume, generates the token encryption key, asks for your passphrase with hidden input, sets every
secret without going through a shell, deploys, waits for the health check and prints the URLs to paste
into claude.ai and Claude Code. Rerun it to redeploy; it reuses what exists. If the app already exists
and its encryption key differs from the one in your `.env`, the wizard stops and tells you how to copy
the server's key down first, so already-linked banks never become unreadable.

## Deploy by hand

The same steps the wizard performs:

```bash
cp fly.example.toml fly.toml                     # replace <app> in both places
fly apps create <app>
fly volumes create plaid_data --region <region> --size 1 -a <app>
echo "TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env   # keep a copy locally for export-items
fly secrets set -a <app> \
  PLAID_CLIENT_ID="$(grep ^PLAID_CLIENT_ID= .env | cut -d= -f2-)" \
  PLAID_SECRET_PRODUCTION="$(grep ^PLAID_SECRET_PRODUCTION= .env | cut -d= -f2-)" \
  TOKEN_ENCRYPTION_KEY="$(grep ^TOKEN_ENCRYPTION_KEY= .env | cut -d= -f2-)" \
  MCP_PASSPHRASE='a long passphrase you choose'
fly deploy --ha=false
curl https://<app>.fly.dev/health
```

Reading values out of `.env` with `grep` keeps them off your screen. Check your quoting: an unmatched
quote sets a secret to an empty string without any error.

## Connect Claude

- **claude.ai** (web, desktop, phone): Settings → Connectors → Add custom connector → URL
  `https://<app>.fly.dev/mcp`. Sign in with your passphrase. Scheduled routines can use the same connector.
- **Claude Code:** `claude mcp add --scope user --transport http plaid-cloud https://<app>.fly.dev/mcp`,
  then `/mcp` → authenticate.

Link banks from any device by asking for `start_link`, finishing in the browser, then `link_status`.

## Other MCP clients

Nothing here is specific to Claude. Local mode is a standard stdio MCP server; hosted mode is Streamable
HTTP with OAuth 2.1, PKCE and dynamic client registration, so any client that implements those should
connect. Only Claude Code and claude.ai have been tested. For another hosted client, add its exact
callback URL to `ALLOWED_REDIRECTS` (clients that use a loopback callback need nothing). Clients that
redirect to a custom URL scheme are refused by design. A client that requests no scopes is granted both.

## Move banks you already linked locally

```bash
npm run cli -- export-items /tmp/items.json   # tokens encrypted with TOKEN_ENCRYPTION_KEY from .env
fly sftp shell -a <app>                        # then: put /tmp/items.json /data/import.json
fly machine restart -a <app>                   # imports on boot, points webhooks at itself, re-syncs
rm /tmp/items.json
```

## Operate

- `fly logs -a <app>` shows request ids and sync counts, never tokens.
- After a suspected compromise: rotate `MCP_PASSPHRASE`, delete rows from `oauth_tokens` and
  `oauth_clients` (`fly ssh console`, then `sqlite3 /data/plaid-production.db`), and call Plaid's
  `/item/access_token/invalidate` for each bank.
- Fly volumes are not encrypted by default; the token column is. Transactions can always be re-pulled
  from Plaid.
- Redeploy after pulling changes: `fly deploy -a <app> --ha=false`, or rerun `npm run setup:hosted`.
