# plaid-finance-mcp

Give Claude read-only access to your bank, card and loan accounts, on your own terms.

- Pulls balances, transactions and liabilities through [Plaid](https://plaid.com) into a SQLite file you own.
- Exposes them to Claude as [MCP](https://modelcontextprotocol.io) tools, and exports a clean CSV.
- Read-only by construction: no payments, transfers or auth products are ever requested.

## Pick a mode

| | **Local** | **Hosted** |
|---|---|---|
| Your data lives | in a file on your computer | on a small [Fly.io](https://fly.io) machine you own |
| Use it from | Claude Code, on that computer | your phone, claude.ai, scheduled routines, Claude Code |
| Stays fresh | when you run `sync` | automatically, via Plaid webhooks |
| Setup time | 10 minutes | 15 more minutes |

Start with local. Add hosted when you want your data away from the computer.

## Before you start

- [ ] Comfortable in a terminal. This is a Node project, not an app.
- [ ] **Node 22+** and a C++ toolchain (`xcode-select --install` on macOS).
- [ ] A free [Plaid developer account](https://dashboard.plaid.com). Sandbox works instantly with fake banks; real banks need Production access, a short form that is often approved on the spot.
- [ ] For hosted mode: a free [Fly.io](https://fly.io) account and a claude.ai plan with custom connectors (Pro and up).

Not you? Claude's built-in [Personal Finance](https://support.claude.com/en/articles/18185620-use-personal-finance-in-claude) needs none of this. See [why both exist](#why-not-just-personal-finance).

## Local mode

```bash
git clone https://github.com/piotr-k/plaid-finance-mcp.git && cd plaid-finance-mcp
npm install
npm run setup
```

The wizard asks for your Plaid keys, builds, proves everything against sandbox banks, and prints a
`claude mcp add` command. Run it, open Claude Code, ask for your accounts.

Real banks, the by-hand path and details: **[docs/local.md](docs/local.md)**

## Hosted mode

```bash
brew install flyctl && fly auth login       # https://fly.io/docs/flyctl/install/
npm run setup:hosted
```

The wizard asks for an app name, region and passphrase, deploys, and prints a URL. Then:

- **claude.ai** (phone, desktop, web): Settings → Connectors → Add custom connector → paste the URL.
- **Claude Code:** `claude mcp add --scope user --transport http plaid-cloud <URL>`, then `/mcp`.

Link banks from any device: ask Claude for `start_link`, finish in the browser, then `link_status`.

Manual deploy, other MCP clients, migrating banks, operations: **[docs/hosted.md](docs/hosted.md)**

## Tools

| Tool | Returns |
|---|---|
| `list_accounts` | every linked account, cached balances, last sync |
| `sync` | new, changed and removed transactions from Plaid |
| `get_transactions` | a date range, optionally one account; money out is negative |
| `get_balances` | live balances from the banks (slow; use sparingly) |
| `get_liabilities` | statement balance, minimum due, due date, APRs, promo end |
| `export_csv` | `date,account,description,amount,pending` |
| `start_link`, `link_status` | connect or repair a bank (hosted) |

Arguments, CSV format, maintenance: **[docs/reference.md](docs/reference.md)**

## Why not just Personal Finance?

Claude's built-in Personal Finance (US beta) also links banks through Plaid and is excellent for
questions in chat. As of November 2026 it cannot export your data or run from Claude Code, scheduled
tasks or Cowork. This project does those: a CSV for your spreadsheet, tools for automations, a database
that is yours. Use Personal Finance for conversation and this for the plumbing, or either alone.

## Security and disclaimer

- Security model and how to report a vulnerability: **[SECURITY.md](SECURITY.md)**
- Not financial advice. Numbers can be wrong. Your data goes bank → Plaid → a machine you control, nowhere
  else. No warranty. Full text: **[docs/disclaimer.md](docs/disclaimer.md)**

## License

MIT. Contributions welcome; keep the read-only product list and the no-tokens-in-logs rule.
