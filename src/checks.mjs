// Each check looks for one mistake that passes lint, type-checking and the
// build, and still costs money, leaks data or breaks a page in production.
// A check returns findings; no findings is a pass. Severity "fail" is reserved
// for things that are wrong as written; "warn" is for things that need a look.
//
// Silence a finding for one file with a comment naming the check:
//   // whirlwind-check-ignore: ai-auth (internal tool behind VPN)

import { RETIRED, DEPRECATED, MODEL_SHAPE, status } from "./models.mjs";

const fail = (file, msg, detail) => ({ level: "fail", file, msg, detail });
const warn = (file, msg, detail) => ({ level: "warn", file, msg, detail });
const mask = (s) => s.slice(0, 7) + "…";
const SOURCE_RE = /\.(m|c)?[jt]sx?$/;

// A model call, in any of the SDKs a Next.js app is likely to use.
const CALLS_MODEL = /\.chat\.completions\.create\s*\(|\.responses\.create\s*\(|\.messages\.(create|stream)\s*\(|\.images\.(generate|edit)\s*\(|\b(generateText|streamText|generateObject|streamObject|streamUI)\s*\(|\.generateContent(Stream)?\s*\(|\.models\.generate(Content|Images)\w*\s*\(|new AIClient\s*\(/;
// Method names like .messages.create are shared with other SDKs (Mailgun), so
// a call only counts in a file that imports an AI SDK, or that calls a model
// API over HTTP.
const AI_IMPORT = /from\s+["'](openai|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai|ai|@ai-sdk\/[\w-]+|groq-sdk|@mistralai\/mistralai|cohere-ai|replicate)["']|require\(\s*["'](openai|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai)["']/;
const AI_HTTP = /api\.openai\.com\/v1\/(chat|responses|images|completions)|api\.anthropic\.com\/v1\/messages|generativelanguage\.googleapis\.com/;
const callsModel = (t) => /new AIClient\s*\(/.test(t) || AI_HTTP.test(t) || (CALLS_MODEL.test(t) && AI_IMPORT.test(t));
const CHECKS_AUTH = /\b(getUser|getServerSession|getSession|currentUser|auth|getAuth|requireUser|requireAuth|requireSession|withAuth|withApiAuthRequired|getToken|verifyToken|verifyIdToken|validateRequest|getCurrentUser|getAppUser|getAuthenticatedUser|getUserOrThrow|protect)\s*\(|\bwithAuth\b|\bauth\.protect\b/;
const LIMITS = /ratelimit|rate_limit|rateLimit|limiter|throttle|quota|credits?\b|\bcharge\s*\(|consume_?\w*\s*\(|checkUsage|usageLimit|maxRequests/i;

export const CHECKS = [
  // ── Secrets ─────────────────────────────────────────────────────────────
  {
    id: "secrets-tracked", group: "Secrets", title: "No env files committed",
    run(p) {
      return [...p.tracked]
        .filter((f) => /(^|\/)\.env(\.[\w-]+)?$/.test(f) && !/\.(example|sample|template|dist|defaults)$/.test(f))
        .map((f) => fail(f, "is committed to git", "Anyone with the repo has these keys. Rotate them, then `git rm --cached` the file and add it to .gitignore."));
    },
  },
  {
    id: "secrets-hardcoded", group: "Secrets", title: "No API keys in the code",
    run(p) {
      const KEY = /\b(sk-(?:proj-|ant-api\d\d-|ant-)?[A-Za-z0-9_\-]{32,}|sk_live_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{24,}|AIza[0-9A-Za-z_\-]{35}|re_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/;
      const out = [];
      for (const f of p.files) {
        if (/(^|\/)\.env(\.local|\.development\.local|\.production\.local)?$/.test(f) && !p.tracked.has(f)) continue;
        if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp4|webm|pdf|zip|lock)$/.test(f) || /package-lock\.json$/.test(f)) continue;
        const m = p.read(f).match(KEY);
        if (m && !p.ignored(f, "secrets-hardcoded"))
          out.push(fail(f, `contains what looks like a live key (${mask(m[1])})`, "Move it to an environment variable and rotate it: it is in your git history now."));
      }
      return out;
    },
  },
  {
    id: "secrets-public", group: "Secrets", title: "No secrets exposed to the browser",
    run(p) {
      // NEXT_PUBLIC_ values are inlined into the JavaScript every visitor downloads.
      // Matched where it is read or set, not anywhere it is named: a list of
      // forbidden names is not a leak.
      const NAME = "NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|OPENAI|ANTHROPIC|GEMINI|STRIPE_SK|WEBHOOK)[A-Z0-9_]*";
      const IN_CODE = new RegExp(`process\\.env\\.(${NAME})|process\\.env\\[\\s*["'](${NAME})["']`);
      const IN_ENV = new RegExp(`^\\s*(?:export\\s+)?(${NAME})\\s*=`, "m");
      const out = [];
      for (const f of [...p.source, ...p.files.filter((f) => /(^|\/)\.env[\w.-]*$/.test(f))]) {
        const m = SOURCE_RE.test(f) ? p.code(f).match(IN_CODE) : p.read(f).match(IN_ENV);
        const name = m && (m[1] || m[2]);
        if (name && !/PUBLISHABLE/.test(name) && !p.ignored(f, "secrets-public"))
          out.push(fail(f, `uses ${name}`, "NEXT_PUBLIC_ variables ship to every visitor's browser. Drop the prefix and read it only on the server."));
      }
      // A client component reading a server-only variable gets undefined, and
      // the usual "fix" is to add NEXT_PUBLIC_.
      for (const f of p.source) {
        const t = p.code(f);
        if (!/^\s*["']use client["']/m.test(t)) continue;
        const m = t.match(/process\.env\.(?!NEXT_PUBLIC_|NODE_ENV\b)([A-Z][A-Z0-9_]*)/);
        if (m && !p.ignored(f, "secrets-public"))
          out.push(warn(f, `is a client component reading process.env.${m[1]}`, "It is undefined in the browser. Move the work to a server route rather than making the variable public."));
      }
      return out;
    },
  },

  // ── AI cost ─────────────────────────────────────────────────────────────
  {
    id: "ai-auth", group: "AI cost", title: "Every endpoint that calls a model checks who is calling",
    run(p) {
      const middleware = ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"].find(p.has);
      // Middleware only counts if it checks auth and its matcher reaches /api.
      // No matcher means every path.
      let mwAuth = false;
      if (middleware && CHECKS_AUTH.test(p.code(middleware))) {
        const matcher = (p.code(middleware).match(/matcher\s*:\s*(\[[^\]]*\]|["'][^"']*["'])/) || [])[1];
        mwAuth = !matcher || (/\(\?!/.test(matcher) ? !/\(\?![^)]*api/.test(matcher) : /\/api/.test(matcher));
      }
      const out = [];
      for (const f of p.endpoints) {
        const reach = p.withLocalImports(f);
        if (!reach.some((r) => callsModel(p.code(r))) || p.ignored(f, "ai-auth")) continue;
        if (CHECKS_AUTH.test(p.code(f))) continue;
        out.push(
          mwAuth
            ? warn(f, "calls a model and does not check the user itself", `Confirm ${middleware} covers this path, or anyone can run it on your AI bill.`)
            : fail(f, "calls a model with no sign-in check", "Anyone on the internet can call it and spend your AI budget."),
        );
      }
      return out;
    },
  },
  {
    id: "ai-limit", group: "AI cost", title: "Every endpoint that calls a model is limited",
    run(p) {
      const out = [];
      for (const f of p.endpoints) {
        const reach = p.withLocalImports(f);
        if (!reach.some((r) => callsModel(p.code(r))) || p.ignored(f, "ai-limit")) continue;
        if (!CHECKS_AUTH.test(p.code(f))) continue; // ai-auth already reports it
        if (!reach.some((r) => LIMITS.test(p.code(r))))
          out.push(warn(f, "calls a model with no rate limit, credits or quota", "One signed-in user, or one free trial, can run up an unbounded bill."));
      }
      return out;
    },
  },
  {
    id: "models", group: "AI cost", title: "No retired or deprecated model IDs",
    run(p, ctx) {
      const found = new Map();
      for (const f of [...p.source, ...p.files.filter((f) => /(^|\/)(\.env\.example|[\w.-]+\.json)$/.test(f) && !/package(-lock)?\.json$/.test(f))]) {
        const t = p.code(f);
        for (const m of t.matchAll(/["'`=]\s*([a-z][a-z0-9.\-@:]+)["'`\s]?/g)) {
          const id = m[1];
          if (MODEL_SHAPE.test(id) && !found.has(id)) found.set(id, f);
        }
      }
      ctx.models = found;
      const out = [];
      for (const [id, f] of found) {
        const s = status(id);
        if (s === "retired" && !p.ignored(f, "models")) out.push(fail(f, `uses ${id}, which the provider has retired`, "Every request to it returns an error."));
        if (s === "deprecated" && !p.ignored(f, "models")) out.push(warn(f, `uses ${id}, which the provider has deprecated`, "It is scheduled to stop working. Check the provider's deprecations page and move to a current model."));
      }
      return out;
    },
  },

  // ── Payments ────────────────────────────────────────────────────────────
  {
    id: "stripe-webhook", group: "Payments", title: "Stripe webhooks verify their signature",
    run(p) {
      const out = [];
      for (const f of p.endpoints) {
        const t = p.code(f);
        if (!/stripe/i.test(t) || !(/webhook/i.test(f) || /constructEvent|stripe-signature|checkout\.session\.completed/.test(t))) continue;
        if (p.ignored(f, "stripe-webhook")) continue;
        if (!/constructEvent(Async)?\s*\(/.test(t))
          out.push(fail(f, "handles Stripe events without verifying the signature", "Anyone can POST a fake checkout.session.completed and give themselves access. Use stripe.webhooks.constructEvent."));
        else if (/\.json\s*\(\s*\)/.test(t.split(/constructEvent/)[0]))
          out.push(fail(f, "parses the body as JSON before verifying the signature", "Verification needs the raw body. Use await req.text()."));
        else if (f.includes("pages/api/") && !/bodyParser:\s*false/.test(t))
          out.push(fail(f, "leaves the body parser on", "Signature verification needs the raw body. Export config = { api: { bodyParser: false } }."));
      }
      return out;
    },
  },
  {
    id: "stripe-price", group: "Payments", title: "The server decides the price",
    run(p) {
      const out = [];
      for (const f of p.endpoints) {
        const t = p.code(f);
        if (!/checkout\.sessions\.create|paymentIntents\.create|subscriptions\.create/.test(t) || p.ignored(f, "stripe-price")) continue;
        if (/\b(unit_amount|amount)\s*:\s*(body|req\.body|data|input|params|json|payload)\b/.test(t))
          out.push(fail(f, "takes the amount from the request", "The buyer chooses what they pay. Look the amount up on the server."));
        else if (/\bprice\s*:\s*(body|req\.body|data|input|params|json|payload)\.\w+/.test(t) && !/includes\(|\.has\(|allowed|ALLOWED|PRICES|priceIds/.test(t))
          out.push(warn(f, "accepts a Stripe price ID from the request without an allowlist", "Any price in your Stripe account can be bought through it, including test or discounted ones."));
      }
      return out;
    },
  },
  {
    id: "stripe-redirect", group: "Payments", title: "Checkout redirect URLs come from config",
    run(p) {
      const out = [];
      for (const f of p.endpoints) {
        const t = p.code(f);
        if (!/(success_url|cancel_url|return_url)[^\n]*\b(origin|referer|returnUrl|successUrl|cancelUrl|redirectUrl)\b/.test(t) || p.ignored(f, "stripe-redirect")) continue;
        // Falling back to the header in development only is fine.
        if (/NODE_ENV\s*!==?\s*["']production["']|NODE_ENV\s*===?\s*["']development["']/.test(t)) continue;
        if (/\.get\(\s*["'](origin|referer|host)["']\s*\)\s*\|\||headers\.(origin|referer|host)\s*\|\|/.test(t))
          out.push(fail(f, "prefers the request's Origin header over your configured URL", "Anyone can call it with their own Origin and send your buyers to a lookalike site after paying. Use the configured URL; fall back to the header only in development."));
        else if (/headers\.get\(\s*["'](origin|referer|host)["']|headers\.(origin|referer|host)\b|\.json\s*\(\s*\)|req\.body/.test(t))
          out.push(warn(f, "builds Stripe redirect URLs from the request", "The Origin header and request body are caller-controlled. Use your configured site URL."));
      }
      return out;
    },
  },

  // ── Auth ────────────────────────────────────────────────────────────────
  {
    id: "open-redirect", group: "Auth", title: "No open redirects",
    run(p) {
      const out = [];
      for (const f of p.source) {
        const t = p.code(f);
        const m = t.match(/\.get\(\s*["'](next|redirect|redirectTo|redirect_to|returnTo|return_to|callbackUrl|callback|continue|from)["']\s*\)/);
        if (!m || !/redirect\s*\(|\.push\s*\(|\.replace\s*\(|location\s*(\.href\s*)?=|location\.assign/.test(t)) continue;
        if (/startsWith\(\s*["'`]\/|safe\w*\(|isSafe|isRelative|sanitize|allowlist|ALLOWED|\.origin\s*===|\.host\s*===/.test(t) || p.ignored(f, "open-redirect")) continue;
        out.push(fail(f, `redirects to the "${m[1]}" query parameter unchecked`, `A link with ?${m[1]}=https://evil.example signs the user in and hands them to another site. Accept only paths starting with a single "/".`));
      }
      return out;
    },
  },
  {
    id: "supabase-session", group: "Auth", title: "Server code validates the Supabase session",
    run(p) {
      if (!p.stack.includes("Supabase")) return [];
      const server = p.source.filter((f) => /middleware\.[jt]s$/.test(f) || p.endpoints.includes(f));
      return server
        .filter((f) => /auth\.getSession\s*\(/.test(p.code(f)) && !/auth\.getUser\s*\(|getClaims\s*\(/.test(p.code(f)) && !p.ignored(f, "supabase-session"))
        .map((f) => warn(f, "trusts auth.getSession() on the server", "getSession reads the cookie without validating it. Use auth.getUser() before acting on who the user is."));
    },
  },

  // ── Database ────────────────────────────────────────────────────────────
  {
    id: "supabase-rls", group: "Database", title: "Every table has row level security",
    run(p) {
      const sql = p.files.filter((f) => f.endsWith(".sql") && /migrations?\/|supabase\//.test(f));
      if (!sql.length) return [];
      const created = new Map(), secured = new Set();
      for (const f of sql) {
        const t = p.read(f).replace(/--.*$/gm, "");
        for (const m of t.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi))
          if (!created.has(m[1].toLowerCase())) created.set(m[1].toLowerCase(), f);
        for (const m of t.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s+enable\s+row\s+level\s+security/gi))
          secured.add(m[1].toLowerCase());
      }
      // Tables in another schema (private.x) are not exposed by the API.
      const out = [];
      for (const [table, f] of created) {
        if (new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?"?(?!public)\\w+"?\\."?${table}\\b`, "i").test(p.read(f))) continue;
        if (!secured.has(table) && !p.ignored(f, "supabase-rls"))
          out.push(fail(f, `creates table ${table} without row level security`, "Anyone with your public anon key can read and write every row through the REST API."));
      }
      // Policies that let anyone change anything.
      for (const f of sql) {
        const t = p.read(f).replace(/--.*$/gm, "");
        for (const m of t.matchAll(/create\s+policy\s+"?([^"\n]+?)"?\s+on\s+(?:public\.)?"?(\w+)"?([\s\S]*?);/gi)) {
          const body = m[3];
          if (/for\s+(all|insert|update|delete)/i.test(body) && /(using|with\s+check)\s*\(\s*true\s*\)/i.test(body) && !/to\s+service_role/i.test(body) && !p.ignored(f, "supabase-rls"))
            out.push(warn(f, `policy "${m[1]}" on ${m[2]} allows any write`, "using (true) on insert, update or delete lets every user change every row."));
        }
      }
      return out;
    },
  },
  {
    id: "supabase-rpc", group: "Database", title: "Privileged database functions are locked down",
    run(p) {
      // SECURITY DEFINER functions run with the owner's rights and, in the
      // public schema, are callable by anyone at /rest/v1/rpc/<name> unless
      // execute is revoked. One that adds credits is free credits.
      const sql = p.files.filter((f) => f.endsWith(".sql") && /migrations?\/|supabase\//.test(f));
      if (!sql.length) return [];
      const all = sql.map((f) => p.read(f).replace(/--.*$/gm, "")).join("\n");
      const out = [];
      for (const f of sql) {
        const t = p.read(f).replace(/--.*$/gm, "");
        for (const m of t.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\.)?"?(\w+)"?\s*\(([\s\S]*?)(?=create\s+(?:or\s+replace\s+)?function|$)/gi)) {
          const [, name, body] = m;
          if (!/security\s+definer/i.test(body)) continue;
          if (/^handle_new_user$|trigger/i.test(name) || /returns\s+trigger/i.test(body)) continue;
          if (/auth\.uid\(\)|auth\.jwt\(\)|auth\.role\(\)/.test(body)) continue; // checks the caller itself
          const revoked = new RegExp(`revoke\\s+(all|execute)[\\s\\S]{0,40}?on\\s+function\\s+(?:"?public"?\\.)?"?${name}\\b[\\s\\S]{0,200}?from[^;]*(public|anon|authenticated)`, "i").test(all);
          if (!revoked && !p.ignored(f, "supabase-rpc"))
            out.push(warn(f, `${name}() is SECURITY DEFINER and callable by anyone`, `Supabase exposes it at /rest/v1/rpc/${name}. Revoke execute from public, anon and authenticated, or check auth.uid() inside it.`));
        }
      }
      return out;
    },
  },
  {
    id: "supabase-tables", group: "Database", title: "Every queried table has a migration",
    run(p) {
      const sql = p.files.filter((f) => f.endsWith(".sql") && /migrations?\//.test(f));
      if (!sql.length || !p.stack.includes("Supabase")) return [];
      const made = new Set();
      for (const f of sql) for (const m of p.read(f).matchAll(/create\s+(?:table|view|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi)) made.add(m[1].toLowerCase());
      const used = new Map();
      for (const f of p.source)
        for (const m of p.bare(f).matchAll(/(\bstorage\s*)?\.from\(\s*["'](\w+)["']\s*\)/g))
          if (!m[1] && !used.has(m[2])) used.set(m[2], f);
      return [...used].filter(([t]) => !made.has(t.toLowerCase())).filter(([, f]) => !p.ignored(f, "supabase-tables"))
        .map(([t, f]) => warn(f, `queries table ${t}, which no migration creates`, "A fresh environment will not have it, so this query fails after the next deploy or database reset."));
    },
  },

  // ── Code ────────────────────────────────────────────────────────────────
  {
    id: "imports", group: "Code", title: "Every local import resolves",
    run(p) {
      const out = [];
      for (const f of p.source) {
        if (p.ignored(f, "imports")) continue;
        for (const s of p.importsOf(f))
          if (p.resolve(f, s) === null) out.push(fail(f, `imports "${s}", which does not exist`, "The page or route fails when this module loads."));
      }
      return out;
    },
  },
  {
    id: "precedence", group: "Code", title: "No dead fallbacks after string concatenation",
    run(p) {
      return p.source
        .filter((f) => /\+\s*["'`][^"'`\n]*["'`]\s*\|\|/.test(p.code(f)) && !p.ignored(f, "precedence"))
        .map((f) => fail(f, 'has `a + "text" || fallback`', '+ binds tighter than ||, so the left side is always a truthy string and the fallback never runs.'));
    },
  },
  {
    id: "not-found", group: "Code", title: "Dynamic pages 404 on unknown IDs",
    run(p) {
      return p.source
        .filter((f) => /\[[^\]]+\]/.test(f) && /\/page\.[jt]sx?$/.test(f))
        .filter((f) => /=\s*\w+(\.\w+)*\.find\(/.test(p.code(f)) && !/notFound\s*\(|return\s+null|redirect\s*\(|if\s*\(\s*!\w+\s*\)/.test(p.code(f)) && !p.ignored(f, "not-found"))
        .map((f) => warn(f, "looks up a record with .find() and never calls notFound()", "An unknown ID is undefined, and the next property access is a 500 instead of a 404."));
    },
  },
  {
    id: "error-pages", group: "Code", title: "Error and not-found pages exist",
    run(p) {
      if (!p.appDir) return [];
      const missing = ["error", "not-found"].filter((n) => !["js", "jsx", "ts", "tsx"].some((e) => p.has(`${p.appDir}/${n}.${e}`)));
      return missing.map((n) => warn(`${p.appDir}/${n}`, "is missing", n === "error" ? "A thrown error shows Next.js's unstyled default screen." : "Unknown URLs show Next.js's unstyled default 404."));
    },
  },
  {
    id: "image-proxy", group: "Code", title: "The image optimizer is not an open proxy",
    run(p) {
      const cfg = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"].find(p.has);
      if (!cfg) return [];
      return /hostname:\s*["'`]\*\*["'`]/.test(p.code(cfg))
        ? [fail(cfg, 'allows images from hostname "**"', "Anyone can resize any image on the internet through /_next/image on your bill. List the hosts you use.")]
        : [];
    },
  },
  {
    id: "env-example", group: "Code", title: "Every env variable is documented",
    run(p) {
      const ex = [".env.example", ".env.sample", ".env.template"].find(p.has);
      const BUILTIN = /^(NODE_ENV|NEXT_RUNTIME|NEXT_PHASE|VERCEL\w*|CI|PORT|HOSTNAME|PWD|HOME|npm_\w+|TZ|DEBUG|ANALYZE)$/;
      const read = new Map();
      for (const f of p.source)
        for (const m of p.code(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g)) {
          const k = m[1] || m[2];
          if (!BUILTIN.test(k) && !read.has(k)) read.set(k, f);
        }
      if (!read.size) return [];
      if (!ex) return [warn(".env.example", "is missing", `The code reads ${read.size} environment variable(s). A new developer, or your agent, has to find them by reading the source.`)];
      const listed = new Set([...p.read(ex).matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]));
      const missing = [...read.keys()].filter((k) => !listed.has(k));
      return missing.length
        ? [warn(ex, `is missing ${missing.length} variable(s) the code reads`, missing.slice(0, 8).join(", ") + (missing.length > 8 ? ", …" : ""))]
        : [];
    },
  },
];

export { RETIRED, DEPRECATED };
