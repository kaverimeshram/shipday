# Shipday: what we steal

## Visual thesis

The merchant screen is a factory production schedule drawn on grid paper where the Gantt fills the screen, the buyer page is a calm receipt with one big date and one plain sentence about when the charge happens, and a single signal orange appears only where a charge window is open.

## Measured tokens to adopt

| Token | Value | Source |
|---|---|---|
| Chart surface (grid paper) | #fdfdfd | Frappe Gantt chart panel (PNG) |
| Off-day column tint | #f7f7f7 | Frappe Gantt weekend columns (PNG) |
| Buyer page background | #fbfbfa | Kickstarter page bg (PNG) |
| Money-rule strip | #f5f2ec | Kickstarter "You're only charged if" strip (PNG) |
| Ink | #282828 | Kickstarter h1 `rgb(40,40,40)` (tokens) |
| Today line and today chip | #373530, 1px line full chart height | Frappe Gantt (PNG) |
| Charge window accent | signal orange, one job only | Shipday choice; placement copied from Frappe today line and Flighty phase chip #eec041 |
| Row height | 48px | Frappe `.grid-row` height (DOM) |
| Bar height and radius | 30px, rx 3px | Frappe `rect.bar` (DOM) |
| Day column width | 45px at day zoom | Bryntum and Frappe both 45px (PNG) |
| Time header | two tiers: week label over day letters | Bryntum header (PNG) |
| Wave rail | thin parent summary bar above its orders, diamond marker on charge day | Bryntum parent bars and milestone (PNG) |
| Buyer primary button | square corners (4px), full column width, about 46px tall | Kickstarter "Back this project" 392px wide, radius 4px (tokens + PNG) |
| Charge sentence under button | 12px to 13px, leading 18px, absolute date and time zone | Kickstarter p 12px/18px (tokens); BackerKit "Ends on Nov 14, 2026 at 6:30am IST." |
| Big date display | negative tracking, about -1px at 64px | Flighty h1 65px tracking -1px (tokens); PreProduct h1 64.8px tracking -1.296px (tokens) |
| Status line | bold 16px title over a 15px grey sentence with the time inside it | Flighty notification cards (PNG) |
| Label over value facts | 13px label over 15px value, no card | Shopify listing left rail (PNG) |
| Serif option for the big date | Newsreader, 40px weight 500 measured | Frappe page h1 (tokens) |

Type faces are locked in DESIGN.md. Every reference here ships Inter or system sans for body; Shipday must not.

## Hero moment

The merchant drags Wave 2's bar on the Gantt so its ship day lands inside this week. The orange charge-window line sweeps down across that wave's rows, the wave rail turns orange, and the button on the rail changes from "Plan" to "Charge Wave 2, 148 orders". One click; each row fills left to right as its PayPal charge comes back, and the buyer pages for those orders now read "Charged today. Shipping today."

## Copy for the 5 key buttons and states

1. Buyer primary button: **Save PayPal. Pay when it ships.**
   Under it: "Nothing is charged today. We charge your PayPal on the day your order ships, planned for 14 March."
2. Buyer state after saving: **Saved. Not charged yet.**
   "Your order is in Wave 2, shipping around 14 March. We will email you the day we charge."
3. Merchant wave button when the window opens: **Charge Wave 2 (148 orders)**
   Disabled before the window: "Charging opens 3 days before ship day."
4. Merchant state after charging: **Charged 146 of 148. Ready to pack.**
   The two failures stay orange on their rows: "PayPal declined. Buyer emailed to update payment."
5. Buyer state on ship day: **Charged today. Shipping today.**
   "We charged your PayPal $110.00 on 14 March. Tracking arrives by email."

## Never

- Big number plus small label stacks (Kickstarter, BackerKit funding columns).
- Electric blue pills (#2e2ef5), lavender washes, 900-weight purple display type.
- Default dark Bryntum theme.
- Centered headline with a pill CTA pair (see `negative/`).
