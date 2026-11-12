# Shared build contract (applies to Dibs, Postmark, Shipday)

## Stack (do not deviate)
- Node 24, TypeScript, ESM. Server: Hono + @hono/node-server. Validation: zod v4.
- Storage: `node:sqlite` (built in, `DatabaseSync`), file at `DATA_DIR/app.db` (default `./data`). Migrations in code, idempotent.
- Frontend: Vite + React + TypeScript in `web/`, built to `web/dist`, served by Hono in production. One process, one port (`PORT`, default 8787).
- Live updates: Server-Sent Events from Hono (`/api/events`), not polling from the browser.
- AI: OpenRouter chat completions (`https://openrouter.ai/api/v1/chat/completions`, `OPENROUTER_API_KEY`), model from env `AI_MODEL` default `google/gemini-2.5-flash` (vision capable). Request JSON output (`response_format: {type:"json_schema", ...}`), then validate with zod. On invalid output: one retry with the zod error appended, then surface a typed error to the UI. Never invent values when the model fails.
- Reference implementation of the OpenRouter vision call + zod parsing exists at `/Users/kamal/Desktop/shelfscan/api/src/openrouter.ts` and `schema.ts`. Read it and adapt; do not import across repos.
- PayPal: hand-written typed client in `src/paypal.ts` over `fetch` (no SDK), per `docs/PAYPAL-API.md`. Token cache, `PayPal-Request-Id` persisted per operation, `paypal-debug-id` logged on errors, typed error class.
- Tests: vitest. Deploy: `render.yaml` (one web service, `npm ci && npm run build`, `npm start`, persistent disk at `/var/data` mounted as `DATA_DIR`).

## Env (write `.env.example` with names and one-line comments, never values)
`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox`, `PAYPAL_WEBHOOK_ID` (optional), `OPENROUTER_API_KEY`, `AI_MODEL`, `PUBLIC_URL` (for PayPal return URLs, default `http://localhost:8787`), `DATA_DIR`, plus product-specific ones.
Load `.env` with `node --env-file-if-exists=.env`. `.env` is gitignored. Never log, echo, or commit secret values.
If PayPal or OpenRouter env is missing, the app still boots and every page shows a clear setup panel naming the missing variable. Never fall back to fake data.

## Non-negotiables
- Production code only. No mocks, stubs, placeholder data, seeded fake listings, `TODO` in shipped code. Every value shown in the UI comes from PayPal, the AI call, or the user.
- Money math in integer cents. Currency strings formatted only at the edge.
- Every PayPal mutation: idempotent, persisted before and after, followed by a read-back that proves the terminal state (an id or a 201 is not completion).
- Unit tests for every deterministic rule (parsers, matchers, fee math, state machines), each must be able to fail: include at least one negative case per rule.
- `npm run smoke`: a script that runs the product's core money loop against the real PayPal sandbox and exits non-zero unless the terminal post-condition is observed (poll with timeout). It prints each PayPal id and status it observed. If env is missing it exits 2 with the missing names.
- `npm run typecheck`, `npm test`, `npm run build` must pass.
- Copy and docs: no em dash character anywhere (use commas, periods, colons). No prize amounts. No line counts.
- README is a pitch in present tense: what it does, who it is for, the PayPal APIs and AI it uses, how to run (local + Render), how to judge it in one minute. No "limitations", "roadmap", "known issues" headings. Gaps go to `.progress/LEDGER.md` (gitignored).
- `LICENSE`: MIT, copyright 2026 Kamal.
- Accessibility basics: labels on inputs, focus states, color contrast AA, keyboard reachable.

## Design bar
Not a template. No purple gradients, no glassmorphism cards, no emoji icons, no generic hero with three feature cards. The visual language must come from the user's world (stated per product). Real typography pairing via Google Fonts or system stacks, a restrained palette with one accent, dense information where the user works. Mobile first for any screen a seller uses in the field.

## Done means
1. `npm run typecheck && npm test && npm run build` green.
2. App boots with `npm start`; without env it shows the setup panel (verify with curl on `/api/health` returning `{ok:true, missing:[...]}`).
3. With env present, `npm run smoke` reaches the terminal PayPal state. If you lack credentials in your environment, still write the smoke script fully and report that it was not executed.
4. Write `BUILD-REPORT.md` (gitignored is fine) listing what you ran and the output tails.
Do not commit; the orchestrator commits.
