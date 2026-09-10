# ADR-006 — Paper is the primary action, and there is no terracotta accent

**Status:** accepted · Phase 1
**Supersedes:** the palette table in the plan of record, which named
`clay ~#C2703D` as "primary action — terracotta"

## Context

The plan derived a four-accent palette from the two given brand colours —
clay for actions, moss from the leaf, honey for highlights, brick for
destructive — and noted that "values are starting points to be
contrast-verified; the *roles* are fixed."

Verifying them is what changed the design.

## The measurement

On the `#523523` ground:

| Pair | Ratio | Verdict |
|---|---|---|
| `clay-500` `#c2703d` fill vs the ground | **2.0:1** | fails 1.4.11 for a control boundary |
| `paper-50` `#fcf8f4` fill vs the ground | **10.5:1** | clears AAA as text, comfortably |
| `bark-950` text on a `paper-50` fill | **17.8:1** | |

A terracotta button on chocolate is two colours of the same hue at similar
lightness. It reads as mud, and it needs a border to be visible as a control at
all.

There is a second reason, independent of the numbers. Cream ground, high-contrast
serif, terracotta accent near `#d97757` is the single most recognisable
signature of generated design right now. Landing on it by derivation would have
made a bespoke brand look templated.

## Decision

**The primary action is paper.** A cream label with bark text — the way goods in
a general store are tagged. Defined once as
`bg-[var(--ink)] text-[var(--surface)]`, so it inverts to ink-on-cream inside a
paper card without a variant or a dark-mode branch, and clears AAA on all four
surfaces.

**`clay` is deleted, not re-toned.** Chromatic colour is reserved for meaning.
The three that remain are renamed for the dyestuffs a general store of this kind
would have sold next door to, which gives them a reason to sit together:

| Was | Is | Role |
|---|---|---|
| `clay` | *(deleted)* | — |
| `moss` `#7c8b5a` | `verdigris` `#4e7a66` / `#b7d3be` | in stock, done, success |
| `honey` `#dda74e` | `weld` `#e5b65c` / `#f0ce8c` | focus, attention |
| `brick` `#b4523a` | `madder` `#b2452f` / `#f0b4a6` | error, destructive, sale |

`moss` at `#7c8b5a` was also, on its own, a sage green — another default. The
verdigris shift is toward copper patina, which is both further from that and
closer to the celadon glaze on the ceramics the shop actually sells.

## Consequences

**Good.** One button definition covers every surface, at AAA throughout. The
palette has a story rather than four arbitrary accents. Colour now means
something on sight, because it is never used for looks.

**The cost.** Three constraints fall out of it, all documented in
`DESIGN-SYSTEM.md` and asserted in `tokens.test.ts`:

1. Weld has no ink role on cream (1.8:1). It is a fill, a focus ring on dark, and
   attention text on dark.
2. Ratings became ink glyphs rather than gold stars — which is a better answer,
   not a workaround.
3. Filled dye buttons must carry a hairline of their own light tint, because the
   fill alone is ~2:1 against the ground.

**Reversible.** Reintroducing an accent means adding one token and one Button
variant; nothing else in the system assumes there are exactly three dyes.
