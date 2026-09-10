<div align="center">
  <img src="assets/logo_square.svg" alt="Hæstore" width="96" height="96">
  <h1>Hæstore</h1>
  <p><em>An artisanal general store — coffee, ceramics, botanicals, textiles, pantry, tools.</em></p>
</div>

---

Hæstore is a complete rebuild of *Adaptable Stores* (2022). This is the root repo: it
holds the documentation, the brand assets, and the local infrastructure. The two
applications live in their own repos alongside it.

| | Repo | Stack | Deploys to |
|---|---|---|---|
| Storefront + admin | [Haestore-FE](https://github.com/Elpis-alpha/Haestore-FE) | Next.js 15, React 19, Tailwind v4 | Cloudflare Workers |
| API | [Haestore-BE](https://github.com/Elpis-alpha/Haestore-BE) | Express 5, TypeScript, Mongoose 8 | Docker |

## What makes it *adaptable*

The old project was named **Adaptable Stores**, but nothing in it was adaptable.
Tracing `Item.ts` through its git history shows the product model starting with a
free-form `category` string and moving *away* from flexibility to a hardcoded
`enum: ["Cloth", "Shoe", "Cosmetic"]`. Five fields, no variants, no options, no stock.

Hæstore actually builds it:

- **Admins define the categories**, as a tree, not an enum.
- **Admins define the attributes** — name, type, unit, options, and whether each one
  is filterable or can act as a variant axis. Coffee gets roast, origin, process,
  grind and weight; ceramics gets glaze, dimensions and dishwasher-safe; apothecary
  gets volume, scent and skin type.
- **Products carry values** validated against whatever their category declares,
  inherited down the tree.
- **Variants are generated** from the axes a product actually uses — not every axis
  its category permits, so a single-origin sold only as whole bean never grows a
  phantom "ground" variant.
- **The storefront filter UI is generated from those definitions.** Define an
  attribute, mark it filterable, and a new facet appears in the shop with correct
  counts. Nothing is hardcoded, and an end-to-end test asserts exactly that.
- **Admins compose the storefront itself** from ordered, versioned blocks.

## Quick start

```bash
cp .env.example .env
npm install && npm run install:all
npm run up          # Mongo (replica set), Redis, Meilisearch, Mailpit
npm run probe       # assert the platform supports transactions + change streams
npm --prefix back-end run seed
npm run dev
```

Storefront at <http://localhost:3000>, API at <http://localhost:5000>, and sign-in
codes at <http://localhost:8025> — there are no passwords.

Full setup, ports and troubleshooting: **[docs/LOCAL-DEV.md](docs/LOCAL-DEV.md)**.

## Documentation

| | |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | How the three repos, four datastores and two request paths fit together |
| [DATA-MODEL](docs/DATA-MODEL.md) | Collections, indexes, and how money and stock are represented |
| [ADAPTABLE-CATALOG](docs/ADAPTABLE-CATALOG.md) | Categories, attributes, variants, and generated facets |
| [SEARCH](docs/SEARCH.md) | Meilisearch as the read model, and how it stays in sync |
| [AUTH](docs/AUTH.md) | Passwordless OTP and opaque Redis sessions |
| [CART](docs/CART.md) | Guest identity, re-pricing, and the sign-in merge |
| [CHECKOUT](docs/CHECKOUT.md) | Order state machine, Stripe, PayPal, idempotency |
| [DESIGN-SYSTEM](docs/DESIGN-SYSTEM.md) | Palette, type, the arch and leaf motifs, motion |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Cloudflare Workers and the API container |
| [decisions/](docs/decisions/) | ADRs — the contested forks and why they went the way they did |
| [PROGRESS](docs/PROGRESS.md) | Phase-by-phase build state |
| [MIGRATION](docs/MIGRATION-FROM-ADAPTABLE-STORES.md) | What changed from 2022, and why |

## Credits

Product photography from [Unsplash](https://unsplash.com), with per-photographer
attribution stored alongside each image and displayed on the product page.
