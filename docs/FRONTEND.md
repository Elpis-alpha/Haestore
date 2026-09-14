# The storefront read path

Home, the shop listing with its generated facet panel, and the product page. Phase 4 of
the rebuild — the phase where the design system from Phase 1 and the adaptable catalogue
from Phases 2–3 meet a shopper.

The claim this phase has to make good on is narrow and specific: **an admin defines an
attribute in the morning and it is a working filter, with its own counts, in the afternoon
— and nothing in this repository names it.** Grep the frontend for `roast` and the only
hits are in test fixtures.

---

## The one rule: the URL is the state

Every filter control changes the URL and nothing else. There is no React state holding
"what is currently filtered", no store, no reducer. That is what makes Back, Forward,
refresh, bookmarking and sharing all work without any of them being implemented.

It only holds if a set of choices has exactly **one spelling**, which is what
`src/lib/listing/params.ts` is for.

### Canonical form

Keys sorted, values within a key sorted, defaults dropped:

```
/shop/coffee-tea/beans?in_stock=true&price=1500-4000&roast=dark,medium&sort=price_asc
```

- `?page=1&sort=newest&in_stock=false` → `` (all defaults, so the shop's front page is
  `/shop`)
- `?roast=medium,dark` and `?roast=dark&roast=medium` → `?roast=dark,medium`
- `?weight_g=1000,250` → `?weight_g=250,1000` — numeric values compare as numbers, so the
  URL reads in order rather than as `1000,250,500`
- `sort` is dropped when it equals the *implicit* default, which is `relevance` with a
  query and `newest` without one. So `?q=kettle&sort=newest` keeps its sort and
  `/shop?sort=newest` does not.

Every filter change resets `page` to 1, in the one constructor all mutations go through.
Sort does not — it reorders the same result set. Page 7 of an unfiltered shelf is rarely
page 7 of a narrowed one, and a shopper who lands on an empty page reads it as "no
matches" rather than "wrong page".

### The redirect lives in middleware, and had to

Anything non-canonical gets a **308** from `src/middleware.ts`.

It was first written inside the shop page, and it did not work. By the time a server
component runs, Next has begun streaming the shell, so `redirect()` can no longer set a
status — it degrades to a `<meta http-equiv="refresh">` in the body. That is a visible
one-second flash for a shopper and, for a crawler, precisely the duplicate-content signal
canonicalisation exists to remove. Middleware runs before the render, so the 308 is real.

**The comparison is `respell(raw) === canonical`, never `url.search === canonical`.** That
second form loops forever: `NextURL` normalises the query to the URL spec's encoding,
where a comma is `%2C`, while `URLSearchParams.toString()` writes form encoding, where it
is not — so `?roast=dark,light` is permanently redirected to `?roast=dark,light`. The two
encoders also disagree about `/ : @ ! ~`, so it is not one character to special-case.
Putting both sides through one encoder makes termination structural rather than lucky, and
`params.test.ts` asserts the property the loop violated.

The deliberate limit: two URLs differing *only* in percent-encoding both pass. Nothing
generates those — every control builds its href through `listingHref`, and crawlers follow
links rather than re-encoding them.

---

## The generated filter panel

`src/components/catalog/facet-controls.tsx` renders a control per `filterUi`:

| `filterUi` | Control |
|---|---|
| `checkbox` | `CheckRow` list with counts |
| `swatch` | Colour buttons carrying `swatchHex`, name in the accessible label |
| `select` | Single-value `Select`, with an "Any" option |
| `range` | Two numbers and a bar showing the selection inside what is available |
| `toggle` | `Switch` — on, or not mentioned |

Three rules, all of which exist because breaking them wastes work the backend already did:

- **A facet value with `count: 0` is disabled, never hidden.** The backend runs an extra
  `hitsPerPage: 0` query per *selected* group specifically so a shopper can see that a
  value exists and currently matches nothing. Hiding it throws that away and makes the
  panel appear to lose options as it is used. A swatch gets a diagonal strike instead.
- **`ignoredFilters` is surfaced**, as a removable chip plus the reason the API gave. It is
  the difference between showing unfiltered results and claiming to have filtered them.
- **`degraded: true` hides the panel** rather than rendering it inert, and says why.

`price` and `in_stock` are the storefront's own filters, not attributes — reserved
parameter names the backend owns, so no admin can define an attribute that collides.

### Why the range control is not a slider

A slider is imprecise at exactly the moment a shopper is being precise — "under £40" is a
number they have in mind, not a pixel they are hunting for — and a two-thumb one is genuinely
hard to operate by keyboard. The bar gives back the only thing the slider was for: where
this range sits inside the range that exists.

The inputs are draft state until committed, because refining per keystroke would fire a
request at `1`, `15`, `150` on the way to `1500`. That draft is seeded once and then owned
by the shopper; callers pass a `key` derived from the committed range, so a change from
elsewhere (Back, a chip removed, Clear all) **remounts** the control rather than an effect
racing the person typing.

---

## Refinement feels like a correction, not a page load

`ListingTransition` is the listing's only client state, and it is not the filters — it is
*whether a refinement is in flight*. The panel starts one; the grid has to know.

The current results stay on screen, dimmed and `aria-busy`, until the new ones arrive.
Filtering is a series of small corrections, and a shop that blanks itself on each one is
unusable at a fast tick rate — the shopper loses their place every time.

It uses **`push`, not `replace`.** The plan specified `replace`, and that defeats the reason
the plan gave for specifying it: Back is supposed to restore the previous filter state, and
a replaced entry is precisely the one Back cannot return to. A shopper who ticks a box and
immediately regrets it reaches for Back, not for the checkbox.

Pagination is the deliberate exception: real `<a>` links, so a crawler can follow them and
so moving to page 2 lands at the top of page 2. The last page offered is the last page the
API will serve — both engines bound depth at 1000 documents, so a listing reporting 4,000
matches still stops at page 41.

---

## There is no `loading.tsx`, and there must not be one

This is the phase's most expensive lesson.

A `loading.tsx` wraps a route in a Suspense boundary, which lets Next flush the shell — and
**commit a 200** — before the page component has decided whether the thing exists.
`not-found.tsx` still renders, but under a 200. That is a soft 404: the page a crawler is
explicitly told not to trust, on every missing product and every retired category.

Verified by removing the files and watching `/product/nope` and `/shop/no-such-shelf` go
from 200 to 404.

Streaming is not given up, only aimed. The product page's "more from this shelf" row is a
separate async component inside its own `<Suspense>`, placed *below* the existence check —
so a second listing query never delays first paint and never touches the status.

Nothing is lost on the listing side: refinement feedback comes from the transition above,
which is better behaviour anyway.

> A long diagnosis went the wrong way first because every isolation probe was written under
> `src/app/__probe/`. Directories beginning with an underscore are **private folders** in the
> App Router and are not routes at all, so each "it works here" was an ordinary unrouted
> 404. If you are bisecting App Router behaviour, check the route actually appears in the
> build's route table.

---

## The card grows into the page

`SharedElement` names the product image, and the browser carries it from the grid into the
product page. This preserves the best idea in the 2022 frontend, which measured the clicked
card's `getBoundingClientRect()` and fed it to the modal's `transform-origin`; the browser
now does that natively and correctly, including the aspect-ratio change a hand-rolled
version could not do. Sixty lines of measurement became a name.

**A name must be unique on the page.** The grid names its cards and the product page names
its hero, so the related-products row on the product page is rendered *without* a name —
two elements claiming one name is a broken transition, not a nicer one.

Two things make it work:

- `experimental.viewTransition: true` in `next.config.ts`. Without it Next never wraps
  navigation in `startViewTransition` and a cross-page shared element is not expressible.
  The flag makes Next alias `react` to its own bundled experimental build — the same
  channel PPR uses.
- The component is **looked up at runtime under both spellings**, because the two Reacts in
  play disagree: Next's aliased build exports `unstable_ViewTransition`; the installed
  React 19.3 and its types call it `ViewTransition`. Importing either name directly fails
  against the other. When neither is present, `SharedElement` renders its children and
  nothing animates — the fallback is no animation, never a broken one.

Verified rather than assumed: hooking `document.startViewTransition` and clicking a card
records one transition, with `product-espresso-house-blend` carried across it.

`prefers-reduced-motion` needed its own rule. The page-wide `*` reset in `globals.css`
cannot reach `::view-transition-group/old/new` — those pseudo-elements live in their own
tree, outside the document — so the one animation that moves the most would have ignored
the preference. The transition still runs; the new page simply appears.

---

## Caching

| Read | Policy | Why |
|---|---|---|
| `getCategories` | `revalidate: 300`, tag `categories` | One document shared by the header, footer, home shelves and every breadcrumb. Changes when an admin edits the tree. |
| `getCategoryByPath` | `revalidate: 300`, tag `categories` | Same, and it is where axis values get their labels and swatches. |
| `getProducts` | uncached | Varies with every filter combination, so a shared cache hits near zero — and facet counts and stock are exactly what must not be stale. The home page's "just put out" row is the one exception, being the same six products for everyone. |
| `getProduct` | `revalidate: 60` | Fixed per URL. |

Server components call Express directly on `API_ORIGIN`. They deliberately do not use the
`/api/*` rewrite: that exists so the *browser* only sees one origin, which is what makes
the `__Host-` cookie legal from Phase 5 on. A server component calling its own hostname is
a needless second hop through the Worker.

`softly()` marks a read that must not take the page down — the header's category nav. A nav
that cannot load is a thinner header, not a 500. The listing and the product page
deliberately do not use it: a shop rendering an empty grid because the API is unreachable
is worse than one that says so.

---

## Indexing

A shelf is worth indexing. A shelf with three boxes ticked is one of thousands of
near-identical combinations of the same products, and a search result is a page about the
query. So `generateMetadata` sets `robots.index: false` when filters or a query are
present, and always emits `alternates.canonical` pointing at the canonical URL.
Canonicalisation collapses the *spelling* variants; this keeps the combinatorial ones out.

### What Phase 9 added

- **`/sitemap.xml`** lists the home page, `/shop`, `/support`, every live shelf and every live
  product — and nothing combinatorial, because a sitemap is the one document where the shop
  says which URLs matter, and listing a `noindex` page there contradicts its own meta tag. The
  API's `/api/catalog/sitemap` can only return live shelves and products, so the file cannot
  drift into listing anything else. Revalidated hourly; read softly, so an API outage at
  generation time is a short sitemap rather than a 500 a search engine remembers.
- **`/robots.txt`** disallows only what has nothing public in it — `/api/`, `/admin`,
  `/account`, `/checkout`. The sign-in page, the bag and filtered shelves stay crawlable and say
  `noindex` themselves: a disallowed URL is never fetched, so its `noindex` is never read, and a
  page linked from every header could then be indexed from its links alone.
- **Structured data on the product page** — a `Product` with an `Offer` (one variant) or
  `AggregateOffer` (several, active variants only), an `aggregateRating` only when there are
  reviews, up to five reviews, and a `BreadcrumbList`. It is emitted through
  `serializeJsonLd`, which escapes `<`, `>`, `&`, U+2028 and U+2029: the block holds text that
  customers wrote, and `JSON.stringify` alone lets a review containing `</script>` end the
  element. Verified live with exactly that headline — the raw block contains no `<script`, and
  parses back to the original text.
- **A default Open Graph card** at `public/og/haestore.png`, 1200×630, rendered once from HTML
  in the brand's own type and committed as a file. `opengraph-image.tsx` would ship an image
  renderer in the Worker bundle to draw a picture that never changes. A page that sets its own
  `openGraph` replaces the layout's whole object, so the product page names the card again for
  a product with no photograph. `twitter:card` is `summary_large_image` site-wide.
- `NEXT_PUBLIC_SITE_URL` is read in one place, `lib/seo/site.ts`, alongside the layout's
  `metadataBase`, so canonical links, the sitemap and the structured data agree about the host.

---

## What is deliberately not here

- **No cart control, and no disabled placeholder for one.** Phase 4 is the read path; the
  bag arrives in Phase 6 with something behind it. A button that does nothing teaches
  people the buttons do nothing — the same discipline that left every admin route
  answering 401 in Phase 2 rather than adding a development bypass.
- **No add-to-bag on the product page**, for the same reason. Stock is stated, because that
  is real information a shopper acts on.
- **No `motion`.** The plan installs it here; nothing in the read path needed it. The
  filter panel and drawer animate through Radix data-state attributes and CSS keyframes,
  refinement feedback is a CSS opacity transition, and the card-to-page move is the
  browser's own. It was installed, left unused through the whole phase, and removed. It
  arrives when something needs it.
- **No marquee ticker.** The plan asks for one; `globals.css` states that ambient motion is
  not part of this system, and that rule is the more recent and better-argued of the two.
  A moving band of text over a grain overlay is also close to unreadable.

## The one gap — closed in Phase 8

A variant's `axisValues` carry the admin's raw slugs — `whole-bean`, not "Whole bean" —
because the grid is built from values. Phase 4 recovered labels from the category endpoint,
which returns only *filterable* attributes, so an axis that was not also a filter fell back
to a prettified slug, and so did every non-filterable row of the specification table.

Phase 8 closed it on the backend, at read time rather than by denormalising: the product
endpoint returns `axes` — each axis with its label and its options' labels and swatches —
and a `label` on every attribute, both taken from the effective attribute set the route had
already loaded and cached. The product page no longer calls the category endpoint at all.
A slug is prettified only for an attribute that no longer applies to the product's category.
