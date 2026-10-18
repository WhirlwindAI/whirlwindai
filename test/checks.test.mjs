// Builds a small Next.js project with one instance of every mistake, and a
// clean twin, in a temp directory, then runs the CLI on both. Fixtures are
// written at runtime so this repo never contains anything shaped like a key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lex } from "../src/project.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "whirlwindai.mjs");

function project(files, { commit } = {}) {
  const root = mkdtempSync(join(tmpdir(), "whirlwindai-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  if (commit) {
    const g = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
    g("init", "-q"); g("add", "-A"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture");
  }
  return root;
}

function run(root) {
  const r = spawnSync(process.execPath, [CLI, root, "--json"], { encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  const ids = new Map(out.results.map((x) => [x.id, x.findings]));
  return { code: r.status, out, ids };
}

const PKG = JSON.stringify({ name: "acme", dependencies: { next: "14.2.0", openai: "4.0.0", stripe: "15.0.0", "@supabase/supabase-js": "2.0.0" } });
const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } });
const FAKE_KEY = ["sk", "proj", "x".repeat(40)].join("-");

const BAD = {
  "package.json": PKG,
  "tsconfig.json": TSCONFIG,
  ".env": `OPENAI_API_KEY=${FAKE_KEY}\n`,
  ".env.example": "NEXT_PUBLIC_SUPABASE_URL=\n",
  "next.config.js": 'module.exports = { images: { remotePatterns: [{ protocol: "https", hostname: "**" }] } };\n',
  "lib/ai.ts": 'import OpenAI from "openai";\nconst openai = new OpenAI();\nexport const summarize = (t: string) => openai.chat.completions.create({ model: "gpt-4-32k", messages: [{ role: "user", content: t }] });\n',
  "app/api/summarize/route.ts": 'import { summarize } from "@/lib/ai";\nexport async function POST(req: Request) {\n  const { text } = await req.json();\n  return Response.json(await summarize(text));\n}\n',
  "app/api/chat/route.ts": 'import Anthropic from "@anthropic-ai/sdk";\nimport { getUser } from "@/lib/auth";\nconst a = new Anthropic();\nexport async function POST() {\n  const user = await getUser();\n  return Response.json(await a.messages.create({ model: "claude-3-5-sonnet-20241022", max_tokens: 10, messages: [] }));\n}\n',
  "lib/auth.ts": "export async function getUser() { return null; }\n",
  "app/api/webhook/stripe/route.ts": 'import Stripe from "stripe";\nexport async function POST(req: Request) {\n  const event = await req.json();\n  if (event.type === "checkout.session.completed") {}\n  return Response.json({});\n}\n',
  "app/api/checkout/route.ts": 'import Stripe from "stripe";\nimport { headers } from "next/headers";\nconst stripe = new Stripe("");\nexport async function POST(req: Request) {\n  const body = await req.json();\n  const origin = headers().get("origin") || process.env.NEXT_PUBLIC_APP_URL;\n  const s = await stripe.checkout.sessions.create({ line_items: [{ price_data: { unit_amount: body.amount } }], success_url: `${origin}/ok`, cancel_url: `${origin}/` });\n  return Response.json({ url: s.url });\n}\n',
  "app/auth/confirm/route.ts": 'import { NextResponse } from "next/server";\nexport function GET(req: Request) {\n  const url = new URL(req.url);\n  const next = url.searchParams.get("next") || "/";\n  return NextResponse.redirect(new URL(next, req.url));\n}\n',
  "middleware.ts": 'import { createServerClient } from "@supabase/ssr";\nexport async function middleware() {\n  const { data } = await supabase.auth.getSession();\n}\nexport const config = { matcher: ["/dashboard/:path*"] };\n',
  "app/settings/page.tsx": '"use client";\nimport { Panel } from "@/components/Panel";\nexport default function S() { return <p>{process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY}</p>; }\n',
  "app/posts/[id]/page.tsx": 'import { posts } from "@/lib/posts";\nexport default function P({ params }) {\n  const post = posts.find((p) => p.id === params.id);\n  return <h1>{post.title}</h1>;\n}\n',
  "lib/posts.ts": 'export const posts = [{ id: "1", title: "Hi" }];\nexport const url = (p) => process.env.SITE_URL + "/posts" || "/";\n',
  "lib/db.ts": 'export const notes = (s) => s.from("notes").select();\nexport const bucket = (s) => s.storage.from("avatars");\n',
  "supabase/migrations/001_init.sql": "create table public.profiles (id uuid primary key);\ncreate table public.credits (id uuid primary key);\nalter table public.credits enable row level security;\ncreate policy \"anyone\" on public.credits for update using (true);\ncreate or replace function public.add_credits(n int) returns void language sql security definer as $$ update credits set n = n $$;\n",
  "lib/leak.ts": `export const k = "${FAKE_KEY}";\n`,
  // A code sample in a docs page: must not be read as a real import.
  "app/docs/page.tsx": 'const sample = `\n// \\`charge()\\` first\nimport { x } from "@/lib/missing";\n`;\nexport default function D() { return <pre>{sample}</pre>; }\n',
};

test("every check fires on the broken project", () => {
  const { code, ids } = run(project(BAD, { commit: true }));
  assert.equal(code, 1);
  const expect = {
    "secrets-tracked": /\.env is committed/,
    "secrets-hardcoded": /lib\/leak\.ts/,
    "secrets-public": /SERVICE_ROLE/,
    "ai-auth": /app\/api\/summarize\/route\.ts calls a model \(OpenAI\) with no sign-in check/,
    "ai-limit": /app\/api\/chat\/route\.ts/,
    models: /gpt-4-32k[\s\S]*claude-3-5-sonnet-20241022|claude-3-5-sonnet-20241022[\s\S]*gpt-4-32k/,
    "stripe-webhook": /without verifying the signature/,
    "stripe-price": /takes the amount from the request/,
    "stripe-redirect": /prefers the request's Origin header/,
    "open-redirect": /"next" query parameter/,
    "supabase-session": /getSession/,
    "supabase-rls": /profiles without row level security[\s\S]*allows any write/,
    "supabase-rpc": /add_credits\(\)/,
    "supabase-tables": /queries table notes/,
    imports: /@\/components\/Panel/,
    precedence: /lib\/posts\.ts/,
    "not-found": /app\/posts\/\[id\]\/page\.tsx/,
    "error-pages": /app\/error/,
    "image-proxy": /hostname "\*\*"/,
    "env-example": /SITE_URL/,
  };
  for (const [id, re] of Object.entries(expect)) {
    const text = (ids.get(id) || []).map((f) => `${f.file} ${f.msg} ${f.detail || ""}`).join("\n");
    assert.match(text, re, `${id} should fire`);
  }
  // Not false positives: the docs sample, the storage bucket, the checked chat route.
  const all = JSON.stringify([...ids.values()]);
  assert.doesNotMatch(all, /lib\/missing/);
  assert.doesNotMatch(all, /table avatars/);
  assert.doesNotMatch(JSON.stringify(ids.get("ai-auth")), /chat/);
});

test("a clean project passes", () => {
  const root = project({
    "package.json": PKG,
    "tsconfig.json": TSCONFIG,
    ".env.example": "OPENAI_API_KEY=\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\nNEXT_PUBLIC_APP_URL=\n",
    "next.config.js": 'module.exports = { images: { remotePatterns: [{ protocol: "https", hostname: "images.example.com" }] } };\n',
    "app/error.tsx": '"use client";\nexport default function E() { return null; }\n',
    "app/not-found.tsx": "export default function N() { return null; }\n",
    "lib/limit.ts": "export async function rateLimit(id: string) { return true; }\n",
    "lib/auth.ts": "export async function getUser() { return { id: 1 }; }\n",
    "app/api/summarize/route.ts": 'import OpenAI from "openai";\nimport { getUser } from "@/lib/auth";\nimport { rateLimit } from "@/lib/limit";\nconst openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });\nexport async function POST(req: Request) {\n  const user = await getUser();\n  if (!user || !(await rateLimit(String(user.id)))) return new Response(null, { status: 401 });\n  return Response.json(await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [] }));\n}\n',
    "app/api/webhook/stripe/route.ts": 'import Stripe from "stripe";\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\nexport async function POST(req: Request) {\n  const body = await req.text();\n  const event = stripe.webhooks.constructEvent(body, req.headers.get("stripe-signature")!, process.env.STRIPE_WEBHOOK_SECRET!);\n  return Response.json({ ok: true });\n}\n',
    "app/auth/confirm/route.ts": 'import { NextResponse } from "next/server";\nexport function GET(req: Request) {\n  const raw = new URL(req.url).searchParams.get("next") || "/";\n  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";\n  return NextResponse.redirect(new URL(next, process.env.NEXT_PUBLIC_APP_URL));\n}\n',
    "supabase/migrations/001_init.sql": "create table public.notes (id uuid primary key);\nalter table public.notes enable row level security;\ncreate or replace function public.spend(n int) returns void language sql security definer as $$ select 1 $$;\nrevoke execute on function public.spend(int) from public, anon, authenticated;\n",
    "lib/db.ts": 'export const notes = (s) => s.from("notes").select();\n',
  });
  const { code, ids } = run(root);
  const found = [...ids].filter(([, f]) => f.length).map(([id, f]) => `${id}: ${f.map((x) => x.file + " " + x.msg).join("; ")}`);
  assert.deepEqual(found, []);
  assert.equal(code, 0);
});

test("other stacks: LangChain, Bedrock, tRPC, webhooks, Firebase, raw SQL", () => {
  const { ids } = run(project({
    "package.json": JSON.stringify({ name: "x", dependencies: { next: "16.0.0", "@langchain/openai": "1", "@aws-sdk/client-bedrock-runtime": "3", "@prisma/client": "5" } }),
    // LangChain: import in lib, .invoke in the route.
    "lib/chain.ts": 'import { ChatOpenAI } from "@langchain/openai";\nexport const chain = new ChatOpenAI({ model: "gpt-4o" });\n',
    "app/api/ask/route.ts": 'import { chain } from "../../../lib/chain";\nexport async function POST(req) { return Response.json(await chain.invoke("hi")); }\n',
    // Bedrock, guarded by the project's own helper name.
    "app/api/bed/route.ts": 'import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";\nimport { ensureMember } from "../../../lib/m";\nconst c = new BedrockRuntimeClient({});\nexport async function POST() { await ensureMember(); return Response.json(await c.send(new ConverseCommand({}))); }\n',
    "lib/m.ts": "export async function ensureMember() {}\n",
    // tRPC: the endpoint has no auth, the router beside the call does.
    "app/api/trpc/[trpc]/route.ts": 'import { appRouter } from "../../../../server/router";\nexport const POST = (req) => appRouter(req);\n',
    "server/router.ts": 'import { ChatOpenAI } from "@langchain/openai";\nconst m = new ChatOpenAI({});\nexport const appRouter = protectedProcedure.mutation(() => m.invoke("x"));\n',
    // A model call through a type-only import is not a model call.
    "app/api/types/route.ts": 'import type { Message } from "ai";\nexport async function GET(db) { return Response.json(await db.query("x")); }\n',
    "app/api/webhooks/clerk/route.ts": 'export async function POST(req) { const evt = await req.json(); if (evt.type === "user.created") {} return Response.json({}); }\n',
    "app/api/webhooks/ok/route.ts": 'import { verifyWebhook } from "@clerk/nextjs/webhooks";\nexport async function POST(req) { const evt = await verifyWebhook(req); return Response.json({}); }\n',
    "firestore.rules": "rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{d=**} { allow read, write: if request.time < timestamp.date(2026, 1, 1); } } }\n",
    "lib/search.ts": 'export const find = (prisma, q) => prisma.$queryRawUnsafe(`SELECT * FROM posts WHERE title = \'${q}\'`);\nexport const safe = (prisma, q) => prisma.$queryRaw`SELECT * FROM posts WHERE title = ${q}`;\n',
  }));
  const text = (id) => (ids.get(id) || []).map((f) => `${f.file} ${f.msg}`).join("\n");
  assert.match(text("ai-auth"), /app\/api\/ask\/route\.ts calls a model \(LangChain\)/);
  assert.doesNotMatch(text("ai-auth"), /bed|trpc|types/);
  assert.match(text("webhooks"), /clerk\/route\.ts handles Clerk webhooks without verifying/);
  assert.doesNotMatch(text("webhooks"), /webhooks\/ok/);
  assert.match(text("firebase-rules"), /test-mode rules/);
  assert.match(text("raw-sql"), /lib\/search\.ts/);
});

test("monorepo app: aliases inherited through extends, and Next 16 proxy.ts", () => {
  const repo = project({
    "packages/tsconfig/nextjs.json": JSON.stringify({ compilerOptions: { paths: { "~/*": ["../../apps/web/src/*"] } } }),
    "node_modules/@repo/tsconfig/nextjs.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["../../../apps/web/src/*"] } } }),
    "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { next: "16.0.0", openai: "4" } }),
    "apps/web/tsconfig.json": JSON.stringify({ extends: "@repo/tsconfig/nextjs.json" }),
    "apps/web/src/lib/a.ts": "export const a = 1;\n",
    "apps/web/src/app/page.tsx": 'import { a } from "@/lib/a";\nexport default function P() { return a; }\n',
    "apps/web/src/proxy.ts": 'export async function proxy() { const user = await getUser(); }\n',
    "apps/web/src/app/api/x/route.ts": 'import OpenAI from "openai";\nconst o = new OpenAI();\nexport async function POST() { return Response.json(await o.responses.create({ model: "gpt-4o" })); }\n',
  });
  const { ids } = run(join(repo, "apps/web"));
  assert.deepEqual(ids.get("imports"), []);
  assert.match(JSON.stringify(ids.get("ai-auth")), /Confirm src\/proxy\.ts covers this path/);
});

test("false positives from real projects stay quiet", () => {
  const { ids } = run(project({
    "package.json": JSON.stringify({ name: "x", dependencies: { next: "15.0.0", "drizzle-orm": "1", stripe: "1", "@anthropic-ai/sdk": "1" } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"], "@/public/*": ["./public/*"] } } }),
    "public/logo.svg": "<svg/>",
    "src/app/page.tsx": 'import logo from "@/public/logo.svg";\nexport default function P() { return logo; }\n',
    // saas-starter: the parameter is compared, never redirected to.
    "src/app/actions.ts": '"use server";\nimport { redirect } from "next/navigation";\nexport async function signIn(formData) {\n  const redirectTo = formData.get("redirect");\n  if (redirectTo === "checkout") return;\n  redirect("/dashboard");\n}\n',
    // documenso: validated by the project's own helper.
    "src/app/signin/route.ts": 'export function GET(request) {\n  let returnTo = new URL(request.url).searchParams.get("returnTo");\n  returnTo = isValidReturnTo(returnTo) ? returnTo : "/";\n  return redirect(returnTo);\n}\n',
    // dub: mentions a Stripe field, handles another provider's webhook with a signature helper.
    "src/app/api/appsflyer/webhook/route.ts": 'import { verifyAppsflyerSignature } from "../../../../lib/v";\nexport async function POST(req) { await verifyAppsflyerSignature(req); const select = { stripeConnectId: true }; return Response.json({}); }\n',
    "src/lib/v.ts": "export async function verifyAppsflyerSignature(r) {}\n",
    // dub: an authenticated API for managing webhooks is not a receiver.
    "src/app/api/webhooks/[id]/route.ts": 'export const GET = withWorkspace(async () => Response.json([]));\n',
    // dub: admin routes wrapped in withAdmin.
    "src/app/api/admin/route.ts": 'import Anthropic from "@anthropic-ai/sdk";\nconst a = new Anthropic();\nexport const POST = withAdmin(async () => Response.json(await a.messages.create({})));\n',
    // whirlwindai.xyz: the bug described inside a string is not the bug.
    "src/lib/copy.ts": "export const help = ['precedence', 'a + \"text\" || fallback never runs'];\n",
    // chatbot-ui: an organisation ID is not a secret.
    "src/lib/org.ts": "export const org = process.env.NEXT_PUBLIC_OPENAI_ORGANIZATION_ID;\n",
    // Drizzle migrations: no Supabase API in front, so RLS doesn't apply.
    "drizzle/0000_init.sql": "create table users (id serial primary key);\n",
    // An embedded project with its own config is checked on its own.
    "preview-kit/package.json": "{}",
    "preview-kit/ui/dialog.tsx": 'import { Button } from "@/components/ui/button";\n',
  }));
  // error-pages, env-example and ai-limit (the admin route has no limit) are correct here.
  const found = [...ids]
    .filter(([id, f]) => f.length && !["error-pages", "env-example", "ai-limit"].includes(id))
    .map(([id, f]) => `${id}: ${f.map((x) => x.file + " " + x.msg).join("; ")}`);
  assert.deepEqual(found, []);
});

test("lexer separates code from comments, strings and templates", () => {
  const { code, bare } = lex('const a = `x // y ${b + `c`} z`; // tail\nconst r = /a\\/b`/g; const s = "it`s"; /* c `x */ const u = 1;\n');
  assert.doesNotMatch(code, /tail|c `x/);
  assert.match(code, /const u = 1/);
  assert.match(bare, /\$\{b \+ ` `/);
  assert.doesNotMatch(bare, /x \/\/ y/);
});
