# PayPal REST reference for builders (sandbox)

Treat this as a starting map, not gospel. Before relying on any field, fetch the live doc
(markdown versions exist: append `.md` to most developer.paypal.com doc URLs, e.g.
https://developer.paypal.com/track-orders.md) and, above all, run the call against the sandbox.
If the sandbox returns 400/422, read `details[].issue` and fix the payload. Never guess silently.

Base URL: `https://api-m.sandbox.paypal.com` when `PAYPAL_ENV=sandbox` (default), `https://api-m.paypal.com` when `live`.
Browser approval URLs use `https://www.sandbox.paypal.com` in sandbox.

## Auth
`POST /v1/oauth2/token`, `Authorization: Basic base64(PAYPAL_CLIENT_ID:PAYPAL_CLIENT_SECRET)`,
`Content-Type: application/x-www-form-urlencoded`, body `grant_type=client_credentials`.
Returns `{access_token, expires_in}`. Cache until `expires_in - 60s`.

Every API call: `Authorization: Bearer <token>`, `Content-Type: application/json`.
Every POST that creates or moves money: header `PayPal-Request-Id: <uuid>`; persist the uuid with the
logical operation so a retry reuses it (PayPal dedupes). Never generate a fresh id on retry.
Log `paypal-debug-id` response header on every non-2xx.

## Invoicing v2
- Create: `POST /v2/invoicing/invoices` with `Prefer: return=representation`.
  ```json
  {"detail":{"currency_code":"USD","note":"...","payment_term":{"term_type":"DUE_ON_RECEIPT"}},
   "primary_recipients":[{"billing_info":{"email_address":"buyer@example.com"}}],
   "items":[{"name":"#3 Charizard ex","quantity":"1","unit_amount":{"currency_code":"USD","value":"60.00"},"unit_of_measure":"QUANTITY"}],
   "configuration":{"allow_tip":false,"partial_payment":{"allow_partial_payment":false}},
   "amount":{"breakdown":{"shipping":{"amount":{"currency_code":"USD","value":"5.00"}}}}}
  ```
  Omit `invoicer.email_address` unless it equals the sandbox business account email (mismatch = 422).
- Send: `POST /v2/invoicing/invoices/{id}/send` `{"send_to_recipient":true,"send_to_invoicer":false,"subject":"...","note":"..."}`.
  Payer link: response `href`/`links[rel=payer-view]`, or `GET` invoice `detail.metadata.recipient_view_url`.
- Read: `GET /v2/invoicing/invoices/{id}` → `status` in DRAFT, SENT, SCHEDULED, PAID, MARKED_AS_PAID, CANCELLED, REFUNDED, PARTIALLY_PAID, UNPAID, PAYMENT_PENDING.
- Cancel (sent invoices): `POST /v2/invoicing/invoices/{id}/cancel` `{"send_to_recipient":true,"send_to_invoicer":false,"subject":"...","note":"..."}` → 204. Draft invoices: `DELETE /v2/invoicing/invoices/{id}`.
- Remind: `POST /v2/invoicing/invoices/{id}/remind`.
- QR: `POST /v2/invoicing/invoices/{id}/generate-qr-code` `{"width":300,"height":300}` (body is base64 image text; inspect and handle).
- Deposit: `configuration.partial_payment = {allow_partial_payment:true, minimum_amount_due:{currency_code,value}}`.
- Webhooks: `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`.

## Orders v2
- Create: `POST /v2/checkout/orders`
  ```json
  {"intent":"CAPTURE","purchase_units":[{"reference_id":"...","amount":{"currency_code":"USD","value":"25.00"}}],
   "payment_source":{"paypal":{"experience_context":{"return_url":"...","cancel_url":"...","user_action":"PAY_NOW","shipping_preference":"GET_FROM_FILE","brand_name":"..."}}}}
  ```
  Approval URL: `links[rel=payer-action]`.
- Capture: `POST /v2/checkout/orders/{id}/capture` → `purchase_units[0].payments.captures[0].id`, buyer address at
  `purchase_units[0].shipping.address` (`address_line_1`, `address_line_2`, `admin_area_2` city, `admin_area_1` state, `postal_code`, `country_code`) and `shipping.name.full_name`.
- Read: `GET /v2/checkout/orders/{id}`.
- Tracking: `POST /v2/checkout/orders/{id}/track`
  `{"capture_id":"...","tracking_number":"...","carrier":"USPS","notify_payer":false}` (carrier enum: USPS, UPS, FEDEX, DHL, ONTRAC, ... or `OTHER` + `carrier_name_other`).
  Verify by `GET` order and finding the tracker under `purchase_units[0].shipping.trackers`.
  Doc: https://developer.paypal.com/api/orders-v2/track-orders/integrate/

## Disputes v1
- List: `GET /v1/customer/disputes?dispute_state=REQUIRED_ACTION` (also `disputed_transaction_id=`).
- Read: `GET /v1/customer/disputes/{id}` → `reason` (MERCHANDISE_OR_SERVICE_NOT_RECEIVED, MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED, UNAUTHORISED, ...), `status`, `dispute_life_cycle_stage`, `seller_response_due_date`, `disputed_transactions[].seller_transaction_id` (= capture id), `links` (available actions).
- Evidence: `POST /v1/customer/disputes/{id}/provide-evidence`, `multipart/form-data`: part `input` (JSON)
  `{"evidences":[{"evidence_type":"PROOF_OF_FULFILLMENT","evidence_info":{"tracking_info":[{"carrier_name":"USPS","tracking_number":"..."}]},"notes":"..."}]}`
  plus file parts (jpg/png/pdf, ≤10 MB each).
- Sandbox only: `POST /v1/customer/disputes/{id}/require-evidence` `{"action":"SELLER_EVIDENCE"}`; `POST /v1/customer/disputes/{id}/adjudicate` `{"adjudication_outcome":"SELLER_FAVOR"}`.
- Creating a sandbox dispute: sandbox buyer logs into https://www.sandbox.paypal.com, opens the transaction, Resolution Center, "Report a problem".
- Webhook: `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`.
- Doc: https://developer.paypal.com/docs/api/customer-disputes/v1/

## Vault v3 (save PayPal without charging, charge later merchant-initiated)
Sandbox app must have Vault enabled (Developer Dashboard → app → Features → Vault).
- Setup token: `POST /v3/vault/setup-tokens`
  `{"payment_source":{"paypal":{"description":"...","usage_type":"MERCHANT","customer_type":"CONSUMER","usage_pattern":"DEFERRED","permit_multiple_payment_tokens":false,"experience_context":{"return_url":"...","cancel_url":"...","brand_name":"...","shipping_preference":"GET_FROM_FILE"}}}}`
  → `id`, `status: PAYER_ACTION_REQUIRED`, `links[rel=approve]`. Verify enum names against https://developer.paypal.com/docs/api/payment-tokens/v3/.
- After approval (return_url): `POST /v3/vault/payment-tokens` `{"payment_source":{"token":{"id":"<setup token id>","type":"SETUP_TOKEN"}}}` → `id` (vault id), `customer.id`, `payment_source.paypal.email_address`.
- Charge later: `POST /v2/checkout/orders` with `"payment_source":{"paypal":{"vault_id":"...","stored_credential":{"payment_initiator":"MERCHANT","usage":"SUBSEQUENT"}}}`.
  If returned status is not COMPLETED, capture it. Read final capture status; COMPLETED is the only success.
- Delete: `DELETE /v3/vault/payment-tokens/{id}`.
- Guide: https://developer.paypal.com/docs/checkout/save-payment-methods/

## Webhook verification
`POST /v1/notifications/verify-webhook-signature` with `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time` (from `PAYPAL-*` headers), `webhook_id` (env `PAYPAL_WEBHOOK_ID`), `webhook_event` (raw parsed body) → `verification_status: SUCCESS`. Reject otherwise.
Always also run a polling reconciler so the app reaches terminal state without webhooks (local runs have no public URL).
