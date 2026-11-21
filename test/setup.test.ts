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
