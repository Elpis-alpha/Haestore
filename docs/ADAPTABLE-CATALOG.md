# The adaptable catalogue

This is the feature the project is named for, and the one the 2022 version never had.

An agent traced the old `Item.ts` through its full git history. It began with a
free-form `category` string and moved *away* from flexibility, ending at
`enum: ["Cloth", "Shoe", "Cosmetic"]`. Five fields. No variants, no options, no sizes,
no stock, no custom anything. "Adaptable Stores" described an intention, not a system.

**The claim being made here:** an administrator can invent a kind of product the code
has never heard of — define its attributes, decide which of them a customer can filter
by, choose which become variant axes, and sell it — without a deploy, a migration or a
schema change. `src/modules/catalog/adaptable-catalog.integration.test.ts` is the proof;
if it passes, the claim holds.

---

## The three pieces

**AttributeDefinition** is the reusable unit: `roast`, `glaze`, `volume_ml`,
`dishwasher_safe`. It carries a type, options, whether it is filterable, searchable, and
eligible to be a variant axis.

**Category** binds definitions. There is deliberately no separate "attribute set"
collection between the two — the thing worth reusing is already the definition itself,
and a set in the middle would be one more thing to keep in sync.

**Product** stores values against those bindings, and variants along the axes it chose.

---

## Inheritance, and the ability to say no

Bindings inherit down the tree, nearest ancestor winning. At each node the node's
`suppressedKeys` are applied **before** its own bindings are merged.

That order is the whole trick. It means a branch can drop an inherited attribute *and*
rebind it differently:

> Ceramics inherits Care Instructions from Home, but here it is required and belongs in
> a different group.

Suppress then rebind, in that order, expresses it. The other order could not.

Resolution answers with `inheritedFrom` on every attribute, so the admin form can show
where a field came from rather than presenting inherited and local attributes as though
they were the same thing.

---

## `isVariantAxis` is eligibility, not generation

The category declares which attributes *may* be axes. **The product declares which it
actually uses**, and for each, which values it actually sells.

Generating from the category's full option set instead is how a single-origin sold only
as whole bean acquires a phantom "ground" variant, and a 250 g-only tin gets three
weights it has never had.

Only types with a finite value set qualify: `select`, `color`, `boolean`, and `number`
**when the definition enumerates its options** (250 g / 500 g / 1 kg — really a select
whose labels happen to be numeric). Free text and dimensions cannot produce a grid at
all. `multiselect` is excluded for a different reason: one variant cannot hold two
values on one axis, so the idea is incoherent rather than merely large.

The grid is a **suggestion**. It warns at 24 and refuses above 100, and `dryRun` shows
the count before anything is written — the difference between "this will make 48
variants, continue?" and finding out afterwards. Regenerating matches existing rows by
grid position, so prices and stock already entered survive.

---

## Permissive schema, strict service

The Mongoose schema has typed slots but no enums and no required-ness, because the
policy it would encode is not knowable when the model is defined — it is whatever an
admin configured this morning.

Policy lives one layer up: a Zod schema **compiled at runtime** from the category's
effective attribute set, cached in process, keyed by the same version counters as the
set itself.

The admin sends a flat DTO, because that is what a form produces:

```json
{ "roast": "medium", "weight_g": 250, "notes": ["floral", "cocoa"] }
```

It is validated, then projected into the stored typed array. `z.strictObject` means
**unknown keys are rejected** — an admin cannot invent an attribute by adding a field to
a request. Every key that reaches storage was defined and bound first.

---

## `validationMode` — the detail the whole feature depends on

`Category.validationMode` is `lenient` by default.

Adding a new **required** attribute must not retroactively invalidate the forty products
already in that category. In lenient mode they save, they still sell, and they carry
`needsAttention` with `validationIssues[]` so the dashboard can say *"12 products are
missing Roast Level."*

Without this, every attribute change is a migration. An admin learns that quickly, stops
touching attributes, and the adaptable catalogue becomes unusable while appearing to
work. `strict` exists for categories that genuinely cannot tolerate a gap, and refuses
the write instead.

Lenient is about **absence only**. A wrong value — `roast: "burnt"` — is refused in
either mode.

---

## `key` and `type` are immutable

A definition's `key` is load-bearing in four places at once:

1. a Meilisearch `filterableAttributes` entry
2. a public URL parameter (`?roast=medium`)
3. the discriminator on every stored value
4. an entry in `product.variantAxes`

Renaming would break every bookmarked filter URL and orphan the index. A rename is a new
definition plus a backfill, and the API does not express one — `key` and `type` are
absent from the update schema by construction, not merely optional, so no route can
accept them and no service can forget to check.

Keys that collide with a listing parameter — `q`, `sort`, `page`, `per_page`, `price`,
`in_stock`, `view`, `cursor`, `category`, `id`, `slug` — are rejected at creation, so the
collision is impossible rather than something to detect later.

Definitions are **archived, never deleted**. Products keep values keyed by definitions no
longer offered; deleting one would leave those values with no type and no label. **The product
page shows only what a product's shelf still applies** (Phase 10), so an archived, unbound or
suppressed attribute's value is kept and not presented — restore the definition, or bind it
again, and it is back. The console's product form still shows every stored value.

---

## Cache invalidation, avoided rather than solved

The effective set is cached in Redis under `(categoryId, treeVersion, defsVersion)`.

Both versions are monotonic counters. Bumping one **evicts nothing** — it makes every
existing key unreachable, so a stale entry cannot be read and there is no invalidation
fan-out to get wrong. Old entries expire on their own TTL.

They are deliberately coarse: any category write bumps the tree, any definition write
bumps the defs, and both invalidate every category's cached set. These are admin actions
measured in dozens per day, and a precise dependency graph would be a second thing to
keep correct.

They live in Redis beside the cache they key, so losing Redis loses both together — a
cold cache, never a stale one. A cache read failure is logged and ignored: a Redis outage
makes the catalogue slow, not broken.

---

## What is proven, and where

`adaptable-catalog.integration.test.ts`, against a real replica set:

| | |
|---|---|
| Bind high in the tree, applies all the way down | inheritance, with `inheritedFrom` |
| Suppress then rebind on a branch | the ordering rule above |
| Store a product against attributes invented at runtime | typed slots, denormalised display values, price range, stored `available` |
| Add a **required** attribute to a category holding live products | they save, they sell, they are flagged |
| The same write under `strict` | refused |
| Rename a mid-tree category | descendant paths rewritten |
| Reparent a category | ancestry rewritten, **and every affected product's denormalised copy** |
| Move a category into its own subtree | refused |
| Recategorise a product | values the destination does not bind are dropped, and reported |
| Bind an attribute, read immediately | no stale cache |
| Edit a definition, read immediately | no stale cache |

`catalog-api.integration.test.ts`, over HTTP:

- the filter panel is generated from admin-defined attributes, inherited ones included,
  and a non-filterable attribute does not appear in it
- drafts never appear in a listing, and internal review state never leaves the server
- a page size above the maximum is refused rather than honoured
- cursor pages neither repeat nor skip a row
- a branch filter is one predicate against the materialised ancestry
- every admin route answers 401 to an anonymous caller, including routes that did not
  exist when the test was written
