# whirlwindai

Checks a Next.js project for the mistakes that pass lint, type-checking and the build, and still cost money, leak data or break pages in production. They are the mistakes AI coding agents make most often.

```bash
npx whirlwindai
```

No install, no account, no config. It reads your code locally and sends nothing anywhere (unless you pass `--deep`, below).

## What it checks

| Group | Check | Catches |
|---|---|---|
| Secrets | `secrets-tracked` | `.env` files committed to git |
| | `secrets-hardcoded` | OpenAI, Anthropic, Stripe, Google, Resend and GitHub keys in the code |
| | `secrets-public` | secrets in `NEXT_PUBLIC_` variables, which ship to every visitor |
| AI cost | `ai-auth` | API routes and server actions that call a model without checking who is calling |
| | `ai-limit` | model calls with no rate limit, credits or quota |
| | `models` | model IDs the provider has retired or deprecated |
| Payments | `stripe-webhook` | webhooks that don't verify the Stripe signature, or parse the body first |
| | `stripe-price` | checkout amounts or price IDs taken from the request |
| | `stripe-redirect` | success and cancel URLs built from the caller's Origin header |
| | `webhooks` | Lemon Squeezy, Paddle, Polar, Clerk, GitHub and other webhooks that don't verify the sender |
| Auth | `open-redirect` | `?next=` and similar parameters redirected to without a check |
| | `origin-links` | links built from the caller's Origin or Host header, a problem when they're emailed |
| | `supabase-session` | server code trusting `auth.getSession()` |
| Database | `supabase-rls` | tables without row level security, and policies that allow any write |
| | `supabase-rpc` | `SECURITY DEFINER` functions anyone can call through the API |
| | `supabase-tables` | tables the code queries that no migration creates |
| | `firebase-rules` | Firestore, Storage and Realtime Database rules that allow everyone, including expired test-mode rules |
| | `raw-sql` | SQL built by pasting values into the query text (Prisma `$queryRawUnsafe`, Drizzle `sql.raw`, pg, mysql2) |
| Code | `imports` | local and `@/` imports that point at nothing |
| | `precedence` | `a + "text" \|\| fallback`, where the fallback can never run |
| | `not-found` | dynamic pages that 500 instead of 404 on an unknown ID |
| | `error-pages` | missing `error` and `not-found` pages |
| | `image-proxy` | `next.config` letting `/_next/image` fetch from any host |
| | `env-example` | environment variables the code reads that `.env.example` doesn't list |

Run `npx whirlwindai --list` for the same list in the terminal.

## Supported setups

Any Next.js app: App Router or Pages Router, JavaScript or TypeScript, with or without `src/`, Next.js 13 to 16 (including `proxy.ts`). Import aliases are read from `tsconfig.json` or `jsconfig.json`, following `extends` into shared config packages. Checks for a service only run when the project uses it.

| | Recognised |
|---|---|
| AI | OpenAI, Anthropic, Gemini and Vertex, Vercel AI SDK (and OpenRouter), LangChain, LlamaIndex, Mastra, Groq, Mistral, Together, Cohere, Replicate, Hugging Face, fal, Bedrock, ElevenLabs, Ollama, and direct HTTP calls to OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, Together, Perplexity, xAI, DeepSeek, Fireworks and others |
| Auth | Supabase, Auth.js / NextAuth, Clerk, Kinde, Lucia, Better Auth, iron-session, Firebase, tRPC protected procedures, next-safe-action, middleware or `proxy.ts`, and helpers following the usual naming (`getUser`, `requireSession`, `ensureMember`, `withWorkspace`…) |
| Data | Supabase, Firebase, Prisma, Drizzle, raw pg and mysql2 |
| Payments | Stripe, Lemon Squeezy, Paddle, Polar |

**Monorepos:** run it on each app, for example `npx whirlwindai apps/web`. Run from the root, it lists the apps it found. Folders with their own `package.json` or `tsconfig.json` are treated as separate projects.

**Not Next.js:** the general checks (secrets, models, SQL, imports, database rules) still work; the route checks assume Next.js conventions.

## Options

```bash
npx whirlwindai ./path/to/app   # check another directory
npx whirlwindai --deep          # also confirm your keys can use every model ID in the code
npx whirlwindai --json          # machine-readable output
npx whirlwindai --quiet         # only show checks with findings
```

`--deep` reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GOOGLE_AI_API_KEY` (or `GEMINI_API_KEY`) from the environment, `.env.local` or `.env`, and asks each provider for the list of models that key can use. Each key is sent only to its own provider.

Exit codes: `0` clean, `1` problems, `2` warnings only. In CI, fail the build on problems:

```yaml
- run: npx whirlwindai
```

## Silencing a finding

Add a comment to the file naming the check and the reason:

```js
// whirlwind-check-ignore: ai-auth internal tool, behind the VPN
```

## What it doesn't do

It reads code; it doesn't run it. Each check is a pattern match tuned against real projects (including Vercel's AI chatbot, Commerce and SaaS starter, Dub, chatbot-ui, Taxonomy, Novel and the LangChain and LlamaIndex templates), so it can miss a problem written in an unusual way, and occasionally flag something that's fine. Build scripts, tests, scaffolds, examples, generated code and git submodules are skipped.

## Contributing

Found a false positive, or a mistake it should catch? [Open an issue](https://github.com/WhirlwindAI/whirlwindai/issues) with a minimal example. Run the tests with `npm test`.

## Whirlwind

[Whirlwind](https://whirlwindai.xyz) is a Next.js AI SaaS starter built for agent-driven development. It ships with all of this covered, plus 33 audit checks and 27 browser tests that your agent runs on every change.

## License

MIT
