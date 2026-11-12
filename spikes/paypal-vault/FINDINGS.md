Claim: One authenticated PayPal sandbox app can create a Vault v3 setup token, issue a payment token after buyer approval, and create a merchant-initiated Orders v2 payment that reads back COMPLETED.
Verdict: UNTESTED. The PayPal client ID and secret are absent, and no authenticated merchant account can be used.
Measured: `POST https://api-m.sandbox.paypal.com/v3/vault/setup-tokens` without Authorization returned HTTP 401 AUTHENTICATION_FAILURE. Command: `curl -sS -o /tmp/shipday-paypal-negative.json -w '%{http_code}' -X POST https://api-m.sandbox.paypal.com/v3/vault/setup-tokens -H 'Content-Type: application/json' -d '{}'`.
Negative case: The missing-Authorization request was rejected with HTTP 401. This proves the real endpoint rejects unauthenticated calls, not that an authorized Vault or charge flow succeeds.
Caveat: PayPal says merchants must be approved and configured for saving PayPal wallets; eligibility and sandbox behavior remain account-specific. The setup token expires after three days by default.
Blocks product: no, per the requested scope to implement the real integration and leave the sandbox smoke unexecuted when credentials are unavailable.

Live sources checked before implementation:
- PayPal Seller Protection, https://www.paypal.com/us/legalhub/paypal/seller-protection?locale.x=en_US. It says: "If the sale involves pre-ordered or made-to-order goods, you must ship within the timeframe you specified in the listing. Otherwise, it is recommended that you ship all items within 7 days after receipt of payment." This is a Seller Protection condition, not a universal 20-day rule.
- PayPal Vault no-purchase flow, https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal. Confirms setup-token, payment-token, readback, delete, and Orders v2 paths.
- PayPal Payment Method Tokens v3 API, https://developer.paypal.com/api/payment-tokens/v3/.
