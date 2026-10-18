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

// Model calls, per provider: [name, package names, call pattern]. Method
// names like .invoke or .messages.create are shared with unrelated libraries
// (Mailgun), so a call only counts when the endpoint's code also imports that
// provider's package.
const PROVIDERS = [
  ["OpenAI", "openai", /\.chat\.completions\.(create|stream|parse)\s*\(|\.responses\.(create|stream)\s*\(|\.images\.(generate|edit)\s*\(|\.audio\.\w+\.create\s*\(|\.embeddings\.create\s*\(|\.completions\.create\s*\(/],
  ["Anthropic", "@anthropic-ai\\/[\\w-]+", /\.messages\.(create|stream)\s*\(/],
  ["Gemini", "@google\\/(?:generative-ai|genai)|@google-cloud\\/vertexai", /\.generateContent(Stream)?\s*\(|\.models\.generate\w*\s*\(|\.sendMessage(Stream)?\s*\(/],
  ["AI SDK", "ai|@ai-sdk\\/[\\w-]+|@openrouter\\/[\\w-]+", /\b(generateText|streamText|generateObject|streamObject|streamUI|embed|embedMany|generateImage|experimental_generateImage|generateSpeech|experimental_generateSpeech|experimental_transcribe)\s*\(/],
  ["Groq", "groq-sdk", /\.chat\.completions\.create\s*\(/],
  ["Mistral", "@mistralai\\/mistralai", /\.chat\.(complete|stream)\s*\(|\.fim\.complete\s*\(/],
  ["Together", "together-ai", /\.chat\.completions\.create\s*\(|\.images\.create\s*\(/],
  ["Cohere", "cohere-ai", /\.(chat|chatStream|generate|embed|rerank)\s*\(/],
  ["LangChain", "langchain(?:\\/[\\w\\/-]+)?|@langchain\\/[\\w\\/-]+", /\.(invoke|batch|stream|streamEvents|call|predict)\s*\(/],
  ["LlamaIndex", "llamaindex(?:\\/[\\w\\/-]+)?|@llamaindex\\/[\\w-]+", /\.(chat|complete|query)\s*\(/],
  ["Mastra", "@mastra\\/[\\w-]+", /\.(generate|stream)\s*\(/],
  ["Ollama", "ollama(?:\\/browser)?", /\.(chat|generate|embed)\s*\(/],
  ["Replicate", "replicate", /\.(run|stream)\s*\(|predictions\.create\s*\(/],
  ["Hugging Face", "@huggingface\\/inference", /\b(chatCompletion|chatCompletionStream|textGeneration|textGenerationStream|textToImage|featureExtraction)\s*\(/],
  ["fal", "@fal-ai\\/[\\w-]+", /\.(subscribe|run|stream)\s*\(/],
  ["Bedrock", "@aws-sdk\\/client-bedrock-runtime", /new (InvokeModel|InvokeModelWithResponseStream|Converse|ConverseStream)Command\s*\(/],
  ["ElevenLabs", "elevenlabs|@elevenlabs\\/[\\w-]+", /textToSpeech\.(convert|stream)\s*\(/],
].map(([name, pkgs, call]) => [name, new RegExp(`^(?:${pkgs})$`), call]);
// Model APIs called over plain HTTP.
const AI_HTTP = [
  ["OpenAI", /api\.openai\.com\/v1\/(chat|responses|images|completions|audio|embeddings)/],
  ["Anthropic", /api\.anthropic\.com\/v1\/messages/],
  ["Gemini", /generativelanguage\.googleapis\.com/],
  ["OpenRouter", /openrouter\.ai\/api/],
  ["Groq", /api\.groq\.com/], ["Mistral", /api\.mistral\.ai/], ["Together", /api\.together\.(xyz|ai)/],
  ["Perplexity", /api\.perplexity\.ai/], ["xAI", /api\.x\.ai/], ["DeepSeek", /api\.deepseek\.com/],
  ["Fireworks", /api\.fireworks\.ai/], ["Cohere", /api\.cohere\.(ai|com)/], ["Replicate", /api\.replicate\.com/],
  ["Hugging Face", /(api-inference|router)\.huggingface\.co/], ["fal", /\bfal\.run\b/], ["ElevenLabs", /api\.elevenlabs\.io/],
];
// Which provider, if any, the endpoint reaches. `files` is the endpoint plus
// its local imports.
// Per-file signals, computed once: which provider packages it imports (type
// imports excluded), which providers' call shapes appear, and direct HTTP calls.
const signalCache = new WeakMap();
function signals(p, f) {
  let byFile = signalCache.get(p);
  if (!byFile) signalCache.set(p, (byFile = new Map()));
  if (!byFile.has(f)) {
    const t = p.code(f);
    const specs = p.importsOf(f, { values: true });
    byFile.set(f, {
      aiClient: /new AIClient\s*\(/.test(t),
      http: (AI_HTTP.find(([, re]) => re.test(t)) || [])[0],
      imports: new Set(PROVIDERS.filter(([, imp]) => specs.some((sp) => imp.test(sp))).map(([n]) => n)),
      calls: new Set(PROVIDERS.filter(([, , call]) => call.test(t)).map(([n]) => n)),
    });
  }
  return byFile.get(f);
}
function modelCall(p, files) {
  const sig = files.map((f) => signals(p, f));
  if (sig.some((x) => x.aiClient)) return "AI";
  const http = sig.find((x) => x.http);
  if (http) return http.http;
  for (const [name] of PROVIDERS) if (sig.some((x) => x.imports.has(name)) && sig.some((x) => x.calls.has(name))) return name;
  return null;
}
// A redirect target checked to be a same-site path, or against an allowlist.
const SAFE_TARGET = /startsWith\(\s*["'`]\/|\/\^\\\/|safe\w*\(|isSafe|isValid\w*(Url|Redirect|Return|Path|Next|Callback)|isRelative|isInternal|isLocal\w*Url|sanitize|normalize\w*(Return|Redirect)|allowlist|ALLOWED|\.origin\s*===|\.host\s*===/;
// Who-is-calling checks: the common auth libraries by name, then the usual
// shapes of a project's own helper (getUser, requireSession, ensureMember…),
// wrappers (withAuth) and authenticated tRPC / next-safe-action procedures.
const CHECKS_AUTH = new RegExp([
  /\b(auth|currentUser|getAuth|protect|getIronSession|getKindeServerSession|validateRequest|getServerAuthSession|getServerSession|getToken|verifyIdToken)\s*\(/.source,
  /\b(get|require|ensure|check|verify|validate|assert|fetch|load|read)\w*(User|Session|Auth|Member|Token|Claims|Viewer|Account|Org|Identity|Profile|Admin|Workspace)\w*\s*\(/.source,
  /\bwith\w*(Auth|Session|User|Workspace|Team|Org|Admin|Project|Account|Member)\b|\bauth\.protect\b|\b(protected|authed|private|authenticated|user)Procedure\b|\bauth(enticated)?Action(Client)?\b/.source,
].join("|"));
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
        // Webhook secrets and Google browser keys in tests are usually fakes;
        // the unambiguous live-key prefixes count everywhere.
        if (m && p.isTooling(f) && !/^(sk-|sk_live_|rk_live_|ghp_|github_pat_)/.test(m[1])) continue;
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
      // Secret-shaped names only: an organisation ID or a publishable key is
      // meant to be public.
      const NAME = "NEXT_PUBLIC_(?:[A-Z0-9_]*(?:SECRET|SERVICE_ROLE|PRIVATE_KEY|PASSWORD|STRIPE_SK)[A-Z0-9_]*|(?:OPENAI|ANTHROPIC|CLAUDE|GEMINI|GOOGLE_AI|GROQ|MISTRAL|REPLICATE|TOGETHER|OPENROUTER|PERPLEXITY|ELEVENLABS|RESEND|SENDGRID|DEEPSEEK|XAI)_?(?:API_)?KEY)";
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
      // Middleware only counts if it checks auth and its matcher reaches /api.
      // No matcher means every path.
      let mwAuth = false;
      if (p.middleware && CHECKS_AUTH.test(p.code(p.middleware))) {
        const matcher = (p.code(p.middleware).match(/matcher\s*:\s*(\[[^\]]*\]|["'][^"']*["'])/) || [])[1];
        mwAuth = !matcher || (/\(\?!/.test(matcher) ? !/\(\?![^)]*api/.test(matcher) : /\/api/.test(matcher));
      }
      const out = [];
      for (const f of p.endpoints) {
        const reach = p.withLocalImports(f);
        const provider = modelCall(p, reach);
        if (!provider || p.ignored(f, "ai-auth")) continue;
        // The check can sit in the endpoint itself, or beside the model call
        // (a tRPC router, a service function).
        if (CHECKS_AUTH.test(p.code(f)) || reach.some((r) => r !== f && modelCall(p, [r]) && CHECKS_AUTH.test(p.code(r)))) continue;
        out.push(
          mwAuth
            ? warn(f, `calls a model (${provider}) and does not check the user itself`, `Confirm ${p.middleware} covers this path, or anyone can run it on your AI bill.`)
            : reach.some((r) => LIMITS.test(p.code(r)))
              ? warn(f, `calls a model (${provider}) with no sign-in check, only a rate limit`, "Fine for a public demo. Otherwise anyone can use it, up to the limit, on your AI bill.")
              : fail(f, `calls a model (${provider}) with no sign-in check`, "Anyone on the internet can call it and spend your AI budget."),
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
        const provider = modelCall(p, reach);
        if (!provider || p.ignored(f, "ai-limit")) continue;
        if (!CHECKS_AUTH.test(p.code(f)) && !reach.some((r) => r !== f && modelCall(p, [r]) && CHECKS_AUTH.test(p.code(r)))) continue; // ai-auth reports it
        if (!reach.some((r) => LIMITS.test(p.code(r))))
          out.push(warn(f, `calls a model (${provider}) with no rate limit, credits or quota`, "One signed-in user, or one free trial, can run up an unbounded bill."));
      }
      return out;
    },
  },
  {
    id: "models", group: "AI cost", title: "No retired or deprecated model IDs",
    run(p, ctx) {
      const found = new Map();
      for (const f of [...p.source, ...p.files.filter((f) => /(^|\/)(\.env\.example|[\w.-]+\.json)$/.test(f) && !/package(-lock)?\.json$/.test(f) && !p.isTooling(f))]) {
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
        const STRIPE_EVENTS = /constructEvent|stripe-signature|checkout\.session\.|customer\.subscription\.|invoice\.(paid|payment_)|payment_intent\.|charge\.(succeeded|refunded)|Stripe\.Event\b|v2\.core\./i;
        if (!/stripe/i.test(t) || !STRIPE_EVENTS.test(t) || !/webhook/i.test(f + t)) continue;
        if (p.ignored(f, "stripe-webhook")) continue;
        const verified = p.withLocalImports(f).some((r) => /constructEvent(Async)?\s*\(|parse\w*Event\w*\s*\(|parseEventNotification/.test(p.code(r)));
        if (!verified)
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
        if (/NODE_ENV\s*!==?\s*["']production["']|NODE_ENV\s*===?\s*["']development["']/.test(t) || SAFE_TARGET.test(t)) continue;
        if (/\.get\(\s*["'](origin|referer|host)["']\s*\)\s*\|\||headers\.(origin|referer|host)\s*\|\|/.test(t))
          out.push(fail(f, "prefers the request's Origin header over your configured URL", "Anyone can call it with their own Origin and send your buyers to a lookalike site after paying. Use the configured URL; fall back to the header only in development."));
        else if (/headers\.get\(\s*["'](origin|referer|host)["']|headers\.(origin|referer|host)\b|\.json\s*\(\s*\)|req\.body/.test(t))
          out.push(warn(f, "builds Stripe redirect URLs from the request", "The Origin header and request body are caller-controlled. Use your configured site URL."));
      }
      return out;
    },
  },

  {
    id: "webhooks", group: "Payments", title: "Other webhooks verify their signature",
    run(p) {
      // Stripe has its own check above. Anything else named webhook, or
      // handling a known provider's events, must check a signature or secret.
      const KNOWN = [
        ["Lemon Squeezy", /lemon-?squeezy|x-signature/i],
        ["Paddle", /paddle/i],
        ["Polar", /@polar-sh|polar\.sh/i],
        ["Clerk", /@clerk|svix|user\.created/i],
        ["GitHub", /x-hub-signature|x-github-event/i],
        ["Resend", /email\.(delivered|bounced|opened)/],
        ["Supabase", /supabase.*webhook|webhook.*supabase/i],
      ];
      const VERIFIES = /constructEvent|parse\w*Event|createHmac|timingSafeEqual|\.verify\s*\(|verify\w*(Webhook|Signature|Request)\w*\s*\(|validate\w*(Event|Signature|Webhook)\w*\s*\(|unmarshal|is\w*Signature\w*\s*\(|\bWebhooks\s*\(|WEBHOOK_SECRET|webhookSecret|signingSecret|SIGNING_SECRET|CRON_SECRET|verifySignatureAppRouter|IP_RANGES|isIpInRange|ipAllowlist|allowedIps/;
      const out = [];
      for (const f of p.endpoints) {
        const t = p.code(f);
        if (/stripe/i.test(t) && /constructEvent|stripe-signature|checkout\.session/.test(t)) continue;
        const known = KNOWN.find(([, re]) => re.test(t) || re.test(f));
        if (!/webhook/i.test(f) && !(known && /webhook/i.test(t))) continue;
        // An authenticated API that manages webhooks is not a receiver.
        if (CHECKS_AUTH.test(t) || p.ignored(f, "webhooks")) continue;
        if (p.withLocalImports(f).some((r) => VERIFIES.test(p.code(r)))) continue;
        out.push(known
          ? fail(f, `handles ${known[0]} webhooks without verifying the signature`, "Anyone who finds the URL can send fake events. Verify the signature with the provider's signing secret.")
          : warn(f, "is a webhook with no visible signature or secret check", "Anyone who finds the URL can send fake events. Verify the sender before acting on them."));
      }
      return out;
    },
  },

  // ── Auth ────────────────────────────────────────────────────────────────
  {
    id: "open-redirect", group: "Auth", title: "No open redirects",
    run(p) {
      const NAMES = "next|redirect|redirectTo|redirect_to|redirectUrl|returnTo|return_to|returnUrl|callbackUrl|callback|continue|from";
      const READ_INTO = new RegExp(String.raw`\b(\w+)\s*=[^\n;]*?\.get\(\s*["'](${NAMES})["']\s*\)`, "g");
      const READ = new RegExp(String.raw`\.get\(\s*["'](${NAMES})["']\s*\)`, "g");
      const SINK = String.raw`(?:redirect|permanentRedirect|push|replace|assign)\s*\(\s*(?:new URL\(\s*)?`;
      const out = [];
      for (const f of p.source) {
        const t = p.code(f);
        if (SAFE_TARGET.test(t) || p.ignored(f, "open-redirect")) continue;
        // Used as the target: directly, or through the variable it was read into.
        const hits = [
          ...[...t.matchAll(READ)].filter((m) => new RegExp(SINK + String.raw`[^)\n]*\.get\(\s*["']${m[1]}["']`).test(t)).map((m) => m[1]),
          ...[...t.matchAll(READ_INTO)].filter(([, v]) =>
            new RegExp(SINK + String.raw`${v}\b`).test(t) || new RegExp(String.raw`location(\.href)?\s*=\s*${v}\b|redirect(To)?:\s*${v}\b`).test(t)).map((m) => m[2]),
        ];
        if (hits.length)
          out.push(fail(f, `redirects to the "${hits[0]}" query parameter unchecked`, `A link with ?${hits[0]}=https://evil.example signs the user in and hands them to another site. Accept only paths starting with a single "/".`));
      }
      return out;
    },
  },
  {
    id: "origin-links", group: "Auth", title: "Links aren't built from the caller's Origin header",
    run(p) {
      // The Origin, Host and Referer headers are set by whoever sends the
      // request. A URL built from them points wherever the caller likes, and
      // when that URL is emailed (a sign-in or dashboard link, often with a
      // token in it) the site sends a real user a genuine email pointing to
      // another domain. Stripe's success/cancel URLs have their own check.
      const HEADER = String.raw`(?:headers\(\)|\w*[hH]eaders\w*|req\.headers|request\.headers)\.get\(\s*["'](?:origin|host|x-forwarded-host|referer)["']\s*\)|(?:req|request)\.headers\.(?:origin|host|referer)\b`;
      const FIRST = new RegExp(String.raw`(?:=|\(|return)\s*\(?\s*(?:${HEADER})`);
      // Guarded: the configured URL comes before the header in the same
      // expression, or the header is used only outside production. A
      // configured URL *after* the header (header || env) is the bug itself.
      const GUARDED = new RegExp(String.raw`process\.env\.\w*(?:URL|ORIGIN|DOMAIN|SITE|HOST)\w*\s*(?:\|\||\?\?)[^;]*?(?:${HEADER})|NODE_ENV\s*!==?\s*["']production["']|NODE_ENV\s*===?\s*["']development["']`);
      const EMAILS = /\bsendEmail\s*\(|\.emails\.send\s*\(|\bsendMail\s*\(|\bresend\.|nodemailer|signInWithOtp|inviteUserByEmail|generateLink/;
      const out = [];
      for (const f of p.source) {
        const t = p.code(f);
        if (!new RegExp(HEADER).test(t) || GUARDED.test(t) || p.ignored(f, "origin-links")) continue;
        if (/success_url|cancel_url|return_url/.test(t)) continue; // stripe-redirect
        // Crawler files on multi-domain apps use the Host header on purpose.
        if (/(^|\/)(robots|sitemap)\.[jt]s$/.test(f)) continue;
        // Names that hold the header value: variables assigned from it, and
        // helper functions that return it.
        const names = new Set();
        for (const m of t.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*\(?\s*(?:${HEADER})`, "g"))) names.add(m[1]);
        for (const m of t.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*\{([^}]*)\}/g)) {
          if (!FIRST.test(m[2])) continue;
          names.add(`${m[1]}\\(\\)`); // the helper called inline: ${originFrom()}
          for (const c of t.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*${m[1]}\s*\(`, "g"))) names.add(c[1]);
        }
        const used = [...names].some((v) => new RegExp(String.raw`\$\{\s*${v}|\b${v}\s*\+\s*["'\`]|new URL\([^)]*,\s*${v}\s*\)`).test(t));
        if (!used) continue;
        out.push(EMAILS.test(t)
          ? fail(f, "emails links built from the request's Origin header", "Anyone can send a request with their own Origin, and your site emails a real user a genuine link to another domain, with any token in it. Build links from your configured site URL.")
          : warn(f, "builds URLs from the request's Origin or Host header", "Those headers are set by the caller. Use your configured site URL, and fall back to the header only in development."));
      }
      return out;
    },
  },
  {
    id: "supabase-session", group: "Auth", title: "Server code validates the Supabase session",
    run(p) {
      if (!p.stack.includes("Supabase")) return [];
      const server = p.source.filter((f) => f === p.middleware || p.endpoints.includes(f));
      return server
        .filter((f) => /auth\.getSession\s*\(/.test(p.code(f)) && !/auth\.getUser\s*\(|getClaims\s*\(/.test(p.code(f)) && !p.ignored(f, "supabase-session"))
        .map((f) => warn(f, "trusts auth.getSession() on the server", "getSession reads the cookie without validating it. Use auth.getUser() before acting on who the user is."));
    },
  },

  // ── Database ────────────────────────────────────────────────────────────
  {
    id: "supabase-rls", group: "Database", title: "Every table has row level security",
    run(p) {
      if (!p.stack.includes("Supabase")) return []; // RLS matters where the database is exposed through Supabase's API
      const sql = p.files.filter((f) => f.endsWith(".sql") && !p.isTooling(f) && /migrations?\/|supabase\//.test(f));
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
      if (!p.stack.includes("Supabase")) return []; // RLS matters where the database is exposed through Supabase's API
      const sql = p.files.filter((f) => f.endsWith(".sql") && !p.isTooling(f) && /migrations?\/|supabase\//.test(f));
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
      const sql = p.files.filter((f) => f.endsWith(".sql") && !p.isTooling(f) && /migrations?\//.test(f));
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

  {
    id: "firebase-rules", group: "Database", title: "Firebase rules don't allow everyone",
    run(p) {
      const out = [];
      for (const f of p.files.filter((f) => /(^|\/)(firestore|storage)\.rules$/.test(f) && !p.isTooling(f))) {
        const t = p.read(f).replace(/\/\/.*$/gm, "");
        if (/allow\s+[^;]*:\s*if\s+true\s*;/.test(t))
          out.push(fail(f, "has a rule that allows anyone (if true)", "Every visitor can read or write that data with your public Firebase config."));
        else if (/allow\s+[^;]*:\s*if\s+request\.time\s*<\s*timestamp\.date/.test(t))
          out.push(fail(f, "still has the test-mode rules", "Anyone can read and write everything until the date passes, then the app stops working."));
      }
      for (const f of p.files.filter((f) => /(^|\/)database\.rules\.json$/.test(f) && !p.isTooling(f))) {
        if (/"\.(read|write)"\s*:\s*(true|"true")/.test(p.read(f)))
          out.push(fail(f, "allows anyone to read or write", "Set .read and .write to conditions on auth, not true."));
      }
      return out;
    },
  },
  {
    id: "raw-sql", group: "Database", title: "No SQL built from strings",
    run(p) {
      // Tagged templates (prisma.$queryRaw`…`, sql`…`) are parameterised and
      // safe. These forms paste values into the SQL text.
      // A call that passes values separately (a second argument) is
      // parameterised even when the text is assembled, e.g. building "?, ?, ?".
      const RAW = [
        /\$(queryRaw|executeRaw)Unsafe\s*\(\s*(`[^`]*\$\{[^`]*`|[^),]*\+[^),]*)\s*\)/,
        /\bsql\.raw\s*\(\s*(`[^`]*\$\{[^`]*`|[^)]*\+[^)]*)\s*\)/,
        /\.(query|execute|unsafe)\s*\(\s*`\s*(select|insert|update|delete|with)\b[^`]*\$\{[^`]*`\s*\)/i,
        /\.(query|execute|unsafe)\s*\(\s*["'](select|insert|update|delete)\b[^"']*["']\s*\+[^),]*\)/i,
      ];
      return p.source
        .filter((f) => RAW.some((re) => re.test(p.code(f))) && !p.ignored(f, "raw-sql"))
        .map((f) => fail(f, "builds SQL by pasting values into the query text", "If any value comes from a request, that is SQL injection. Pass values as parameters, or use a tagged template like sql`…` or $queryRaw`…`."));
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
        .filter((f) => /\+\s*["'`][^"'`\n]*["'`]\s*\|\|/.test(p.blank(f)) && !p.ignored(f, "precedence"))
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
