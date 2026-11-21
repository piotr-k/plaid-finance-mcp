import { test } from "node:test";
import assert from "node:assert/strict";
process.env.PLAID_ENV = "sandbox";
const { verifyPlaidWebhook, resetWebhookState } = await import("../src/webhooks.js");

const jwtWith = (header: object) => Buffer.from(JSON.stringify(header)).toString("base64url") + ".e30.sig";

test("webhook: empty or non-raw bodies are rejected before any key lookup", async () => {
  resetWebhookState();
  await assert.rejects(() => verifyPlaidWebhook({}, jwtWith({ alg: "ES256", kid: "k" })), /empty or non-raw/);
  await assert.rejects(() => verifyPlaidWebhook(Buffer.alloc(0), jwtWith({ alg: "ES256", kid: "k" })), /empty or non-raw/);
});

test("webhook: header must be ES256 with a well-formed kid", async () => {
  resetWebhookState();
  const body = Buffer.from("{}");
  await assert.rejects(() => verifyPlaidWebhook(body, undefined), /missing/);
  await assert.rejects(() => verifyPlaidWebhook(body, jwtWith({ alg: "HS256", kid: "k" })), /unexpected JWT header/);
  await assert.rejects(() => verifyPlaidWebhook(body, jwtWith({ alg: "ES256", kid: "../x" })), /unexpected JWT header/);
  await assert.rejects(() => verifyPlaidWebhook(body, jwtWith({ alg: "ES256" })), /unexpected JWT header/);
  await assert.rejects(() => verifyPlaidWebhook(body, "x".repeat(5000)), /oversized/);
});
