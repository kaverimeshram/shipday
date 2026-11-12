# Shipday

Shipday gives independent publishers and small-batch makers a shipping plan for pre-orders. Buyers save PayPal at reservation time. Merchants confirm production or freight updates, allocate units into shipping waves, and charge each reservation when its wave enters the configured charge window. When a charged wave slips past that window, Shipday refunds it through PayPal and charges the same saved PayPal again when the new window opens. On ship day, AI reads the warehouse dispatch email into PayPal tracking for every order.

The buyer gets one clear ship date and a private reservation page. The merchant gets a live production schedule, source-linked supply extraction, per-reservation PayPal outcomes, and tracking confirmation.

## Judge Shipday in one minute

Live app: https://shipday-preorders.fly.dev

1. Create a campaign: any product, price and quantity, estimated ship date 3 December 2026, and keep the default 20-day charge window (a merchant setting; see `src/policy.ts`). Shipday opens the merchant plan for it. The merchant plan opens only in the browser that created the campaign.
2. Open its buyer link, `/p/<slug>`, and reserve with a PayPal sandbox buyer. PayPal saves the wallet through Vault. Nothing is charged.
3. In the merchant plan, paste `examples/freight-update-example.txt` into Supply in and press Read update. Each extracted field (480 units, departed, 12 Nov, Yantian, Long Beach, MSC ARIANE) sits beside the sentence it came from. Confirm it.
4. Wave 1 lands on the Gantt with ship day 3 December: the 12 Nov departure plus the 21 day freight lead. The orange bar is the open charge window. Drag the Ship bar into the past and the charge button locks with the reason; drag it forward and the window reopens.
5. Charge Wave 1. Each reservation shows its PayPal capture id once PayPal reads the capture back as COMPLETED, and the buyer's `/r/<id>` page becomes a receipt.
6. Turn on Auto-protect in the merchant plan, then drag the charged wave's Ship bar more than 20 days past the charge date (the campaign's charge window). Shipday asks you to confirm before any money moves: "1 buyer ($48.00)", the old and new ship dates, and a 60 second hold. Press Confirm and the undo window counts down with nothing sent to PayPal yet; Undo drag inside it puts the ship date back and no refund is created. Let the hold run out and Shipday refunds each late charge through PayPal on its own, reads the refund back as COMPLETED, shows the refund id on the reservation, and keeps the buyer reserved on the same saved PayPal. The buyer page reads "Refunded. Still reserved." Drag the bar back and charge again.
7. Paste `examples/dispatch-confirmation-example.txt` into Read dispatch confirmation. Order #1's carrier and tracking number fill in with the email line they came from. Save, and Shipday posts the tracker to the PayPal order and reads it back.

## PayPal and AI

Shipday uses PayPal Vault v3 setup tokens and payment tokens to save buyer-approved PayPal wallets without charging at reservation. It uses Orders v2 for merchant-initiated captures and order tracking, and Payments v2 to refund and read back any capture whose wave slips outside its charge window. Mutations use persisted PayPal request IDs and read back their resulting state.

OpenRouter reads supplier emails, PDFs, and photos into validated production or freight milestones. Every extracted field is shown with a source quote for merchant review. Carrier and warehouse dispatch emails become per-parcel tracking numbers, each one required to appear inside a verbatim line of the email before it reaches PayPal. Plan explanations use only confirmed milestones, dates, and quotes. The schedule and reservation allocation rules are deterministic.

## Run locally

Requirements: Node.js 24 and npm.

```sh
npm ci
cp .env.example .env
```

Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `OPENROUTER_API_KEY` in `.env`. Keep PayPal in sandbox while developing. Set `PUBLIC_URL` to the origin that serves the app, port 8787 by default, so PayPal returns buyers to it. `BRYNTUM_LICENSE` is optional for the trial package.

```sh
npm run typecheck
npm test
npm run build
npm start
```

Open the app on port 8787. The server serves the Vite build and API from the same port. Without service credentials, the app still starts and identifies missing environment variables. `/api/health` reports its health and missing configuration. Set `DATA_DIR` to choose the SQLite data directory.

To run the real PayPal sandbox smoke workflow, also set `DEMO_BUYER_EMAIL` and `SMOKE_SUPPLY_FILE` to a real supplier source document, then run:

```sh
npm run smoke
```

The smoke workflow waits for an operator to approve the sandbox reservation, then checks the saved payment token, supply allocation, completed capture, and local refusal of a duplicate charge.

## Deploy

### Fly.io

The repository includes `fly.toml` and a production Dockerfile. Configure secrets with `fly secrets set` for `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `OPENROUTER_API_KEY`. Keep `PAYPAL_ENV=sandbox` until the merchant's PayPal setup is ready for live use. The Fly volume stores SQLite data at `/data`.

```sh
fly deploy
```

The configured public origin is `https://shipday-preorders.fly.dev`. Update `PUBLIC_URL` and the app name in `fly.toml` if deploying under a different Fly app.

### Render

Create a Blueprint from this repository using `render.yaml`. Render builds with `npm ci && npm run build`, starts with `npm start`, and mounts the persistent disk at `/var/data`. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `OPENROUTER_API_KEY`, and `PUBLIC_URL` in the service environment before opening buyer reservations.

## Product policy

Shipday's default 20-day charge window is a merchant setting, not a universal PayPal timing rule. The buyer page links to the current PayPal Seller Protection policy and preserves its wording in context.
