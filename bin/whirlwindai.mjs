#!/usr/bin/env node
// npx whirlwindai [check] [dir] [--deep] [--json]
//
// Exit 0: clean. Exit 1: something to fix. Exit 2: warnings only.

import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { loadProject } from "../src/project.mjs";
import { CHECKS } from "../src/checks.mjs";
import { deepModels } from "../src/deep.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const args = process.argv.slice(2).filter((a) => a !== "check");
const flag = (f) => args.includes(f);

if (flag("--help") || flag("-h")) {
  console.log(`whirlwindai ${VERSION}

Checks a Next.js project for the mistakes that pass lint, types and the build:
open AI endpoints, retired models, unsigned Stripe webhooks, tables without
row level security, open redirects, committed keys and more.

Usage
  npx whirlwindai [dir]          check dir (default: current directory)
  npx whirlwindai --deep         also ask OpenAI, Anthropic and Google which
                                 models your keys can use (reads .env.local)
  npx whirlwindai --json         machine-readable output
  npx whirlwindai --list         list the checks

Silence one finding with a comment in the file:
  // whirlwind-check-ignore: <check-id> <reason>

Exit codes: 0 clean, 1 problems, 2 warnings only.`);
  process.exit(0);
}
if (flag("--version") || flag("-v")) { console.log(VERSION); process.exit(0); }
if (flag("--list")) {
  for (const c of CHECKS) console.log(`${c.id.padEnd(18)} ${c.group.padEnd(9)} ${c.title}`);
  process.exit(0);
}

const JSON_OUT = flag("--json");
const color = !JSON_OUT && process.stdout.isTTY && !flag("--no-color") && !process.env.NO_COLOR;
const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const [red, green, yellow, dim, bold, cyan] = [31, 32, 33, 2, 1, 36].map(c);

const dir = resolve(args.find((a) => !a.startsWith("-")) || ".");
if (!existsSync(dir)) { console.error(`No such directory: ${dir}`); process.exit(1); }
if (!existsSync(resolve(dir, "package.json"))) { console.error(`No package.json in ${dir}. Run this from your project's root.`); process.exit(1); }

const t0 = Date.now();
const p = loadProject(dir);
const ctx = {};
const results = CHECKS.map((check) => {
  let findings;
  try { findings = check.run(p, ctx); }
  catch (e) { findings = [{ level: "warn", file: "", msg: `check crashed: ${e.message}`, detail: "Please report it to hello@whirlwindai.xyz" }]; }
  return { id: check.id, group: check.group, title: check.title, findings };
});

let deep = null;
if (flag("--deep") && ctx.models?.size) deep = await deepModels(dir, ctx.models);

const all = results.flatMap((r) => r.findings);
const fails = all.filter((f) => f.level === "fail").length + (deep || []).reduce((n, d) => n + (d.missing?.length || 0), 0);
const warns = all.filter((f) => f.level === "warn").length + (deep || []).filter((d) => d.error).length;
const code = fails ? 1 : warns ? 2 : 0;

if (JSON_OUT) {
  console.log(JSON.stringify({ version: VERSION, project: p.pkg.name || basename(dir), stack: p.stack, apps: p.nestedApps, fails, warns, results, deep }, null, 2));
  process.exit(code);
}

console.log(`\n${bold("whirlwindai check")}  ${dim("·")}  ${p.pkg.name || basename(dir)}`);
if (p.stack.length) console.log(dim(p.stack.join(" · ")));
if (!p.isGit) console.log(yellow("Not a git repository: scanning every file, including ones .gitignore would skip."));
if (!p.deps.next && p.nestedApps.length)
  console.log(yellow(`This looks like a monorepo root. Check each app on its own:\n${p.nestedApps.map((a) => `  npx whirlwindai ${a}`).join("\n")}`));
else if (!p.deps.next) console.log(yellow("No Next.js dependency found. The general checks still apply; route-specific ones assume Next.js conventions."));

let group = "";
for (const r of results) {
  if (r.group !== group) { group = r.group; console.log(`\n${bold(group)}`); }
  if (!r.findings.length) console.log(`  ${green("✓")} ${r.title}`);
  else {
    const worst = r.findings.some((f) => f.level === "fail") ? red("✗") : yellow("!");
    console.log(`  ${worst} ${r.title}  ${dim(r.id)}`);
    for (const f of r.findings) {
      console.log(`      ${f.level === "fail" ? red("✗") : yellow("!")} ${cyan(f.file)} ${f.msg}`);
      if (f.detail) console.log(`        ${dim(f.detail)}`);
    }
  }
  if (r.id === "models" && deep) {
    for (const d of deep) {
      if (d.skipped) console.log(`      ${dim(`${d.provider}: skipped, ${d.skipped}`)}`);
      else if (d.error) console.log(`      ${yellow("!")} ${d.error}`);
      else if (!d.missing.length) console.log(`      ${green("✓")} ${d.provider}: all ${d.checked} model ID(s) available to your key`);
      else for (const [id, f] of d.missing) console.log(`      ${red("✗")} ${cyan(f)} uses ${id}, which your ${d.provider} key cannot use\n        ${dim("Requests to it fail. It may be retired, misspelled or not enabled for your account.")}`);
    }
  }
}
if (!flag("--deep") && ctx.models?.size) console.log(dim(`\n  ${ctx.models.size} model ID(s) found. Run with --deep to confirm your keys can use them.`));

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${"─".repeat(60)}`);
console.log(
  fails ? `${red(`${fails} problem(s)`)}, ${warns} warning(s)  ${dim(`· ${CHECKS.length} checks · ${secs}s`)}`
  : warns ? `${green("No problems")}, ${yellow(`${warns} warning(s)`)} to review  ${dim(`· ${CHECKS.length} checks · ${secs}s`)}`
  : `${green("All checks passed")}  ${dim(`· ${CHECKS.length} checks · ${secs}s`)}`,
);
console.log(dim(`
Whirlwind is a Next.js AI SaaS starter built for agent-driven development.
It ships with these covered, plus 33 audit checks and 27 browser tests your
agent runs on every change: https://whirlwindai.xyz
`));
process.exit(code);
