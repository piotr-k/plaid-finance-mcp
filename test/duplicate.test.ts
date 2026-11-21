import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicate } from "../src/hosted-link.js";

const existing = [
  { item_id: "bank-login-a", masks: ["1234", "5678"] },
  { item_id: "bank-login-b", masks: [null, "9999"] },
];

test("same institution, different masks: not a duplicate", () => {
  assert.equal(findDuplicate(existing, ["4321", "8765"]), null);
});

test("one overlapping mask marks the duplicate and names the shared masks", () => {
  assert.deepEqual(findDuplicate(existing, ["0000", "5678"]), { item_id: "bank-login-a", masks: ["5678"] });
  assert.deepEqual(findDuplicate(existing, ["9999"]), { item_id: "bank-login-b", masks: ["9999"] });
});

test("missing masks never count as overlap", () => {
  assert.equal(findDuplicate(existing, [null, null]), null);
  assert.equal(findDuplicate([{ item_id: "x", masks: [null] }], [null]), null);
});

test("no existing items at the institution: not a duplicate", () => {
  assert.equal(findDuplicate([], ["1234"]), null);
});
