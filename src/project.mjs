// Reads a project once: which files exist, which are tracked by git, their
// contents (with comments stripped for pattern checks), import aliases and
// the stack it uses. Every check works from this, never from the disk.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { execFileSync } from "node:child_process";

const SKIP_DIRS = /(^|\/)(node_modules|\.next|\.git|\.vercel|\.turbo|dist|build|out|coverage|venv|\.venv|__pycache__|vendor)(\/|$)/;
export const SOURCE = /\.(m|c)?[jt]sx?$/;
const RESOLVE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".scss", ".sass", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".md", ".mdx"];

// A small JavaScript tokenizer: enough to tell code from comments, strings,
// template literals and regex literals, which regexes over raw text cannot.
// Returns the code with comments removed, and a second copy with template
// literal contents blanked too (docs pages keep code samples in them).
// Newlines are kept everywhere so line-based patterns still line up.
export function lex(src) {
  let code = "", bare = "", i = 0, prev = "";
  const n = src.length;
  const keep = (s, inTemplate) => { code += s; bare += inTemplate ? s.replace(/[^\n]/g, " ") : s; };
  const regexAllowed = () => /[(,=:[!&|?{};+\-*%<>~^]$|^$/.test(prev) || /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(code.slice(-16).trimEnd());
  const templateDepth = [];
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (templateDepth.length && c === "}" && templateDepth[templateDepth.length - 1] === 0) {
      templateDepth.pop(); keep("}", true); i++; i = template(i); continue;
    }
    if (c === "/" && d === "/") { const e = src.indexOf("\n", i); i = e < 0 ? n : e; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; keep(src.slice(i, end).replace(/[^\n]/g, ""), false); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      keep(src.slice(i, j + 1), false); i = j + 1; prev = c; continue;
    }
    if (c === "`") { keep("`", false); i = template(i + 1); prev = "`"; continue; }
    if (c === "/" && regexAllowed()) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      if (src[j] === "/") { while (/[a-z]/i.test(src[j + 1] || "")) j++; keep(src.slice(i, j + 1), false); i = j + 1; prev = "/x"; continue; }
    }
    if (templateDepth.length) { if (c === "{") templateDepth[templateDepth.length - 1]++; else if (c === "}") templateDepth[templateDepth.length - 1]--; }
    keep(c, false);
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code, bare };

  // Reads template text from i to the closing backtick or the next "${".
  function template(i) {
    let j = i;
    while (j < n) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === "`") { keep(src.slice(i, j), true); keep("`", false); return j + 1; }
      if (src[j] === "$" && src[j + 1] === "{") { keep(src.slice(i, j), true); keep("${", false); templateDepth.push(0); return j + 2; }
      j++;
    }
    keep(src.slice(i), true);
    return n;
  }
}

export const stripComments = (t) => lex(t).code;

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 })
      .split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

function walk(root, dir = "", out = []) {
  for (const e of readdirSync(join(root, dir))) {
    const rel = dir ? `${dir}/${e}` : e;
    if (SKIP_DIRS.test(rel)) continue;
    const st = statSync(join(root, rel));
    st.isDirectory() ? walk(root, rel, out) : out.push(rel);
  }
  return out;
}

// tsconfig/jsconfig allow comments and trailing commas.
function readJsonc(p) {
  try {
    const t = readFileSync(p, "utf8")
      .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/.*$/gm, (m, s) => s || "")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export function loadProject(root) {
  const listed = git(root, ["ls-files", "-co", "--exclude-standard"]);
  const files = (listed || walk(root)).filter((f) => !SKIP_DIRS.test(f) && existsSync(join(root, f)));
  const tracked = new Set(git(root, ["ls-files"]) || []);
  const fileSet = new Set(files);

  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) {
      let t = "";
      try {
        const p = join(root, rel);
        if (statSync(p).size < 1_000_000) t = readFileSync(p, "utf8");
      } catch {}
      cache.set(rel, t);
    }
    return cache.get(rel);
  };
  const lexCache = new Map();
  const lexed = (rel) => {
    if (!lexCache.has(rel)) lexCache.set(rel, SOURCE.test(rel) ? lex(read(rel)) : { code: read(rel), bare: read(rel) });
    return lexCache.get(rel);
  };
  // code: comments removed. bare: template literal contents blanked as well.
  const code = (rel) => lexed(rel).code;
  const bare = (rel) => lexed(rel).bare;

  const pkg = (() => { try { return JSON.parse(read("package.json")); } catch { return {}; } })();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // Import aliases from compilerOptions.paths, e.g. "@/*": ["./src/*"].
  const aliases = [];
  for (const cfg of ["tsconfig.json", "jsconfig.json"]) {
    const j = readJsonc(join(root, cfg));
    const co = j?.compilerOptions;
    if (!co?.paths) continue;
    const base = co.baseUrl || ".";
    for (const [k, targets] of Object.entries(co.paths)) {
      aliases.push({
        prefix: k.replace(/\*$/, ""),
        wildcard: k.endsWith("*"),
        targets: targets.map((t) => posix.normalize(posix.join(base, t)).replace(/\*$/, "")),
      });
    }
  }

  // App code only: build scripts, tests, scaffolds and examples contain
  // deliberate mistakes, code samples and placeholders.
  const TOOLING = /^(scripts|tools|tests?|e2e|cypress|playwright)\/|(^|\/)(\.[^/]+|__tests__|__mocks__|fixtures|__fixtures__|templates?|scaffolds?|examples?)\/|\.(test|spec|stories)\.[jt]sx?$/;
  const source = files.filter((f) => SOURCE.test(f) && !f.endsWith(".d.ts") && !TOOLING.test(f));
  const appDir = ["app", "src/app"].find((d) => files.some((f) => f.startsWith(d + "/")));
  const pagesDir = ["pages", "src/pages"].find((d) => files.some((f) => f.startsWith(d + "/")));

  // Everything a request from the internet can reach directly.
  const endpoints = source.filter(
    (f) =>
      (appDir && f.startsWith(appDir + "/") && /\/route\.(m?[jt]s)$/.test(f)) ||
      (pagesDir && f.startsWith(pagesDir + "/api/")) ||
      /^\s*["']use server["']/m.test(read(f)),
  );

  // Resolve a relative or aliased import to a file in the project. Returns
  // undefined for bare package names, null when it should resolve and doesn't.
  const resolve = (from, spec) => {
    spec = spec.split("?")[0];
    let bases;
    if (spec.startsWith(".")) bases = [posix.normalize(posix.join(dirname(from), spec))];
    else {
      const a = aliases.find((a) => (a.wildcard ? spec.startsWith(a.prefix) : spec === a.prefix));
      if (!a) return undefined;
      const rest = a.wildcard ? spec.slice(a.prefix.length) : "";
      bases = a.targets.map((t) => posix.normalize(posix.join(t, rest)));
    }
    for (const b of bases) {
      const tries = [b, ...RESOLVE_EXT.map((e) => b + e), ...RESOLVE_EXT.map((e) => `${b}/index${e}`)];
      // TypeScript ESM style: "./x.js" written for x.ts
      if (/\.(m|c)?js$/.test(b)) tries.push(b.replace(/\.(m|c)?js$/, ".ts"), b.replace(/\.(m|c)?js$/, ".tsx"));
      const hit = tries.find((t) => fileSet.has(t) || (existsSync(join(root, t)) && statSync(join(root, t)).isFile()));
      if (hit) return hit;
    }
    return null;
  };

  const importsOf = (rel) => {
    const out = [];
    // Static imports must start a line, so an import inside a string
    // ('import x from "y"') or a code sample is not read as one.
    const t = bare(rel);
    for (const m of t.matchAll(/^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"'\n]+)["']|^\s*import\s*["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)|\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/gm))
      out.push(m[1] || m[2] || m[3] || m[4]);
    return out;
  };

  // The file plus the project files it imports, to a small depth, so a route
  // that calls a model through lib/ai.ts is still seen to call one.
  const withLocalImports = (rel, depth = 2) => {
    const seen = new Set([rel]);
    let frontier = [rel];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const f of frontier)
        for (const s of importsOf(f)) {
          const r = resolve(f, s);
          if (r && SOURCE.test(r) && !seen.has(r)) { seen.add(r); next.push(r); }
        }
      frontier = next;
    }
    return [...seen];
  };

  const ignored = (rel, id) => new RegExp(`whirlwind-check-ignore[:\\s][^\\n]*\\b${id}\\b`).test(read(rel));

  const stack = [];
  if (deps.next) stack.push(`Next.js ${String(deps.next).replace(/^[^\d]*/, "").split(".").slice(0, 2).join(".")}${appDir ? " (App Router)" : pagesDir ? " (Pages Router)" : ""}`);
  if (deps["@supabase/supabase-js"] || deps["@supabase/ssr"]) stack.push("Supabase");
  if (deps.stripe) stack.push("Stripe");
  const ai = [
    deps.openai && "OpenAI",
    deps["@anthropic-ai/sdk"] && "Anthropic",
    (deps["@google/generative-ai"] || deps["@google/genai"]) && "Gemini",
    deps.ai && "AI SDK",
  ].filter(Boolean);
  if (ai.length) stack.push(ai.join(", "));

  return {
    root, files, tracked, read, code, bare, has: (rel) => fileSet.has(rel), pkg, deps, source,
    appDir, pagesDir, endpoints, resolve, importsOf, withLocalImports, ignored, stack,
    isGit: listed !== null,
  };
}
