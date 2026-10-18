// --deep: asks each provider which models the project's own keys can use, and
// reports every model ID in the code that isn't among them. Keys are read from
// the environment, then .env.local and .env, and are only ever sent to the
// provider they belong to.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { providerOf } from "./models.mjs";

const KEYS = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  google: ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
};

function envFiles(root) {
  const env = {};
  for (const f of [".env", ".env.local"]) {
    try {
      for (const line of readFileSync(join(root, f), "utf8").split("\n")) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
      }
    } catch {}
  }
  return env;
}

async function list(provider, key) {
  const t = AbortSignal.timeout(15000);
  if (provider === "openai") {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` }, signal: t });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).data.map((m) => m.id);
  }
  if (provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: t,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).data.map((m) => m.id);
  }
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`, { signal: t });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).models.map((m) => m.name.replace(/^models\//, ""));
}

// Anthropic lists dated IDs; an alias such as claude-sonnet-4-5 is available
// when a dated version of it is.
const available = (provider, id, ids) =>
  ids.has(id) || (provider === "anthropic" && [...ids].some((x) => x.startsWith(id + "-")));

export async function deepModels(root, models) {
  const env = { ...envFiles(root), ...process.env };
  const byProvider = {};
  for (const [id, where] of models) (byProvider[providerOf(id)] ||= []).push([id, where]);
  const results = [];
  for (const [provider, entries] of Object.entries(byProvider)) {
    const name = KEYS[provider].find((k) => env[k]);
    if (!name) { results.push({ provider, skipped: `no ${KEYS[provider][0]} found` }); continue; }
    try {
      const ids = new Set(await list(provider, env[name]));
      const missing = entries.filter(([id]) => !available(provider, id, ids));
      results.push({ provider, checked: entries.length, missing });
    } catch (e) {
      results.push({ provider, error: `${provider} rejected the model list request (${e.message}). Check ${name}.` });
    }
  }
  return results;
}
