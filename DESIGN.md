# Shipday interface contract

/* Hallmark pre-emit critique: Philosophy 5, Hierarchy 5, Execution 4, Specificity 5, Restraint 5, Variety 4. Merchant work screen. Contrast checked against WCAG AA intent; verify rendered states before release. */

Adapted from the warm workflow-paper direction in the Zapier system in the local design library. Shipday uses a pinned factory schedule, a ruled working surface, and restrained ink. Freight and charge timing carry the only strong color.

## Tokens

- Display: Barlow Condensed, 600 and 700, loaded from Google Fonts.
- Body: IBM Plex Sans, 400 and 600, loaded from Google Fonts.
- Data: IBM Plex Mono, 400 and 500, loaded from Google Fonts.
- Ink: `#202522`; secondary ink: `#47514c`; muted text: `#626d67`.
- Paper: `#f5f2e9`; raised paper: `#fffdf7`; rule: `#d5d1c5`.
- Freight blue: `#476c83`; signal orange: `#c84b22`; success green: `#286646`; danger red: `#9d3025`.
- Accent text: `#fffdf7`; warning panel: `#fff1e9`.
- Radius: 2 px controls, 4 px panels, no pill cards.
- Spacing: 4, 8, 16, 24, 32, 48, 64 px.
- Type scale: 12, 14, 16, 20, 28, 40, 56 px.

## Structure and states

- Merchant schedule is the main surface. Supply evidence and reservation status sit beside it, then stack on narrow screens.
- Warm paper grid is a low-contrast working surface, not decoration. Keep a 1 px outline in rest, hover, focus, and error states.
- Orange marks an open charge window and its primary action. Blue marks freight. Green marks completed shipment. Red marks a blocked or failed operation.
- Dates, reservation identifiers, quantities, prices, and PayPal capture identifiers use the mono face and tabular numerals.
- Every form has a visible label, a persistent helper/error slot, and a 2 px focus outline with 1 px offset.
- Buttons have primary, outlined secondary, and quiet text treatments. Disabled actions use native `disabled`, reduced opacity, and a not-allowed cursor.
- Buyer pages use the same paper and ink, one prominent ship date, and plain language for charge timing.

## Copy constraints

- Explain the merchant-configured charge window without presenting it as a PayPal rule.
- Never state that a reservation is charged until the PayPal Orders readback reports a completed capture.
- Never imply an AI extraction is confirmed before the merchant reviews it.
