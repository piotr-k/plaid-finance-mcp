/**
 * Guided first-time setup: `npm run setup`
 *
 *   1. checks Node and the native SQLite module
 *   2. creates .env from .env.example if needed and asks for the Plaid keys
 *      (typed input is hidden; nothing is ever printed back)
 *   3. builds, then runs the sandbox smoke test against Plaid's fake banks
 *   4. prints the exact `claude mcp add` command for this machine
 *
 * Safe to re-run: existing values in .env are kept unless you choose to replace them.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const EXAMPLE_PATH = path.join(ROOT, ".env.example");

export const say = (s = "") => console.log(s);
export const ok = (s: string) => say(`  ✔ ${s}`);
export const warn = (s: string) => say(`  ! ${s}`);
export const fail = (s: string): never => {
  say(`\n  ✖ ${s}\n`);
  process.exit(1);
};

/** Return `existing` with each key in `updates` set (replacing an existing line or appending). Pure, for tests. */
export function mergeEnv(existing: string, updates: Record<string, string>): string {
  const lines = existing.split("\n");
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^\s*#?\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!m) return line;
    const key = m[1]!;
    if (!(key in updates) || seen.has(key)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  while (out.length && out[out.length - 1]!.trim() === "") out.pop(); // append new keys right after the last real line
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) out.push(`${k}=${v}`);
  return out.join("\n") + "\n";
}

/** Parse KEY=value lines (ignores comments and blanks). Pure, for tests. */
export function parseEnv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) vars[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return vars;
}

export function ask(question: string, { hidden = false } = {}): Promise<string> {
  if (hidden) return askHidden(question);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Read a line without echoing it. Readline cannot do this cleanly (it redraws the prompt through
 * the muted stream), so this reads raw keystrokes: Enter finishes, Backspace edits, Ctrl-C aborts.
 */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const done = (value: string) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(buf);
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export function run(label: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): boolean {
  say(`\n  → ${label}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  return r.status === 0;
}

/**
 * Create .env if needed and ask for the Plaid keys. `need` says which secret is mandatory:
 * the local wizard needs sandbox (it runs the smoke test); the hosted wizard needs whichever
 * environment it is about to deploy. Existing values are kept unless the user chooses to replace them.
 */
export async function collectPlaidKeys(need: "sandbox" | "production"): Promise<Record<string, string>> {
  if (!fs.existsSync(ENV_PATH)) {
    fs.copyFileSync(EXAMPLE_PATH, ENV_PATH);
    fs.chmodSync(ENV_PATH, 0o600);
    ok("created .env from .env.example");
  } else {
    ok(".env exists");
  }
  const current = parseEnv(fs.readFileSync(ENV_PATH, "utf8"));
  const updates: Record<string, string> = {};

  say("\n  Plaid keys live at https://dashboard.plaid.com/developers/keys");
  say("  Paste them here; secrets are hidden as you type and only written to .env (which git ignores).\n");

  const want = async (key: string, prompt: string, { hidden, optional = false, check, alias }: { hidden: boolean; optional?: boolean; check?: (v: string) => string | null; alias?: string }) => {
    const existing = current[key] ? key : alias && current[alias] ? alias : null;
    if (existing) {
      const r = (await ask(`  ${existing} is already set. Replace it? [y/N] `)).toLowerCase();
      if (r !== "y") return;
    }
    for (;;) {
      const v = await ask(`  ${prompt}${optional ? " (Enter to skip)" : ""}: `, { hidden });
      if (!v && optional) return;
      if (!v) continue;
      const problem = check?.(v);
      if (problem) {
        warn(problem);
        continue;
      }
      updates[key] = v;
      return;
    }
  };
  const secretCheck = (v: string) => (/^[a-f0-9]{30}$/i.test(v) ? null : "That does not look like a Plaid secret (30 hex characters). Try again.");
  await want("PLAID_CLIENT_ID", "client_id", { hidden: false, check: (v) => (/^[a-f0-9]{24}$/i.test(v) ? null : "That does not look like a Plaid client_id (24 hex characters). Try again.") });
  await want("PLAID_SECRET_SANDBOX", "sandbox secret", { hidden: true, optional: need !== "sandbox", check: secretCheck });
  await want("PLAID_SECRET_PRODUCTION", "production secret" + (need === "production" ? "" : ", if you have production access"), { hidden: true, optional: need !== "production", alias: "PLAID_SECRET", check: secretCheck });
  if (!current.PLAID_ENV) updates.PLAID_ENV = "sandbox";

  if (Object.keys(updates).length) {
    fs.writeFileSync(ENV_PATH, mergeEnv(fs.readFileSync(ENV_PATH, "utf8"), updates), { mode: 0o600 });
    ok(`wrote ${Object.keys(updates).join(", ")} to .env`);
  }
  return parseEnv(fs.readFileSync(ENV_PATH, "utf8"));
}

async function main() {
  say("\nplaid-finance-mcp setup\n");

  // 1. Environment
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) fail(`Node ${process.versions.node} found; Node 22 or newer is required (https://nodejs.org).`);
  ok(`Node ${process.versions.node}`);
  try {
    await import("better-sqlite3");
    ok("native SQLite module loads");
  } catch {
    fail(
      "better-sqlite3 did not build. Install a C++ toolchain, then run `npm install` again:\n" +
        "    macOS:  xcode-select --install\n" +
        "    Debian/Ubuntu:  sudo apt-get install -y build-essential python3",
    );
  }
  if (!process.stdin.isTTY) fail("Run this in an interactive terminal (it needs to ask for your Plaid keys).");

  // 2. .env and keys
  await collectPlaidKeys("sandbox");

  // 3. Build and prove it works against Plaid's sandbox
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  if (!run("building", npm, ["run", "-s", "build"])) fail("build failed; see the errors above.");
  if (!run("running the sandbox smoke test (links two fake banks and calls every tool)", npm, ["run", "-s", "smoke"], { PLAID_ENV: "sandbox" })) {
    fail(
      "the sandbox test failed. Most common causes:\n" +
        "    - a mistyped key: rerun `npm run setup` and choose to replace it\n" +
        "    - no network access to plaid.com",
    );
  }

  // 4. What to do next
  const nodeBin = process.execPath;
  const serverJs = path.join(ROOT, "dist", "server.js");
  say(`
  All good. Register the server with Claude Code by running:

    claude mcp add --scope user --transport stdio plaid-finance -- "${nodeBin}" "${serverJs}"

  Then open Claude Code and ask: "list my accounts". You are in sandbox mode with fake banks.

  To connect real banks you need Plaid production access (Dashboard → Settings → Team → Products).
  When you have it, set PLAID_ENV=production in .env and run:  npm run link
  Hosted mode (phone access, automatic sync) is described in README.md under "Hosted mode".
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}
