# Shipday interface tokens

The merchant surface is a production schedule on light grid paper. The timeline owns the screen, with operator actions arranged around the schedule. Buyer pages use a quiet receipt layout with one prominent ship date and a direct charge sentence.

## Tokens

- Canvas: `#fdfdfd`
- Buyer canvas: `#fbfbfa`
- Ink: `#282828`
- Secondary ink: `#525a60`
- Rule: `#d7d9d8`
- Off-day: `#f7f7f7`
- Warm note: `#f5f2ec`
- Signal orange: `#e8590c`, reserved for an open charge window and its primary action
- Freight: muted blue
- Success: dark green

## Type

- Barlow Condensed for headings, labels, and navigation.
- IBM Plex Mono for dates, quantities, money, and identifiers.
- Newsreader for the buyer page's single large ship date.
- Body copy uses Barlow Condensed with a readable 16px base size.

## Shape and spacing

- 8px spacing rhythm.
- 3px timeline bars, 48px timeline rows, and 45px day columns at day zoom.
- 4px action corners. Panels use a one-pixel rule, no shadows.
- Grid paper is a subtle one-pixel rule at a 24px interval.

## Interaction

- Native form controls and buttons remain keyboard accessible with visible focus rings.
- One primary action per working area.
- Loading, empty, and error states explain the next action.
- No non-essential animation. Respect reduced motion.
