import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { renderFlyToml, appFromFlyToml } from "../scripts/setup-hosted.js";

const template = fs.readFileSync(new URL("../fly.example.toml", import.meta.url), "utf8");

test("renderFlyToml fills app, region, URL, display name and Plaid environment and leaves nothing unfilled", () => {
  const out = renderFlyToml(template, { app: "my-ledger", region: "ord", appName: 'Our "Money"', plaidEnv: "sandbox" });
  assert.match(out, /^app = "my-ledger"$/m);
  assert.match(out, /^primary_region = "ord"$/m);
  assert.match(out, /PUBLIC_URL = "https:\/\/my-ledger\.fly\.dev"/);
  assert.match(out, /APP_NAME = "Our Money"/);
  assert.match(out, /PLAID_ENV = "sandbox"/);
  assert.doesNotMatch(out, /<app>|<region>/);
  assert.match(out, /TOKEN_STORE = "db"/); // untouched lines survive
});

test("appFromFlyToml reads the name back and rejects the unfilled template", () => {
  assert.equal(appFromFlyToml(renderFlyToml(template, { app: "abc-1", region: "lhr", appName: "x", plaidEnv: "production" })), "abc-1");
  assert.equal(appFromFlyToml(template), null);
});
