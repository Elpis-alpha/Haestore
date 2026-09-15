# ADR-015 — Unsplash photographs are hotlinked, not copied into Cloudinary

**Status:** Accepted · 2026-09-15

## Context

The plan of record put the seed's photography on one pipeline: search Unsplash, upload each
chosen photograph to Cloudinary, and serve every image in the shop through the Cloudinary
loader the storefront already had. One image store, one loader, Cloudinary's automatic
formats and crops for everything.

Phase 10 read Unsplash's API guidelines before building it. Three of them are requirements,
not suggestions, and the plan had named two:

- **Trigger a download** — "when your application performs something similar to a
  download (like when a user chooses the image to include in a blog post, set as a header,
  etc.), you must send a request to the download endpoint returned under the
  `photo.links.download_location` property."
- **Attribute** — "when displaying a photo from Unsplash, your application must attribute
  Unsplash, the Unsplash photographer, and contain a link back to their Unsplash profile,"
  with `?utm_source=<app>&utm_medium=referral` on the links.
- **Hotlink** — "all API uses must use the hotlinked image URLs returned by the API under
  the `photo.urls` properties. This applies to all uses of the image and not just search
  results." The image files are served from Unsplash's CDN so each view is counted for the
  photographer. Re-hosting them elsewhere — which is exactly what an upload to Cloudinary
  is — is not permitted under the standard terms.

The third one is the one the plan missed, and it rules out the pipeline as written.

## Decision

**Unsplash photographs are served from `images.unsplash.com`. Cloudinary holds the shop's
own photographs, and only those.**

- **One field, two sources.** A product image's `publicId` is a Cloudinary public id *or* a
  hotlinked Unsplash photograph URL, and nothing else. The API's schema refuses any other
  string (`image-source.ts`), because this value ends up in an `<img src>` on every page.
- **The loader resizes both.** Cloudinary ids become transformation URLs as before;
  Unsplash URLs get the imgix parameters Unsplash supports (`w`, `q`, `fit`,
  `auto=format`) set on the URL it issued, which keeps its `ixid`. Open Graph and JSON-LD
  go through the same module (`front-end/src/lib/images/source.ts`).
- **The placeholder is Unsplash's own.** Every photograph comes with a `blur_hash`; the
  seed decodes it once into an eight-pixel PNG data URL. No image bytes are fetched or
  copied to make it.
- **The credit is stored with the image** — author, profile link, source, source link,
  UTM parameters included — and printed beside the photograph on the product page:
  "Photo by *Name* on *Unsplash*". The console keeps it on every save.
- **A download is reported once per photograph per machine**, when the photograph is chosen
  (`npm run seed:photos`) or first seeded, and recorded in a ledger so a reseed does not
  count the same decision again.
- **The choices are committed.** `photos.lock.json` holds the hotlink, the hash, the size
  and the credit for each product's photograph, so a fresh clone seeds the same shop
  without spending its search quota. See SEEDING.md.
- **Cloudinary's signed upload serves the console.** The browser sends a file straight to
  Cloudinary under a ticket the API signed for the products folder; the API then reads the
  result back from Cloudinary before the form stores it.

## What we give up

- **A field whose name says less than it holds.** `publicId` is a URL for most of the
  seeded catalogue. Renaming it would touch carts, orders, wishlists, the search document
  and the storefront layout for a word; the schema, this record and DATA-MODEL.md say what
  it holds instead.
- **Cloudinary's transformations on the seed's photographs.** No `g_auto` subject-aware
  crops, no `e_` effects: imgix's `fit=crop` centres, and that is all the product card gets.
- **A second CDN the shop depends on.** If `images.unsplash.com` is slow, the seeded shop's
  photographs are slow.
- **Attribution on the product page, not on every card.** The credit sits beside the
  photograph where it is shown at size. The shelves and rows show the same photographs as
  small cards without a credit line, which is this project's reading of "when displaying";
  a stricter reading would put a credit under every card, and the card has room for one if
  that is ever asked of it.

## Why the tempting option is tempting

Because it was the plan, because one image store is simpler than two, and because
Cloudinary does more with a photograph than imgix does. And because nothing enforces the
guideline at request time — the upload works, the photographs look better, and the only
cost is a breach of the terms the photographs were obtained under, which a portfolio piece
about doing things properly cannot carry.

Revisit this if the shop photographs its own products — the seed's photographs are
stand-ins, and uploads already go to Cloudinary — or if Unsplash approves the application
for production use with a view-reporting arrangement that permits caching.
