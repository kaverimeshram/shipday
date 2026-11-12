# Shipday design references

Captured 2026-11-12 with `refshot.py` in the signed-in deepsurge profile. Every PNG below was opened and inspected. Hex values marked "PNG" were sampled from the screenshot pixels; everything else is from the matching `.tokens.json`.

Direct competitors (same job: take a pre-order or pledge now, charge and ship later): PreProduct, Shopify App Store listing for PreProduct, Kickstarter, BackerKit. Schedule references: Bryntum Gantt (the component Shipday ships on), Frappe Gantt. Outside the domain: Flighty (plain-sentence status, one time that matters).

## Bryntum Gantt basic demo

- URL: https://bryntum.com/products/gantt/examples/basic/
- Screen: the live Gantt product screen Shipday is built on. Left tree grid of tasks, right time axis with week header (Sun 11 Jan 2026) over single-letter day columns, task bars, parent summary bars, dependency arrows, one milestone diamond.
- Screenshots: `design-research/refs/bryntum-gantt-1440.png`, `design-research/refs/bryntum-gantt-390.png`
- Measured: body bg `rgb(32,32,32)` #202020 (tokens), grid panel #1a1a1a (PNG), outer page #24272e (PNG), column divider #474747 (PNG). Font Montserrat; h1 15.4px weight 600; body 14px; "Learn" button 12.6px weight 500, radius 7.56px, padding 0 12.6px. Row pitch 45px measured from PNG (row tops at y 161, 206, 251). Leaf bars about 24px tall, green #3c5e37; parent summary bars thin, blue #2d527e; milestone diamond blue #2d527e. Day columns 45px wide at this zoom.
- Regions: tree column 330px wide with chevrons and bullet leaves; week header row then day-letter row; bars sit centered in rows; finish-to-start arrows route in thin grey elbows.
- Steal: (1) the two-tier time header, week label over day letters, so a wave's ship date reads at a glance; (2) parent summary bar as a thin rail above its children, which maps to a shipping wave containing its orders; (3) the milestone diamond as the "charge day" marker on each wave.
- Avoid: the default dark theme with muddy green and navy bars. It reads as an IDE. Shipday re-skins the same component onto light grid paper.

## PreProduct homepage

- URL: https://preproduct.io/
- Screen: marketing hero of the leading Shopify pre-order app, with a product mock showing charge-mode chips (Capture Only, Charge Later, Deposit Upfront, Charge Upfront) and a USD $110.00 line.
- Screenshots: `design-research/refs/preproduct-1440.png`, `design-research/refs/preproduct-390.png`
- Measured: page bg #ffffff with a faint square grid behind the hero (PNG). h1 system sans 64.8px weight 900, tracking -1.296px, leading 67.392px, color `rgb(19,0,65)` #130041. h3 50px weight 900 tracking -0.5px. Body 14px leading 25.2px color `rgb(61,70,77)`. Primary button "Start For Free" 13px weight 500, bg `rgb(33,42,47)` #212a2f, radius 5px, padding 2px 10px. Highlighter swash behind "built to scale" in pale yellow #fcf1bf (PNG). Counter pill in uppercase tracked small caps: "1,986,245 PRE-ORDERS PROCESSED".
- Regions: eyebrow counter, four-line headline with italic middle line, body paragraph, Shopify install pill button, floating product renders.
- Steal: (1) the faint background grid, proof that grid paper already reads as "operations" in this category; (2) the headline promise "Charged and fulfilled when you say so", which is the exact Shipday claim; Shipday should state it in one plain sentence on the buyer page; (3) naming the charge mode in plain words on a chip (Charge Later) rather than a payments term.
- Avoid: 900-weight purple-black display type and the lavender radial wash in the top right. That is the generic Shopify-app look we are separating from.

## Shopify App Store: PreProduct pre-order listing

- URL: https://apps.shopify.com/preproduct
- Screen: the app listing a merchant compares side by side with Shipday. Left rail with pricing, rating 4.9 (108), developer and a black Install button; center video plus three screenshot thumbs; feature bullets; pricing cards.
- Screenshots: `design-research/refs/shopify-preproduct-1440.png`, `design-research/refs/shopify-preproduct-390.png`
- Measured: font Inter var. h1 18px weight 650 leading 24.304px. Description p 16px weight 450, leading 23.2px, color `rgb(86,82,78)` #56524e. Search input bg `rgb(250,250,249)` #fafaf9, radius 32px. Pricing section band #fafaf9 (PNG). Install button black, full rail width 304px, pill radius (PNG).
- Regions: the bullet list is the competitor feature set: charge upfront, later on a vaulted card, or deposit; "Fulfilment holds: nothing ships until you say so"; list pre-orders manually, in bulk or automatically; customer portal and emails.
- Steal: (1) their vocabulary, "vaulted card" and "nothing ships until you say so", confirms buyers and merchants already accept save-now-charge-later; Shipday says it plainer; (2) the left rail of label-over-value facts (Pricing / Rating / Developer), 13px label over 15px value, as the pattern for an order summary on the buyer page; (3) parity: competitor charges per order manually or in bulk, Shipday charges per wave from the schedule, which is the visible difference to show.
- Avoid: warm grey body copy at weight 450 on white for anything important. The charge sentence must be full black.

## Kickstarter live campaign: Interface Ring

- URL: https://www.kickstarter.com/projects/rollingsquare/interface-ai-smart-ring-for-voice-notes-agents-and-health
- Screen: live pledge page for a hardware product. Video left, funding column right: US$ 321,615 pledged of US$ 20,000 goal, 2,118 backers, 38 days to go, green "Back this project", "Remind me", then the all-or-nothing sentence with a full date.
- Screenshots: `design-research/refs/kickstarter-1440.png`, `design-research/refs/kickstarter-390.png`
- Measured: font Inter. h1 24px weight 700 leading 30px color `rgb(40,40,40)` #282828. Body 14px leading 21px. Small print p 12px leading 18px. Nav button 16px weight 500, tracking -0.4px, radius 4px, padding 11px 15px. Input radius 8px padding 12px. Page bg #fbfbfa (PNG); trust strip bg #f5f2ec (PNG); primary button and progress bar green #3b865c / #469c77 (PNG). Primary button is a square-cornered block about 46px tall, full column width 392px.
- Regions: right column stacks big figure then small label three times; under the button, one sentence: "This project will only be funded if it reaches its goal by Sun, December 20 2026 10:35 PM UTC +05:30." Below the fold a three-up strip including "You're only charged if the project meets its funding goal by the campaign deadline."
- Steal: (1) the charge-condition sentence placed directly under the primary button, with an absolute date and time zone; Shipday's buyer page uses the same placement for "We charge your PayPal when your wave ships, around 14 March"; (2) the quiet warm strip #f5f2ec that explains the money rule in plain words; (3) a square-cornered full-width primary button, no pill.
- Avoid: three stacked big-number stats. That is the big-metric template; the buyer cares about one date, not backer counts.

## BackerKit live campaign: Between Earth and Sky

- URL: https://www.backerkit.com/c/projects/monte-cook-games/between-earth-sky-the-roleplaying-game
- Screen: live crowdfunding and pre-order campaign on BackerKit, the pledge manager that turns backers into shipped orders. Title card, video, creator block ("28 projects fulfilled"), $125,266 of $50,000, 764 backers, 46 hours left, blue "Back It", "Ends on Nov 14, 2026 at 6:30am IST."
- Screenshots: `design-research/refs/backerkit-1440.png`, `design-research/refs/backerkit-390.png`
- Measured: h1 GT Walsheim Medium 30px weight 500 leading 36px #000000. Supporting p Inter 14px weight 700 leading 20px color `rgb(69,69,69)`. Body 16px leading 24px. Page bg #f5f5f4 (PNG), cards #ffffff with 1px hairline border and about 12px radius (PNG). Primary "Back It" bg #2e2ef5 (PNG), pill, about 48px tall. Search input bg `rgb(247,247,247)`, pill radius, padding 6px 40px 6px 16px.
- Regions: header card, media left, facts column right, sticky sidebar repeats Back It below the fold; tabs Story, Pledge Levels, Add-ons, Updates, Community, FAQ.
- Steal: (1) "28 projects fulfilled" as a trust line about the merchant's shipping record, a better trust signal than a badge; Shipday can show "3 of 5 waves shipped" for the merchant; (2) the deadline line under the button in 13px grey with full date and time zone; (3) the tab set ordering, where Updates sits next to the pledge, mapped to Shipday's "where is my wave" status.
- Avoid: saturated electric blue #2e2ef5 pill buttons and emoji confetti beside the money figure.

## Frappe Gantt live demo

- URL: https://frappe.io/gantt
- Screen: interactive Gantt embedded on the product page; November header, day numbers 05 to 29 with today (12) in a dark chip, a vertical today line, weekend columns shaded, light bars with progress fill and labels inside or beside the bar, elbow dependency arrows.
- Screenshots: `design-research/refs/frappe-gantt-1440.png` (1440x1500 viewport so the chart is in frame), `design-research/refs/frappe-gantt-390.png`
- Measured: chart panel bg #fdfdfd, weekend column #f7f7f7, bar fill #dbdbdb, today chip and today line #373530 (all PNG). Grid row height 48px and bar rect height 30px, rx 3px (DOM `.grid-row` and `rect.bar`). Bar label 13px. "Today" button 14px weight 420, tracking 0.28px, bg `rgb(243,243,243)`, radius 8px, padding 5px 8px. Day columns 45px wide (PNG). Page around it bg `rgb(23,23,23)`, h1 Newsreader 40px weight 500.
- Regions: header row month name left, Today button right; day ruler; rows with hairline separators; arrows from bar end down to next bar start.
- Steal: (1) the near-white chart with weekend columns barely darker, which is what grid paper should feel like; (2) the single dark today line running the full height, which Shipday turns into the signal-orange "charge window open" line; (3) 3px bar radius on a 30px bar inside a 48px row: square enough to read as industrial, soft enough to not look raw.
- Avoid: all bars in the same neutral grey. Shipday bars carry state (planned, charge window open, charged, shipped) and the state must be legible without hovering.

## Flighty homepage

- URL: https://flighty.com/
- Screen: hero of an Apple Design Award flight tracker. Headline, award row, phone showing the My Flights list ("1h 38 minutes", "San Francisco to New York", "SFO 09:10", "JFK 17:25", "Departs On Time"), surrounded by notification cards in plain sentences.
- Screenshots: `design-research/refs/flighty-1440.png` (viewport capture; the full-page capture rendered blank below the nav because content mounts on scroll), `design-research/refs/flighty-390.png`
- Measured: h1 system sans 65px weight 700, tracking -1px, leading 78px, #000000. h2 56px weight 700 tracking -0.28px leading 56px; h3 44px leading 48.4px. Page bg #ffffff. Notification cards white with soft shadow and about 16px radius (PNG); the active tab chip "Preflight" yellow #eec041 (PNG). Cookie input radius 8px padding 10px.
- Regions: the notification cards: "Mom landed in New York. 6:32am (22m early) and 88 degrees", "Check In is now open. You can check-in at delta.com", "Good morning! Your flight today is on time." Each is a bold 16px title over a 15px grey sentence.
- Steal: (1) status as a full sentence with the time inside it, the model for every Shipday buyer state ("Your order ships in Wave 2. We charge your PayPal that day."); (2) one time made big ("1h 38 minutes") with the route in small type under it, the model for the buyer page's one big date; (3) a single warm accent chip marking the current phase, which is how orange marks "charge window open".
- Avoid: the faded ghost cards fanned around the phone. Decorative depth with no information.
