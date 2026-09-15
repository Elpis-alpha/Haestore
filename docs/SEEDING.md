# Seeding

`npm run seed` builds the demo shop: a catalogue whose shelves have deliberately different
attributes, five months of orders and reviews behind it, a few support conversations, and a
composed front page. It exists so a fresh clone shows the adaptable catalogue working rather
than describing it.

```bash
npm run up                                  # Mongo, Redis, Meilisearch
npm --prefix back-end run seed              # an empty database
npm --prefix back-end run seed -- --reset   # replace whatever is there
```

It takes about twenty seconds.

---

## What it builds

| | |
|---|---|
| Attribute definitions | 36 — roast, process, grind; glaze, clay body, dishwasher safe; scent, volume, skin type; fibre, colour, bed size; wood, metal; and a few shared ones |
| Shelves | 23 — six top-level, each with two or three beneath it |
| Products | 59 — 58 on the shelves, one draft |
| Customers | 36, at `example.test` addresses |
| Orders | 246, across five months; most delivered, a handful shipped, packing or just paid |
| Reviews | 175 published, one hidden by the shop, 12 still unread |
| Conversations | 3 — one waiting on the shop, one answered and closed, one nobody has read |
| Front page | version 1 of a composed layout, using every kind of section |

The shelves are the point. **Coffee** binds roast, process, grind, tasting notes and
altitude; **Cups & mugs** binds glaze, capacity, dimensions and whether it survives a
dishwasher; **Oils & balms** binds scent, volume and skin type. The catalogue test holds
that difference in place: `coffee` and `cups-mugs` share no attribute at all. Where the
thing measured really is the same — weight, volume, where something was made — one
definition is bound in several places, and `origin` is bound once on Coffee & tea and
inherited by both shelves beneath it. Vases suppress the microwave question they inherit
from Ceramics.

Some moments are placed deliberately rather than left to chance, because the docs and the
console depend on them:

- **A small lot with one five-star review**, which "best rated" ranks below products with a
  dozen reviews at 4.6 — the Bayesian sort in REVIEWS-AND-SUPPORT.md, visible.
- **A review the shop hid**, with the note the author sees.
- **A draft missing its roast**, so the console's "needs attention" queue has something in it.
- **An order in each unfinished state**, so "parcels to pack" is never empty.
- **A chipped mug** a customer wrote in about, the shop's reply, and her answer.

---

## How it writes

**Through the services, after the schemas.** Every definition, shelf, product, order and
review is parsed by the Zod schema a request from the console or the storefront would be
parsed by, and written by the service that request reaches: `createProduct`, a bag and
`createOrderFromCart`, `markOrderPaid`, `shipOrder`, `writeReview`. Nothing is inserted
around them, so every derived figure in the seeded shop — price ranges, stock, ratings, the
search index — was derived by the code that derives it in production. The integration test
(`seed.integration.test.ts`) checks the figures against the facts: each product's rating
against its published reviews, each variant's reserved stock against the orders holding it.

**Time is the one thing written directly.** Services stamp `now`, so dates are moved into
the past afterwards: orders across five months, each status change at a plausible interval,
reviews after deliveries. Nothing derived depends on a date.

**It is deterministic.** A fixed random seed decides who bought what and what they thought
of it. The same data produces the same shop, and the screenshots stay true.

**Nothing seeded sends mail.** Receipts and replies owed by the seeded history are marked
sent as they are created. Customers are at `example.test`, which cannot receive mail anyway.

---

## Flags and safety

| | |
|---|---|
| `--reset` | Empties every collection first. Without it, a database that already has a shop in it is refused. |
| `--orders=N` | How many random orders to invent on top of the scripted ones. Default 240. |
| `--no-photos` | Leaves the products unphotographed. |
| `--no-reindex` | Skips the search rebuild. So does Meilisearch not answering; the API's relay indexes from the outbox when it next runs. |
| `--allow-production` | Required to seed with `NODE_ENV=production`. Do not. |

`--reset` deletes accounts too, so anybody signed in is signed out on their next request.
**Stop the API while seeding** if you can: nothing breaks if it runs, but its relay indexes
products one by one while the seed is also rebuilding the index in one go.

The addresses in `ADMIN_EMAILS` get accounts with the admin role, as a first sign-in would
give them, and the first of them is the person behind the counter in the seeded history —
who packed the orders, answered the conversations and published the front page. With
`ADMIN_EMAILS` empty, a `counter@haestore.test` account with no role stands in.

After a reseed, **clear `front-end/.next`** if the storefront is already running in
development: its fetch cache can serve pages from the shop that was there before.

---

## Photographs

Unsplash's guidelines decide how this works, and all three are followed. See
[ADR-015](decisions/ADR-015-unsplash-photographs-are-hotlinked.md) for why the photographs
are hotlinked rather than copied into Cloudinary.

**Choosing and seeding are separate steps.** Each product names its photograph as a search
— `{ query: 'pour over coffee', pick: 0 }` — because that is how a person chooses one.
`npm run seed:photos` turns each search into a specific photograph and writes it to
`back-end/src/seed/photos.lock.json`, which is committed. `npm run seed` reads only the lock,
so seeding needs no search quota and every clone gets the same photographs.

```bash
npm --prefix back-end run seed:photos -- --curate   # search, lock, and write a contact sheet
npm --prefix back-end run seed:photos               # report the chosen photographs' downloads
```

- **Searches are cached** in `assets/.unsplash-cache/search/` (or `back-end/.unsplash-cache/`
  when the back-end is checked out alone; `UNSPLASH_CACHE_DIR` overrides both). Choosing a
  different result from a search already made costs nothing.
- **`--curate` writes `contact-sheet.html`** in the cache directory: every photograph chosen,
  then every search with its eligible results numbered as `pick` counts them. Change a
  `pick` in the catalogue data, run it again, look again. Unsplash+ photographs and
  photographs without a BlurHash are never eligible.
- **Downloads are reported once per photograph per machine**, when a photograph is locked
  without `--curate` and when it is first seeded, and recorded in `downloads.json` beside the
  cache. `--curate` reports nothing, so photographs looked at and passed over are not
  counted as used.
- **The quota is fifty requests an hour** on a demo key. Everything stops cleanly at the
  limit and says what is still owed; run the same command again in an hour and it carries
  on. The first curation of this catalogue took 41 searches.
- **Without `UNSPLASH_ACCESS_KEY`**, the seed still uses the locked photographs and says
  that their downloads could not be reported.

Each photograph's credit is stored with it — author, profile link and Unsplash, with
`utm_source=haestore&utm_medium=referral` — and printed beside the photograph on the
product page. The placeholder is the photograph's BlurHash, decoded at seed time into an
eight-pixel PNG.

---

## Changing the catalogue

The data lives in `back-end/src/seed/catalogue/`: `attributes.ts`, `shelves.ts`, and one file
per top-level shelf. `npm --prefix back-end test` runs `catalogueProblems()` over it, which
catches what the services would refuse — an option value that does not exist, an attribute
the shelf does not bind, an axis that is not an axis — and two things they deliberately do
not: a live product missing a required value, and a live product with no photograph.

Adding a product is adding an object to the right file and a `photos` search to it, then
`seed:photos -- --curate` to choose and `seed:photos` to lock.
