# plaid-finance-mcp

A small, read-only [MCP](https://modelcontextprotocol.io) server that gives Claude your bank, card and
loan data through [Plaid](https://plaid.com). It keeps balances, transactions and liabilities in a
SQLite file you own and exports a clean CSV for budget reconciliation.

Read-only by construction: Link, `/accounts/get`, `/accounts/balance/get`, `/transactions/sync`,
`/liabilities/get`, `/institutions/get_by_id`. No auth, payments or transfer products are requested.

## Two ways to run it

The difference is where the database lives and where you are when you use it.

| | **Local** | **Hosted** |
|---|---|---|
| Database | A file on your computer | A small [Fly.io](https://fly.io) machine you own |
| Runs | Only while Claude Code uses it, on that computer | Always on, behind a passphrase |
| Use it from | Claude Code on that computer | Claude on your phone, claude.ai, scheduled routines, and Claude Code |
| Fresh data | When you run `sync` | Plaid webhooks push updates while your laptop is closed |
| Tokens | macOS Keychain (encrypted in the database on Linux) | Encrypted in the database |
| Network | Nothing listens | One HTTPS port, OAuth 2.1 |

**Stand up local mode** (about ten minutes):

1. `git clone` this repo, `npm install`, `npm run setup`. The wizard asks for your Plaid keys, builds,
   and proves everything against Plaid's sandbox banks.
2. Run the `claude mcp add` command the wizard prints.
3. Ask Claude Code to list your accounts.

**Stand up hosted mode** (local mode first, then about fifteen more minutes):

1. Install the Fly CLI and `fly auth login`.
2. `npm run setup:hosted`. The wizard asks for an app name, region and passphrase, creates the app,
   sets the secrets, deploys, and prints a URL.
3. Add that URL as a custom connector in claude.ai, or with `claude mcp add` in Claude Code, and sign in
   with the passphrase.

Details for each: [docs/local.md](docs/local.md) and [docs/hosted.md](docs/hosted.md).

## Who this is for

You need to be comfortable in a terminal: installing Node, running npm, editing a `.env` file. You also
need a [Plaid developer account](https://dashboard.plaid.com). Sandbox works immediately with fake banks;
connecting real banks requires Plaid's production access, a short form in the dashboard that is often
approved on the spot. If that is not you, Claude's built-in Personal Finance (below) gives you the
conversation part with no setup at all. If it is, `npm run setup` walks you through the rest.

### Why not Anthropic's Personal Finance?

Claude's built-in [Personal Finance](https://support.claude.com/en/articles/18185620-use-personal-finance-in-claude)
(US beta, Pro and above) also links banks through Plaid and is excellent for questions in chat. This project
was built the same month without knowing it existed, and the two turn out to be complementary. As of
November 2026, Personal Finance cannot export your data and cannot be used from Claude Code, scheduled
tasks or Cowork. This project covers those: a CSV you can drop into a spreadsheet, tools callable from
automations, and a database on disk that is yours. Use Personal Finance for conversation and this for
the plumbing, or either one alone.

## Prerequisites

- **Node 22 or newer** and a C++ toolchain (Xcode Command Line Tools on macOS, `build-essential` on
  Debian/Ubuntu). `better-sqlite3` compiles a native module on install.
- **A Plaid developer account** at <https://dashboard.plaid.com>. Sandbox is free and works immediately
  with fake banks. Real banks need **Production** access, which Plaid grants per developer after a short
  form in the dashboard; personal use is allowed, and approval is often immediate (this project's author
  had it within minutes), though some accounts get a manual review. Expect a separate registration step
  for some OAuth banks. Plaid bills per linked bank per month once you are in production; a
  household is a few dollars.
- **Claude Code** for local mode. For hosted mode, a claude.ai plan that allows custom connectors (Pro,
  Max, Team or Enterprise at the time of writing), and a free [Fly.io](https://fly.io) account. The default
  machine size fits inside Fly's free monthly allowance.
- Local mode assumes **macOS** for the Keychain. On Linux set `TOKEN_STORE=db` and `TOKEN_ENCRYPTION_KEY`
  in `.env` and tokens are stored encrypted in SQLite instead.

## Local mode

```bash
git clone https://github.com/piotr-k/plaid-finance-mcp.git && cd plaid-finance-mcp
npm install
npm run setup
```

The setup wizard checks your toolchain, asks for your Plaid keys with hidden input and writes them to
`.env` (git-ignored), builds, proves everything against Plaid's sandbox banks, and prints the exact
`claude mcp add` command for your machine. Run that command, open Claude Code, and ask it to list your
accounts.

Linking real banks, the by-hand path, and the details are in **[docs/local.md](docs/local.md)**.

## Hosted mode (Fly.io)

```bash
brew install flyctl && fly auth login            # or https://fly.io/docs/flyctl/install/
npm run setup:hosted
```

The hosted wizard asks for an app name, region and display name, writes `fly.toml`, creates the app and
its volume, generates the token encryption key, asks for your passphrase with hidden input, sets every
secret without going through a shell, deploys, waits for the health check and prints the URLs to paste
into claude.ai and Claude Code. Rerun it to redeploy; it reuses what exists.

Then connect:

- **claude.ai** (web, desktop, phone): Settings → Connectors → Add custom connector → URL
  `https://<app>.fly.dev/mcp`. Sign in with your passphrase. Scheduled routines can use the same connector.
- **Claude Code:** `claude mcp add --scope user --transport http plaid-cloud https://<app>.fly.dev/mcp`,
  then `/mcp` → authenticate.

Link banks from any device by asking for `start_link`, finishing in the browser, then `link_status`.

Everything else about hosted mode, including what changes from local mode, the manual deploy steps, other
MCP clients, moving banks you already linked on the laptop, and day-to-day operation, is in
**[docs/hosted.md](docs/hosted.md)**.

## Tools

| Tool | What it returns |
|------|-----------------|
| `list_accounts` | every linked account with cached balances and last sync time |
| `sync` | pulls new, changed and removed transactions from Plaid |
| `get_transactions` | transactions for a date range, optionally one account; money out is negative |
| `get_balances` | live balances from the banks (slow, rate-limited; use sparingly) |
| `get_liabilities` | statement balance and date, minimum due, due date, APRs, promo end |
| `export_csv` | `date,account,description,amount,pending` for a date range |
| `start_link`, `link_status` (hosted) | connect or repair a bank from any device |

Arguments, the CSV format, maintenance commands and customization are in
**[docs/reference.md](docs/reference.md)**.

## Security, data and disclaimer

The security model, and how to report a vulnerability, are in **[SECURITY.md](SECURITY.md)**.

This is not financial advice, the numbers can be wrong, your data goes from your bank to Plaid to a
machine you control and nowhere else, you are the operator, and there is no warranty. The full text is in
**[docs/disclaimer.md](docs/disclaimer.md)**; read it before linking a real bank.

## License

MIT. Contributions are welcome; please keep the read-only product list and the no-tokens-in-logs rule.
