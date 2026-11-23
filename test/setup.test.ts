import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeEnv, parseEnv } from "../scripts/setup.js";

test("mergeEnv replaces existing keys in place, uncomment-and-sets commented ones, appends new ones", () => {
  const before = "# Plaid keys\nPLAID_CLIENT_ID=\nPLAID_SECRET_SANDBOX=old\n# PLAID_SECRET_PRODUCTION=\nPLAID_ENV=sandbox\n";
  const after = mergeEnv(before, { PLAID_CLIENT_ID: "abc", PLAID_SECRET_PRODUCTION: "prod", TRANSACTION_DAYS: "365" });
  assert.equal(
    after,
    "# Plaid keys\nPLAID_CLIENT_ID=abc\nPLAID_SECRET_SANDBOX=old\nPLAID_SECRET_PRODUCTION=prod\nPLAID_ENV=sandbox\nTRANSACTION_DAYS=365\n",
  );
});

test("mergeEnv only touches the first occurrence and leaves unrelated comments alone", () => {
  const before = "A=1\n# note: A=should stay\nA=2\n";
  assert.equal(mergeEnv(before, { A: "x" }), "A=x\n# note: A=should stay\nA=2\n");
});

test("parseEnv ignores comments, blanks and surrounding quotes", () => {
  assert.deepEqual(parseEnv('# c\n\nA=1\nB="two"\n# C=3\nD = four \n'), { A: "1", B: "two", D: "four" });
});

test("freeServerName avoids a plaid-finance entry that points at another checkout", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { freeServerName } = await import("../scripts/setup.js");
  const home = mkdtempSync(path.join(tmpdir(), "home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(freeServerName("/a/dist/server.js"), "plaid-finance"); // no config at all
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { "plaid-finance": { args: ["/elsewhere/dist/server.js"] } } }));
    assert.equal(freeServerName("/a/dist/server.js"), "plaid-finance-2");
    assert.equal(freeServerName("/elsewhere/dist/server.js"), "plaid-finance"); // same checkout: reuse the name
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { "plaid-finance": { args: ["/x"] }, "plaid-finance-2": { args: ["/y"] } } }));
    assert.equal(freeServerName("/a/dist/server.js"), "plaid-finance-3");
  } finally {
    process.env.HOME = saved;
  }
});
