# Shipday: pre-orders charged on the day they ship

Read first: `docs/COMMON-SPEC.md`, `docs/PAYPAL-API.md` (copied into this repo).

## Who
Indie board game publishers, small-batch hardware makers, and creators taking pre-orders. Charging at order time and shipping months later is how sellers get funds frozen and how buyers lose trust (@MystiqueMide: "PayPal has a rule most pre-order sellers find out about the hard way. You can only take the money if you ship within 20 days", naming Leder Games and Portal Games). First task in this build: find PayPal's current pre-order or delayed-shipment rule on paypal.com (user agreement, acceptable use, or help center), record the exact sentence and URL in `src/policy.ts`. If no PayPal page states a day count, the window is a merchant setting labelled "charge no earlier than N days before ship date", default 20, with no claim that PayPal requires it.

## What it does (core loop, all real)
1. **Merchant creates a campaign**: product name, image, price, currency, quantity, estimated ship date, charge window days.
2. **Buyer reserves** at `/p/:slug`: "Reserve with PayPal. You are charged only when your unit ships." Flow: Vault v3 setup token (no charge) → PayPal approval → return URL → create payment token → reservation row `{vault_id, customer_id, email, qty, position}`. Read back the payment token (GET) before marking RESERVED. Buyer can cancel any time before charge: deletes the payment token on PayPal and confirms.
3. **Supply updates in, plan out**: merchant pastes a factory or freight email, or uploads a PDF/photo of a packing list or bill of lading. AI extracts `{units, milestone (production_complete | departed | arrived_port | arrived_warehouse | delayed), date or eta, origin, destination, vessel_or_carrier?, quotes: [exact source sentences], confidence}` zod-validated, each field linked to its quote. Merchant confirms. Deterministic planner turns confirmed updates into shipping waves: units allocated to reservations in reservation order, each wave with an expected ship date.
4. **Bryntum Gantt** timeline (use `@bryntum/gantt` trial package for React; verify the npm package name and that it installs; follow Bryntum's React integration guide): rows per wave with bars for production, freight, warehouse, the charge window, and the ship date; dependencies between them; dragging a ship date re-plans (planner re-runs, charge windows move). This is the merchant's main screen, not a garnish.
5. **Charge a wave**: only reservations whose wave ship date falls inside the charge window are chargeable; the button is disabled otherwise with the reason. Charging creates a merchant-initiated Orders v2 order per reservation with `vault_id`, captures if needed, reads back the capture as COMPLETED, stores capture id. Declines are recorded per reservation (status, PayPal error issue) and surfaced; the merchant can retry or skip. Idempotent: a reservation can never be charged twice (unique constraint on reservation id + persisted `PayPal-Request-Id`).
6. **Mark shipped**: per wave, merchant enters tracking per reservation or one carrier + list; posted to each order via `/v2/checkout/orders/{id}/track` and read back.
7. **Buyer status page** `/r/:reservationId`: where their unit is in the plan, when they will be charged, receipt once charged.

## AI usage (visible in UI and README)
Supply document understanding (email text, PDF, photo) into structured milestones with exact source quotes; planner explanations ("Wave 2 moves 9 days later because the 14 Mar email says the vessel was rolled") generated from the confirmed data only.

## Deterministic rules with unit tests
Allocation of units to reservations, wave ship date computation from milestones and configurable lead times, charge eligibility window, idempotent charge guard, cancel-before-charge, re-plan after date change.

## Smoke (`npm run smoke`, real sandbox)
Creates a campaign, creates a setup token and prints the approval URL, waits (up to 10 min) for the operator to approve with a sandbox buyer, creates the payment token and GETs it, confirms a supply update through the same service the UI uses, plans a wave inside the window, charges it, asserts the capture reads COMPLETED, then asserts a second charge attempt is refused locally. Flag `--resume <setupTokenId>`.

## One-minute judge path
Open hosted URL → reserve the live campaign with the sandbox buyer (no charge, PayPal approval only) → merchant view: paste the sample freight email from the repo's `examples/` (a real-format email the operator writes, clearly labelled example input) → Gantt updates → charge the wave → capture COMPLETED appears on the reservation.

## Visual language
A production schedule pinned on a factory wall: grid paper, manifest typography (condensed sans + monospace for dates and quantities), one signal orange accent for "charge window open", muted blues for freight. The Gantt dominates the merchant screen. Buyer page is calm and trustworthy: big date, plain sentence about when the charge happens.

## Env (product specific)
`DEMO_BUYER_EMAIL`, `BRYNTUM_LICENSE` (optional, trial works without it).
