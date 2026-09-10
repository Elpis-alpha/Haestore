# Design system

Everything the Hæstore storefront is drawn from. The living version is the
`/styleguide` route, which renders each token and primitive on the ground it will
actually sit on; this document explains the decisions behind it.

Run it with `npm run dev` in `front-end/` and open
[localhost:3000/styleguide](http://localhost:3000/styleguide).

---

## Where it comes from

`assets/logo_square.svg` is a slab-serifed **H** whose crossbar is a vine ending in a
leaf, under the thin arch of a shopping-bag handle, cream on chocolate. Every shape in
this system is one of those three, and nothing else was invented.

The client fixed two colours: **`#523523`** as the ground and **`#fcf8f4`** as the ink.
Everything else is derived and measured.

---

## Two rules

**1. Colour carries meaning, never decoration.** The only decorative colour on the page
is the ground itself. The primary action is *paper* — a cream label, the way goods in a
general store are tagged — not a coloured button.

This is the one place the plan was overruled by measurement. The original palette gave
`clay` (~`#C2703D`) as the primary action colour. A terracotta fill on chocolate
measures **2.0:1** at its edge: it needs a border to be visible at all, it is the single
most over-used accent in this genre, and it is worse than the alternative. Cream on
chocolate measures **10.5:1**. The accent was dropped rather than fixed. See
[ADR-006](decisions/ADR-006-paper-as-the-primary-action.md).

**2. Surfaces declare, components consume.** No primitive hardcodes a colour. Every
surface sets a fixed set of custom properties, and a component reads them.

---

## The surface contract

A surface class re-points ink, edges, dyes and focus for everything inside it. Nesting
works: a paper card inside a well inside the ground.

| Variable | Meaning |
|---|---|
| `--surface` | the background this surface paints |
| `--ink` | primary text — AAA (≥7:1) on `--surface` |
| `--ink-muted` | secondary text — AA (≥4.5:1) |
| `--ink-faint` | placeholders, counts, timestamps — still AA |
| `--edge` | a control's border — ≥3:1, per WCAG 1.4.11 |
| `--rule` | a decorative divider, deliberately below 3:1 |
| `--groove` | an incised line, darker than the surface |
| `--field` | the well an input sits in |
| `--focus` | the focus ring — ≥3:1 against both `--surface` and `--field` |
| `--good` / `--bad` / `--note` | the dye tint that survives on this surface |

The four surfaces:

| Class | Ground | Used for |
|---|---|---|
| `.surface-ground` | `bark-600` | the page itself |
| `.surface-raised` | `bark-700` | headers, nav, a card on the page |
| `.surface-well` | `bark-900` | inputs, footers, anything sunk in |
| `.surface-paper` | `paper-50` | dialogs, drawers, menus, product cards |

### What it buys

The primary button is defined once, as `bg-[var(--ink)] text-[var(--surface)]`:

| Surface | Fill | Text | Ratio |
|---|---|---|---|
| ground | `#fcf8f4` | `#523523` | 10.5:1 |
| raised | `#fcf8f4` | `#3d2718` | 13.2:1 |
| well | `#fcf8f4` | `#21160e` | 16.8:1 |
| paper | `#17100a` | `#fcf8f4` | 17.8:1 |

No variant prop, no `dark:` branch, no component asking what it is sitting on — and all
four clear AAA. This is verified in a browser as well as in the test suite: focus a
button on each surface in `/styleguide` and the ring is weld on the three dark grounds
and ink on paper, because weld on cream measures 1.8:1 and paper overrides it.

**The rule that follows:** a floating thing is paper. Dialogs, drawers, menus and
tooltips all take `.surface-paper`. The ground is the shop; paper is where you transact.

---

## Colour

### Bark — the wood the shop is built from

`bark-950` `#17100a` · `bark-900` `#21160e` · `bark-800` `#2c1d13` · `bark-700` `#3d2718`
· **`bark-600` `#523523` (given)** · `bark-500` `#66452f` · `bark-400` `#7e5b41` ·
`bark-300` `#a8845f`

### Paper — the label tied to the goods

**`paper-50` `#fcf8f4` (given)** · `paper-100` `#f6efe5` · `paper-200` `#eadfce` ·
`paper-300` `#d9c8b0` · `paper-400` `#bea88c`

### The dyes

Named for the three dyestuffs a general store of this kind would have sold next door to.
They exist to mean something and for nothing else. There is no fourth accent.

| Family | Means | Tokens |
|---|---|---|
| **verdigris** — scraped off copper | in stock, done, success | `200` `#b7d3be`, `500` `#4e7a66`, `600` `#3b6151` |
| **madder** — root red | gone wrong, on sale, destructive | `200` `#f0b4a6`, `300` `#e59481`, `500` `#b2452f`, `600` `#8e3624` |
| **weld** — the yellow dye | look here, focus, attention | `200` `#f0ce8c`, `300` `#e5b65c` |

### Three constraints the measurements forced

**Weld has no ink role on paper.** Yellow cannot reach 4.5:1 on cream without ceasing to
be yellow — `weld-300` on `paper-50` is 1.8:1. Weld is a fill carrying dark text, a focus
ring on dark grounds, and "attention" text on dark grounds. Nothing else.

**Ratings are ink glyphs, not gold stars.** A direct consequence of the above: a gold
star on a cream product card is decoration shaped like information. Filled and outlined
ink glyphs carry the same meaning at 17.8:1.

**Every dye fill carries a hairline.** A madder fill on the chocolate ground is 2.0:1 at
its edge, verdigris 2.3:1 — below the 3:1 that WCAG 1.4.11 asks of a control's boundary.
So a filled dye button carries a 1px border of its own light tint (`madder-300` at 4.7:1,
`verdigris-200` at 6.9:1) and *that* is what the eye reads as the edge. It is not
decoration and removing it breaks the contrast guarantee.

---

## How the guarantees are kept

Contrast claims rot the moment someone nudges a hex for aesthetic reasons. Three things
stop that here:

1. **`src/design/parse-tokens.ts`** reads the tokens back out of `globals.css`, so the
   tests assert against the exact bytes the browser is served rather than a copy.
2. **`src/design/tokens.test.ts`** asserts every pairing in this document — 25 tests
   across both design suites. It also enforces that any new `.surface-*` declares the
   complete contract, which is what catches a surface added without a `--focus` colour
   months after anyone remembers the rule.
3. **`src/design/palette.ts`** exists only because a Cloudflare Worker cannot read
   `globals.css` off disk at runtime, and the styleguide has to print real hexes. It is a
   copy, so a test asserts it matches the stylesheet exactly and names the offending
   token when it does not.

Both guards were checked by deliberately breaking them and confirming the suite went red.

---

## Type

**Fraunces** for display, **Karla** for anything you operate. Both self-hosted by
`next/font` at build time — no request to Google, no layout shift, and no repeat of the
2022 app shipping a 1.79 MB `cambria.ttf` to every visitor alongside two `@font-face`
rules that were never referenced and one whose file did not exist.

Fraunces is variable, and its axes are routed through custom properties:

```css
font-variation-settings:
  'wght' var(--wght, 500), 'SOFT' var(--soft, 40),
  'WONK' var(--wonk, 0),   'opsz' var(--opsz, 24);
```

**This shape is load-bearing.** `font-variation-settings` resets every axis it does not
name, so a class that set only `WONK` would silently drop the element back to weight 400 —
the trap that makes variable fonts look broken. Naming all four, each reading a property
with a default, means a utility sets `--wonk` and the rest survive.

`.wonk` unlocks Fraunces's swashed alternates. They read as hand-cut at 48px and as noise
at 16px, so it is opt-in and belongs to the wordmark and page titles.

The scale is a major third (1.25) through the text range, with display sizes breaking out
of it — a shop sign is not four steps up from a price tag, it is a different kind of
object. Body copy is held under 66 characters.

Prices and any figure that lines up in a column take `.tabular`
(`font-variant-numeric: tabular-nums lining-nums`); without it a price list jitters as
digits change width.

---

## Motifs

| | |
|---|---|
| **The arch** | The bag handle, drawn as the logo draws it: a **stroke, not a filled dome**. A solid arch reads as a tombstone and loses what makes the mark feel like a shop. `<ArchFrame>` is the doorway version — `999px` on the top corners clamps to half the box width, so the arch stays a true half-round at any size instead of a radius re-guessed per breakpoint. |
| **The leaf** | Terminates the H's crossbar. It means *alive, growing, in stock*, and it is the empty-state mark. It is not a bullet and not a decoration. |
| **The slab** | The serif at the foot of the H, reduced to its structure. `<SlabRule>` is the minor break — a hairline with a short vertical tick at each end. `<VineRule>` is the major one, carrying the leaf, and belongs between whole sections. Two dividers at two levels, because a divider that means nothing is decoration. |
| **The tag** | A label with one corner cut and a punched hole. The system's one piece of literal decoration, spent here because the paper label is the whole conceit: the primary button, the product card and the tag are the same object at three sizes. Like the button, it takes `--ink` and `--surface`, so it inverts per surface — filling it with a fixed cream made it invisible the moment it landed on a paper card. |
| **Grain** | One fixed overlay across the whole document at 3.5% on `overlay` blend, portalled dialogs included: the texture belongs to the page, not to the boxes on it. `baseFrequency` near 1 with a **single** octave — four octaves carry enough low-frequency energy to read as blotches over a large area of one brown. |

---

## Motion

Almost all of it is the visible half of something a person just did. A dialog rises a few
pixels rather than scaling from nothing — a label set down on the counter, not a window
zooming open. The drawer slides from the edge it lives on. The accordion animates to
`var(--radix-accordion-content-height)`, the only way to reach `auto` in CSS without
measuring in JavaScript and creating a second source of truth.

Two exceptions, both deliberate: the skeleton sweep, which is the one thing that has to
say "still working"; and a single orchestrated page-load moment on `/styleguide` where
the handle draws and the wordmark arrives under it. There is no ambient motion, and no
fade-and-slide-up on every section.

`prefers-reduced-motion` is honoured globally, and the rule zeroes **delay as well as
duration**. Forcing duration alone is the usual half-measure: a staggered entrance keeps
its delay, so with `fill-mode: both` the element holds its `opacity: 0` start state for
the full delay and then pops in. Verified by rendering at 300ms with the preference
forced — the page is simply there.

---

## The kit

`src/components/motifs/` — `Mark`, `Wordmark`, `Arch`, `ArchFrame`, `Leaf`, `SlabRule`,
`VineRule`, `Tag`.

`src/components/ui/` — `Surface`, `Button`, `Badge`, `Field` (+ `FieldLabel`,
`FieldHint`, `FieldError`), `Input`, `Textarea`, `Select`, `CheckBox`, `CheckRow`,
`Radio`, `RadioRow`, `Toggle`, `Dialog`, `DrawerContent`, `Tooltip`, `Tabs`, `Accordion`,
`Toast`, `Skeleton`, `Price`, `Rating`, `QuantityStepper`.

Radix primitives underneath for the parts that are genuinely hard — focus traps,
typeahead, roving tabindex, swipe-to-dismiss, `aria-live` — styled from scratch rather
than taken from shadcn defaults, so none of it arrives looking like a template.

Three of these carry decisions worth knowing:

- **`Field`** mints the ids and wires `aria-describedby` / `aria-invalid` through
  context, so a field is accessible because it was assembled rather than because someone
  remembered. `FieldError` renders nothing when there is no error, so it can be left in
  place unconditionally.
- **`CheckRow`** is a `<label>` wrapping the control with a count slot, because the
  storefront's generated filter panel is built entirely from it and "Medium roast (14)"
  is one control, not a control with text glued beside it. Zero-count values disable
  rather than vanish, so the list stops reshuffling under the pointer.
- **`QuantityStepper`**'s number is a typable input. A stepper that only steps makes
  correcting a mis-tap a nine-click job. Values are clamped on commit, not on keystroke,
  so a half-typed number is never fought with.

## Money

`src/lib/money.ts`. Money is `{ amount, currency }` where `amount` is an **integer count
of minor units** — never a float, never a formatted string parsed back. The exponent is
read from `Intl` rather than hardcoded, because the exceptions (JPY 0, KWD 3) are the
whole problem and a hand-written table is a list of the ones you remembered.

The 2022 cart stored each line's *extended total* in a field called `price` and recovered
the unit price by dividing by quantity. Keeping the smallest unit as an integer makes
that class of bug unrepresentable.

---

## Formatting

Prettier, ESLint flat config and `.editorconfig`, enforced in CI. The 2022 frontend ran
40–52% blank lines across roughly 40 of its 58 files; that habit cannot come back through
this repo.
