import { execFileSync, spawnSync } from "node:child_process";
import { KEYCHAIN_SERVICE, PLAID_ENV } from "./config.js";

// Access tokens live in the macOS login Keychain, written and read through the
// built-in `security` CLI. The add command is fed over stdin (`security -i`)
// so the token never appears in a process argument list.

const SAFE = /^[A-Za-z0-9._:-]+$/;

function assertSafe(label: string, value: string): void {
  if (!SAFE.test(value)) throw new Error(`${label} contains unexpected characters; refusing to store`);
}

export function storeAccessToken(itemId: string, accessToken: string): void {
  assertSafe("item_id", itemId);
  assertSafe("access_token", accessToken);
  const cmd =
    `add-generic-password -a "${itemId}" -s "${KEYCHAIN_SERVICE}" ` +
    `-l "Plaid MCP (${PLAID_ENV}) ${itemId}" -j "Plaid access token, managed by plaid-finance-mcp" ` +
    `-w "${accessToken}" -U\n`;
  const res = spawnSync("security", ["-i"], { input: cmd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`Keychain write failed (exit ${res.status}): ${res.stderr?.trim() || "unknown error"}`);
  }
}

export function readAccessToken(itemId: string): string {
  assertSafe("item_id", itemId);
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-a", itemId, "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error(
      `No access token in Keychain for item ${itemId} (service ${KEYCHAIN_SERVICE}). Re-link it with: npm run link`,
    );
  }
}

export function hasAccessToken(itemId: string): boolean {
  try {
    readAccessToken(itemId);
    return true;
  } catch {
    return false;
  }
}

export function deleteAccessToken(itemId: string): void {
  assertSafe("item_id", itemId);
  spawnSync("security", ["delete-generic-password", "-a", itemId, "-s", KEYCHAIN_SERVICE], {
    stdio: "ignore",
  });
}
