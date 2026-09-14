# Accessibility

The Phase 9 audit: what was measured, what it found, and what was fixed. Earlier phases built
accessibility in — `Field` wires ids and `aria-describedby` so a field is labelled because it
was assembled, the palette's contrast pairs are unit tests that parse `globals.css`, and
reduced motion zeroes delay as well as duration (DESIGN-SYSTEM.md). This is the pass that
checked the assembled shop, in a real browser, rather than its parts.

---

## How it was measured

- **axe-core 4.10.2**, injected into each page in Chromium through Playwright, with the
  `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice` rule sets, against
  the running stack with real data.
- **Thirty pages**: every storefront page, the sign-in page, the bag, checkout, the specimen
  sheet, every account page — including a delivered order, the review page with a review
  written, and a support thread — and every console page, including a conversation, the review
  queue and an order.
- **Signed out, as a customer and as an admin**, because each sees a different page at the
  same URL.
- **One dialog open**, because a modal is its own document as far as a screen reader is
  concerned and axe only sees what is rendered.
- **Twenty-five of those pages at 375px** — the storefront, account and console pages — measuring
  `scrollWidth` against the viewport for sideways scroll, and counting `main` and `h1`.
- **By keyboard**: the skip link, the review rating, and where focus goes when a dialog closes.
- **With `prefers-reduced-motion: reduce` emulated**, reading the computed animation on the
  bag drawer with and without it.

The admin console came back clean: **zero violations on all twelve console pages.** So did
the storefront's forms. What the audit found is below, every item fixed and re-measured.

---

## What it found

### 1. Closing a dialog dropped keyboard focus on the page — every dialog in the shop

Pressing Escape in the review dialog left focus on `<body>`. So did the bag drawer, and so, by
the same mechanism, did every console dialog: step-up, cancel, refund, hiding a review.

Radix returns focus on close only to a `Dialog.Trigger`. Nearly every dialog here is opened by
an ordinary button that sets state — the bag since Phase 6, the console since Phase 8 — and for
all of them Radix focused nothing. A keyboard or screen-reader user who opened the bag,
looked, and closed it was sent back to the top of the document.

**Fixed once, in `components/ui/dialog.tsx`.** `DialogContent` and `DrawerContent` remember what
had focus when they opened — in `onOpenAutoFocus`, which runs before Radix moves focus inside —
and focus it again on close if it is still in the document. A button replaced by the action it
performed is not, and Radix's own behaviour then stands. Re-measured: Escape from the review
dialog returns to *Edit*, from the bag to the bag button, and *Keep it* on the delete dialog
returns to *Delete*.

### 2. A zero-count filter value was 3.48:1

The generated filter panel shows a value that currently matches nothing as disabled rather
than hiding it (SEARCH.md: the shopper should see that the value exists). `CheckRow` faded the
whole row to 45% opacity, which put its label at **3.48:1** on the ground.

WCAG exempts inactive controls from contrast, and the exemption does not help here: the value
is shown precisely so that it can be read. The row's words now take `--ink-faint`, which
`tokens.test.ts` holds at 4.5:1 or better on every surface, and only the checkbox itself dims.
Re-measured: `/shop` has no contrast violations.

### 3. Two navigations shared a name

The header's navigation and the footer's were both `aria-label="Shelves"`, so a screen
reader's list of landmarks offered the same name twice with no way to tell them apart. The
footer's is now "All shelves". Re-measured clean on `/shop` and on a delivered order's page.
The development server went on reporting the duplicate on `/` alone, from a render of the
statically prerendered home page made before the change; the production build's prerendered
`index.html` carries one "Shelves" and one "All shelves".

### 4. The specimen sheet failed its own subject

`/styleguide` is `noindex`, but it is the page that demonstrates the kit, and it had four
unlabelled sample inputs, five empty table headers over the swatch column, and a hero that sat
outside `main` as a second banner landmark. The inputs are labelled, the column headers say
"Swatch" to a screen reader, and the hero is inside the page's one `main`. Re-measured: zero
violations.

---

## What held

- **One `main` and one `h1`** on each of the twenty-five pages counted, and on the specimen
  sheet after its fix.
- **No sideways scroll at 375px** on any of the twenty-five pages measured, including the
  account area's six tabs, which scroll inside their own strip.
- **The skip link** is the first Tab stop on every page and visible when focused; Enter then Tab
  lands on the first link inside the content, not in the header.
- **Reduced motion is honoured by the drawer**: `slide-in-right` runs at 0.28 s normally and at
  1e-5 s with the preference set, with no delay, and `scroll-behavior` is `auto`.
- **The review rating is a real radio group**: arrow keys move and select, each star is named
  "4 stars, good", and focus opens on the chosen star.
- **Opening a dialog** puts focus inside it, and the dialog's own content has no violations.

---

## One false alarm, recorded so it is not chased again

The first scripted pass reported that arrow keys in the rating moved focus without selecting a
star, and a review was saved as one star instead of four. Holding each key for ninety
milliseconds — as a person does — selected correctly every time. Playwright's `press` releases
the key before Radix's deferred focus lands, and Radix selects only while the key is still down.
The end-to-end tests Phase 10 writes should hold keys the same way, or they will assert against
a behaviour no person produces.

---

## Not covered

- **Screen readers themselves.** axe reads the accessibility tree; it does not listen to it. A
  pass with VoiceOver and NVDA on the purchase path belongs with the Phase 10 end-to-end tests.
- **Stripe's and PayPal's own fields**, which render in their frames and are theirs to audit.
- **Colour contrast of text over photographs**, which axe reports as incomplete rather than as
  passing or failing. The shop sets no text over photographs.
- **Zoom to 400%**, beyond the 375px measurement.
