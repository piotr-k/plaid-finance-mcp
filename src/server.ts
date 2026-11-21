#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PLAID_ENV, log } from "./config.js";
import { openDb } from "./db.js";
import { buildServer } from "./tools.js";

// Local stdio MCP server (launched by Claude Code). All logging goes to stderr.
async function main() {
  const db = openDb();
  const server = buildServer(db, { hosted: false });
  await server.connect(new StdioServerTransport());
  log(`plaid-finance MCP server ready (${PLAID_ENV})`);
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
