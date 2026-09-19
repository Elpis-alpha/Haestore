# Phase 11 — Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hæstore deployable — config, the code changes a real deploy needs, and the runbook — verified locally, with nothing deployed.

**Architecture:** The storefront Worker gets a persistent KV page cache (keyed per build by OpenNext) and a CSP; its existing middleware additionally stamps the shopper's IP on `/api/*` with a shared secret the API checks. The API refuses live payment keys at boot. The VPS runs Redis, Meilisearch and the API from `deploy/vps/compose.yml` behind the owner's existing nginx; MongoDB is external.

**Tech Stack:** Next.js 15 + `@opennextjs/cloudflare` 1.20.6 + wrangler 4; Express 5 + Zod 4; Vitest; Playwright; Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-19-phase-11-deploy-design.md`

## Global Constraints

- Nothing is deployed. No `wrangler deploy`, no `cf:deploy`, no pushes, no dashboard changes.
- No live payment credentials anywhere: Stripe test mode, PayPal sandbox.
- No tag cache. No nginx config file. No Mongo service in the VPS compose.
- Header names, exactly: `x-haestore-client-ip`, `x-haestore-proxy-secret`. Env name: `PROXY_SHARED_SECRET` (min 32 chars) on both sides.
- Worker name `heastore-web`; API published on `172.17.0.1:5003:5000`.
- Three independent git repos: root (`haestore`), `front-end/`, `back-end/`. Commit in the repo the files belong to. Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Match surrounding style: explanatory block comments that say *why*, no double blank lines (`.editorconfig`).
- Each repo's `npm run check` stays green.

---

### Task 1: Backend refuses live payment keys (ADR-016's code half)

**Files:**
- Create: `back-end/src/config/payment-mode.ts`
- Create: `back-end/src/config/payment-mode.test.ts`
- Modify: `back-end/src/config/env.ts` (payments block; schema gets a `superRefine`)
- Modify: `back-end/.env.example` (payments comment; stale Mailpit header; `directConnection` local-only)
- Modify: `back-end/src/db/mongo.ts:70-76` (error hint)

**Interfaces:**
- Produces: `livePaymentProblems(input: { STRIPE_SECRET_KEY?: string; PAYPAL_ENV?: string }): { key: string; message: string }[]`

- [ ] **Step 1: Write the failing test** — `back-end/src/config/payment-mode.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { livePaymentProblems } from './payment-mode.js';

describe('livePaymentProblems', () => {
  it('accepts test-mode Stripe and the PayPal sandbox', () => {
    expect(livePaymentProblems({ STRIPE_SECRET_KEY: 'sk_test_abc', PAYPAL_ENV: 'sandbox' })).toEqual([]);
    expect(livePaymentProblems({ STRIPE_SECRET_KEY: 'rk_test_abc' })).toEqual([]);
  });

  it('accepts nothing configured at all', () => {
    expect(livePaymentProblems({})).toEqual([]);
  });

  it.each(['sk_live_abc', 'rk_live_abc'])('refuses the live Stripe key %s', (key) => {
    const problems = livePaymentProblems({ STRIPE_SECRET_KEY: key });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.key).toBe('STRIPE_SECRET_KEY');
    expect(problems[0]!.message).toMatch(/test mode/i);
  });

  it('refuses PayPal live', () => {
    const problems = livePaymentProblems({ PAYPAL_ENV: 'live' });
    expect(problems.map((p) => p.key)).toEqual(['PAYPAL_ENV']);
  });

  it('reports both at once', () => {
    expect(livePaymentProblems({ STRIPE_SECRET_KEY: 'sk_live_x', PAYPAL_ENV: 'live' })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm --prefix back-end test -- src/config/payment-mode.test.ts`
Expected: FAIL — cannot resolve `./payment-mode.js`.

- [ ] **Step 3: Implement** — `back-end/src/config/payment-mode.ts`

```ts
/**
 * This shop takes no real money, and the environment contract says so. See ADR-016.
 *
 * A live key pasted into a deployment's `.env` would not fail — it would work, and the
 * first "demo" order would charge a real card. So a live key is not a warning; the API
 * refuses to start, naming the key, the same way it refuses any other incoherent config.
 *
 * Only Stripe's secret half is checked: the webhook secret (`whsec_`) looks the same in
 * both modes, and a live webhook secret is useless without a live secret key. PayPal's
 * mode is not in its credentials at all, so it is `PAYPAL_ENV` that is held to `sandbox`.
 */
export type PaymentProblem = { key: string; message: string };

const LIVE_STRIPE = /^(sk|rk)_live_/;

export function livePaymentProblems(input: {
  STRIPE_SECRET_KEY?: string;
  PAYPAL_ENV?: string;
}): PaymentProblem[] {
  const problems: PaymentProblem[] = [];
  if (input.STRIPE_SECRET_KEY && LIVE_STRIPE.test(input.STRIPE_SECRET_KEY)) {
    problems.push({
      key: 'STRIPE_SECRET_KEY',
      message: 'is a live key. Hæstore runs in Stripe test mode only — use an sk_test_ key (ADR-016)',
    });
  }
  if (input.PAYPAL_ENV === 'live') {
    problems.push({
      key: 'PAYPAL_ENV',
      message: 'is "live". Hæstore runs against the PayPal sandbox only (ADR-016)',
    });
  }
  return problems;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npm --prefix back-end test -- src/config/payment-mode.test.ts` → PASS (6 tests).

- [ ] **Step 5: Wire it into the env contract** — in `back-end/src/config/env.ts`, import `livePaymentProblems` from `./payment-mode.js`; change the payments comment header to `// ---- Payments (test mode only — see ADR-016) ----`; and append to the `z.object({...})` definition:

```ts
}).superRefine((value, ctx) => {
  for (const problem of livePaymentProblems(value)) {
    ctx.addIssue({ code: 'custom', path: [problem.key], message: problem.message });
  }
});
```

`PAYPAL_ENV` keeps its `z.enum(['sandbox', 'live'])` type so `paypal.ts`'s host table is untouched; the refinement is what refuses `live`, with a message that says why rather than "expected sandbox".

- [ ] **Step 6: Prove the boot refusal by hand**

Run: `cd back-end && NODE_ENV=test MONGODB_URL=x REDIS_URL=x STRIPE_SECRET_KEY=sk_live_nope node --import tsx -e "await import('./src/config/env.ts')"; echo "exit=$?"`
Expected: `Invalid environment configuration:` then `• STRIPE_SECRET_KEY: is a live key…`, `exit=1`. Same with `PAYPAL_ENV=live`. With `sk_test_x`, exit 0.

- [ ] **Step 7: External-Mongo wording**
  - `back-end/src/db/mongo.ts` hint: replace `'  Then check: MONGODB_URL includes ?replicaSet=rs0&directConnection=true\n'` with `'  Then check: MONGODB_URL names a replica set (locally: ?replicaSet=rs0&directConnection=true;\n  a hosted cluster such as Atlas is one already, and must NOT carry directConnection)\n'`.
  - `back-end/.env.example`: the Mongo comment says `directConnection=true` is for **this machine's local replica set only** and must not be used against a hosted cluster; rename the mail header to `# ---- Mail ----` (Mailpit is gone, ADR-007); payments header becomes `# ---- Payments (test mode only — see ADR-016) ----` with a line that live keys are refused at boot; `PAYPAL_ENV=sandbox` gets `# the only accepted value`.
  - Update `env.ts`'s `MONGODB_URL` comment the same way.

- [ ] **Step 8: Check and commit**

Run: `npm --prefix back-end run check` → green.

```bash
cd back-end && git add src/config/payment-mode.ts src/config/payment-mode.test.ts src/config/env.ts src/db/mongo.ts .env.example
git commit -m "feat(config): refuse live payment keys at boot

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: API trusts a stamped client IP only with the shared secret

**Files:**
- Modify: `back-end/src/modules/auth/client-ip.ts`
- Modify: `back-end/src/modules/auth/client-ip.test.ts`
- Modify: `back-end/src/config/env.ts` (add `PROXY_SHARED_SECRET`)
- Modify: `back-end/src/lib/logger.ts:14-23` (redact the secret header)
- Modify: `back-end/.env.example`

**Interfaces:**
- Produces: `CLIENT_IP_HEADER = 'x-haestore-client-ip'`, `PROXY_SECRET_HEADER = 'x-haestore-proxy-secret'`, `clientIp(req: Request, proxySecret?: string): string` (default `env.PROXY_SHARED_SECRET`). Callers in `auth.routes.ts` are unchanged.

- [ ] **Step 1: Write the failing tests** — in `client-ip.test.ts`, change the helper to carry headers (existing tests keep passing through it) and add a block:

```ts
import { CLIENT_IP_HEADER, PROXY_SECRET_HEADER, clientIp } from './client-ip.js';

const asRequest = (ip: string | undefined, headers: Record<string, string> = {}) =>
  ({ ip, headers }) as unknown as Request;

const SECRET = 'a_proxy_secret_that_is_at_least_32_chars';

describe('clientIp behind the storefront Worker', () => {
  const stamped = (secret: string, ip = '198.51.100.7') => ({
    [CLIENT_IP_HEADER]: ip,
    [PROXY_SECRET_HEADER]: secret,
  });

  it('uses the stamped address when the secret matches', () => {
    // req.ip here is the Worker's egress address — the thing every shopper shares.
    expect(clientIp(asRequest('203.0.113.1', stamped(SECRET)), SECRET)).toBe('198.51.100.7');
  });

  it('ignores the stamp when the secret is wrong', () => {
    expect(clientIp(asRequest('203.0.113.1', stamped('x'.repeat(40))), SECRET)).toBe('203.0.113.1');
  });

  it('ignores a stamp with no secret header — a client calling the API directly', () => {
    const headers = { [CLIENT_IP_HEADER]: '198.51.100.7' };
    expect(clientIp(asRequest('203.0.113.1', headers), SECRET)).toBe('203.0.113.1');
  });

  it('ignores the stamp entirely when no secret is configured', () => {
    expect(clientIp(asRequest('203.0.113.1', stamped(SECRET)), undefined)).toBe('203.0.113.1');
  });

  it('refuses a stamped value that is not an address', () => {
    expect(clientIp(asRequest('203.0.113.1', stamped(SECRET, 'not-an-ip')), SECRET)).toBe('203.0.113.1');
  });

  it('normalises a stamped IPv4-mapped address like any other', () => {
    expect(clientIp(asRequest('203.0.113.1', stamped(SECRET, '::ffff:198.51.100.7')), SECRET)).toBe('198.51.100.7');
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npm --prefix back-end test -- src/modules/auth/client-ip.test.ts`
Expected: FAIL — `CLIENT_IP_HEADER` not exported; stamped cases return `203.0.113.1`.

- [ ] **Step 3: Implement** — replace `client-ip.ts`'s body, keeping its existing doc comment and adding a second:

```ts
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { env } from '../../config/env.js';

export const CLIENT_IP_HEADER = 'x-haestore-client-ip';
export const PROXY_SECRET_HEADER = 'x-haestore-proxy-secret';

/**
 * (existing comment about the IPv4-mapped form, unchanged)
 *
 * **Behind the storefront Worker, `req.ip` is Cloudflare's, not the shopper's.** Every
 * browser `/api/*` call is proxied by the Worker, so without this every shopper shares
 * one address — and one sign-in throttle bucket. The Worker's middleware copies
 * Cloudflare's `cf-connecting-ip` into `x-haestore-client-ip` alongside a shared secret.
 * The stamp is believed only when the secret matches, compared in constant time: the
 * API is reachable directly through nginx, and a header anyone can send is a header
 * anyone can use to give themselves a fresh throttle bucket per request.
 */
export function clientIp(req: Request, proxySecret: string | undefined = env.PROXY_SHARED_SECRET): string {
  const ip = stampedByProxy(req, proxySecret) ?? req.ip ?? '';
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(ip);
  return mapped?.[1] ?? ip;
}

function stampedByProxy(req: Request, secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  const presented = req.headers[PROXY_SECRET_HEADER];
  if (typeof presented !== 'string') return undefined;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  const ip = req.headers[CLIENT_IP_HEADER];
  return typeof ip === 'string' && isIP(ip) ? ip : undefined;
}
```

- [ ] **Step 4: Env and logging**
  - `env.ts`, in the Auth block: 
    ```ts
    // Shared with the storefront Worker, which stamps the shopper's address on every
    // proxied /api/* call. Unset locally, where there is no Worker in front. See
    // modules/auth/client-ip.ts and docs/DEPLOYMENT.md.
    PROXY_SHARED_SECRET: z.string().min(32, 'PROXY_SHARED_SECRET must be at least 32 characters').optional(),
    ```
  - `logger.ts` `redact.paths`: add `'req.headers["x-haestore-proxy-secret"]'`.
  - `.env.example` Auth block: `PROXY_SHARED_SECRET=` with a two-line comment (same value as the Worker's secret; leave empty locally).

- [ ] **Step 5: Run the tests** — `npm --prefix back-end test -- src/modules/auth/client-ip.test.ts` → PASS (11).

- [ ] **Step 6: Break-it check** — temporarily replace `!timingSafeEqual(a, b)` with `false`, run the file: the "wrong secret" test must go red. Restore; green again.

- [ ] **Step 7: Integration still green, then commit**

Run: `npm --prefix back-end run check && npm --prefix back-end run test:integration` (needs `docker compose up -d` in the root).

```bash
cd back-end && git add src/modules/auth/client-ip.ts src/modules/auth/client-ip.test.ts src/config/env.ts src/lib/logger.ts .env.example
git commit -m "feat(auth): trust the Worker's client-ip stamp only with the shared secret

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Worker middleware stamps the shopper's IP on `/api/*`

**Files:**
- Create: `front-end/src/lib/proxy/client-ip.ts`
- Create: `front-end/src/lib/proxy/client-ip.test.ts`
- Modify: `front-end/src/middleware.ts` (new branch + matcher entry)

**Interfaces:**
- Consumes: header names from Global Constraints.
- Produces: `stampClientIp(incoming: Headers, secret: string | undefined): Headers | null` — returns the headers to forward, or `null` when there is nothing to stamp (no secret, or no `cf-connecting-ip`).

- [ ] **Step 1: Failing test** — `front-end/src/lib/proxy/client-ip.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { stampClientIp } from './client-ip';

const SECRET = 'a_proxy_secret_that_is_at_least_32_chars';

describe('stampClientIp', () => {
  it("stamps Cloudflare's address and the secret", () => {
    const out = stampClientIp(new Headers({ 'cf-connecting-ip': '198.51.100.7', cookie: 'a=1' }), SECRET)!;
    expect(out.get('x-haestore-client-ip')).toBe('198.51.100.7');
    expect(out.get('x-haestore-proxy-secret')).toBe(SECRET);
    expect(out.get('cookie')).toBe('a=1');
  });

  it('overwrites an address the client sent itself', () => {
    const out = stampClientIp(
      new Headers({ 'cf-connecting-ip': '198.51.100.7', 'x-haestore-client-ip': '10.0.0.1' }),
      SECRET,
    )!;
    expect(out.get('x-haestore-client-ip')).toBe('198.51.100.7');
  });

  it('does nothing without a secret — local development', () => {
    expect(stampClientIp(new Headers({ 'cf-connecting-ip': '198.51.100.7' }), undefined)).toBeNull();
  });

  it('does nothing when Cloudflare supplied no address', () => {
    expect(stampClientIp(new Headers(), SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, see it fail** — `npm --prefix front-end test -- src/lib/proxy/client-ip.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `front-end/src/lib/proxy/client-ip.ts` (relative imports only; nothing here imports `@/`)

```ts
/**
 * The shopper's address, carried to the API across the Worker's `/api/*` proxy.
 *
 * The API sees every proxied call arrive from Cloudflare, so its per-IP sign-in throttle
 * would put every shopper in one bucket. Cloudflare tells the Worker who is really
 * calling (`cf-connecting-ip`, which a client cannot set); this copies it into a header
 * the API reads, beside a secret that proves the Worker wrote it. Anything the client
 * sent under the same name is overwritten, never forwarded.
 *
 * The API side is back-end/src/modules/auth/client-ip.ts.
 */
export const CLIENT_IP_HEADER = 'x-haestore-client-ip';
export const PROXY_SECRET_HEADER = 'x-haestore-proxy-secret';

export function stampClientIp(incoming: Headers, secret: string | undefined): Headers | null {
  const address = incoming.get('cf-connecting-ip');
  if (!secret || !address) return null;
  const headers = new Headers(incoming);
  headers.set(CLIENT_IP_HEADER, address);
  headers.set(PROXY_SECRET_HEADER, secret);
  return headers;
}
```

- [ ] **Step 4: Run, see it pass** → PASS (4).

- [ ] **Step 5: Wire into middleware** — in `front-end/src/middleware.ts`: import `stampClientIp` from `@/lib/proxy/client-ip`; update the doc comment to "Three jobs" with a third item: *"3. **The shopper's address on proxied API calls**, which the API needs for its throttle and cannot otherwise see (lib/proxy/client-ip.ts)."*; add as the first branch of `middleware()`:

```ts
  if (url.pathname.startsWith('/api/')) {
    const headers = stampClientIp(request.headers, process.env.PROXY_SHARED_SECRET);
    return headers ? NextResponse.next({ request: { headers } }) : NextResponse.next();
  }
```

and add `'/api/:path*'` to `config.matcher`, extending the matcher comment: *"…and `/api/*`, where the only job is stamping the shopper's address."*

- [ ] **Step 6: Check and commit**

Run: `npm --prefix front-end run check` → green.

```bash
cd front-end && git add src/lib/proxy src/middleware.ts
git commit -m "feat(proxy): stamp the shopper's address on proxied API calls

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

(Whether the stamp survives the rewrite to an external origin under OpenNext is proven in Task 7, not assumed.)

---

### Task 4: Security headers, CSP and the build-time live-key guard

**Files:**
- Create: `front-end/src/lib/security/headers.ts`
- Create: `front-end/src/lib/security/headers.test.ts`
- Create: `front-end/src/lib/security/payment-mode.ts`
- Create: `front-end/src/lib/security/payment-mode.test.ts`
- Modify: `front-end/next.config.ts`

**Interfaces:**
- Produces: `contentSecurityPolicy(): string`, `securityHeaders(): { key: string; value: string }[]`, `assertTestModeKeys(env: Record<string, string | undefined>): void` (throws `Error` naming the key).

- [ ] **Step 1: Failing tests** — `headers.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from './headers';

const directive = (name: string) =>
  contentSecurityPolicy()
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `)) ?? '';

describe('contentSecurityPolicy', () => {
  it('allows both image CDNs', () => {
    expect(directive('img-src')).toContain('https://res.cloudinary.com');
    expect(directive('img-src')).toContain('https://images.unsplash.com');
  });

  it("allows the console's direct upload to Cloudinary", () => {
    expect(directive('connect-src')).toContain('https://api.cloudinary.com');
  });

  it('allows Stripe.js and its frames', () => {
    expect(directive('script-src')).toContain('https://js.stripe.com');
    expect(directive('frame-src')).toContain('https://js.stripe.com');
    expect(directive('frame-src')).toContain('https://hooks.stripe.com');
    expect(directive('connect-src')).toContain('https://api.stripe.com');
  });

  it('allows the PayPal SDK, sandbox included', () => {
    expect(directive('script-src')).toContain('https://www.paypal.com');
    expect(directive('frame-src')).toContain('https://*.paypal.com');
  });

  it('closes the doors a CSP exists for', () => {
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
  });
});

describe('securityHeaders', () => {
  it('sends HSTS without includeSubDomains — the domain has other tenants', () => {
    const hsts = securityHeaders().find((h) => h.key === 'Strict-Transport-Security')!;
    expect(hsts.value).toBe('max-age=31536000');
  });

  it('includes the CSP', () => {
    expect(securityHeaders().map((h) => h.key)).toContain('Content-Security-Policy');
  });
});
```

`payment-mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertTestModeKeys } from './payment-mode';

describe('assertTestModeKeys', () => {
  it('accepts a test publishable key and an empty one', () => {
    expect(() => assertTestModeKeys({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_x' })).not.toThrow();
    expect(() => assertTestModeKeys({})).not.toThrow();
  });

  it('refuses a live publishable key, by name', () => {
    expect(() => assertTestModeKeys({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_x' })).toThrow(
      /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.*ADR-016/,
    );
  });
});
```

- [ ] **Step 2: Run, see them fail** — `npm --prefix front-end test -- src/lib/security` → FAIL (modules missing).

- [ ] **Step 3: Implement** — `front-end/src/lib/security/headers.ts`

```ts
/**
 * Response headers for every page, and the Content-Security-Policy in particular.
 *
 * **`script-src` carries `'unsafe-inline'`, on purpose.** The App Router streams its
 * payload through inline scripts, which a CSP accepts only with a per-request nonce or
 * `'unsafe-inline'`. A nonce means middleware on every page render — and a page that
 * reads a nonce can no longer be cached, which undoes the storefront's ISR. What the
 * policy still does is real: no framing (`frame-ancestors`), no plugins, no `<base>`
 * hijack, forms that post only here, and scripts, frames and connections only from the
 * origins named below. JSON-LD is safe for a different reason — its serialiser
 * (lib/seo/structured-data.ts).
 *
 * Every origin is here because something on the site needs it:
 *   - Stripe.js and its 3-D Secure frames (hooks.stripe.com)
 *   - the PayPal SDK, which loads further scripts, frames and images from paypal.com and
 *     paypalobjects.com, sandbox included
 *   - photographs from Cloudinary and Unsplash (ADR-015)
 *   - the console's signed upload straight to api.cloudinary.com
 */
const STRIPE = ['https://js.stripe.com', 'https://*.js.stripe.com'];
const PAYPAL = ['https://www.paypal.com', 'https://*.paypal.com', 'https://*.paypalobjects.com'];

const POLICY: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'", ...STRIPE, ...PAYPAL],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': [
    "'self'",
    'data:',
    'blob:',
    'https://res.cloudinary.com',
    'https://images.unsplash.com',
    'https://*.stripe.com',
    'https://*.paypal.com',
    'https://*.paypalobjects.com',
  ],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'https://api.cloudinary.com', 'https://api.stripe.com', ...PAYPAL],
  'frame-src': [...STRIPE, 'https://hooks.stripe.com', 'https://*.paypal.com'],
  'frame-ancestors': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
};

export function contentSecurityPolicy(): string {
  return [
    ...Object.entries(POLICY).map(([name, sources]) => `${name} ${sources.join(' ')}`),
    'upgrade-insecure-requests',
  ].join('; ');
}

export function securityHeaders(): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
    // No includeSubDomains: it would bind every subdomain of whatever domain the shop is
    // deployed under, which this repository does not own the rest of.
    { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self)' },
  ];
}
```

`front-end/src/lib/security/payment-mode.ts`

```ts
/**
 * The storefront half of ADR-016: the Worker is not built with a live Stripe key.
 *
 * Called from next.config.ts, so a live publishable key fails `next build` (and so
 * `cf:build`) rather than shipping a checkout that would take real money. The secret
 * half is refused by the API at boot. A PayPal client id carries no mode, so the sandbox
 * is enforced on the API's `PAYPAL_ENV` instead.
 */
export function assertTestModeKeys(env: Record<string, string | undefined>): void {
  const key = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
  if (key.startsWith('pk_live_')) {
    throw new Error(
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is a live key. Hæstore runs in Stripe test mode only — use a pk_test_ key (ADR-016).',
    );
  }
}
```

- [ ] **Step 4: Run, see them pass** → PASS (9).

- [ ] **Step 5: Wire into `next.config.ts`** — relative imports (`./src/lib/security/headers`, `./src/lib/security/payment-mode`); call `assertTestModeKeys(process.env)` at module top level, after `API_ORIGIN`; add to `nextConfig`:

```ts
  async headers() {
    /**
     * Production only: the development server needs `eval` for Fast Refresh, and a CSP
     * that has to be loosened to work in development is one nobody trusts when it
     * reports. `next build` — and so the Worker — always runs as production.
     */
    if (process.env.NODE_ENV !== 'production') return [];
    return [{ source: '/:path*', headers: securityHeaders() }];
  },
```

- [ ] **Step 6: Prove the build refuses a live key**

Run: `cd front-end && NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_nope npx next build 2>&1 | grep -m1 ADR-016`
Expected: the error line. (Stop the build once it prints, if it gets further.)

- [ ] **Step 7: Check and commit** — `npm --prefix front-end run check && npm --prefix front-end run build` green.

```bash
cd front-end && git add src/lib/security next.config.ts
git commit -m "feat(security): CSP and security headers; refuse a live Stripe key at build

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Worker cache, bindings, env templates and honest Publish copy

**Files:**
- Modify: `front-end/open-next.config.ts`
- Modify: `front-end/wrangler.jsonc`
- Create: `front-end/public/_headers`
- Modify: `front-end/.env.example`
- Create: `front-end/.env.production.example`
- Modify: `front-end/src/components/admin/storefront-composer.tsx:94` (publish toast description)
- Modify: `front-end/.gitignore` only if `.env.production.example` would be ignored by an `.env*` rule (check with `git check-ignore -v`).

- [ ] **Step 1: `open-next.config.ts`**

```ts
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import kvIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache';
import memoryQueue from '@opennextjs/cloudflare/overrides/queue/memory-queue';

/**
 * Pages and fetches are cached in Workers KV (`NEXT_INC_CACHE_KV`), and OpenNext keys
 * every entry by build id — so a deploy never serves a page rendered against the
 * previous API contract, which is what crashed a product page in Phase 9.
 *
 * Time-based revalidation (60s products, 300s home, 3600s sitemap) runs through the
 * memory queue, which asks the Worker itself (`WORKER_SELF_REFERENCE`) to re-render.
 *
 * **There is no tag cache**, deliberately: `revalidateTag` has one caller — the
 * composer's Publish — and a tag cache would cost a database read on every cached page
 * to make that one action instant rather than within five minutes. docs/DEPLOYMENT.md
 * says how to add one (D1) if that trade changes.
 */
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  queue: memoryQueue,
});
```

Verify the two import paths exist in `node_modules/@opennextjs/cloudflare/package.json` `exports` before relying on them; adjust to the exported spelling if different.

- [ ] **Step 2: `wrangler.jsonc`** — add, keeping existing keys and comments:

```jsonc
  // Page and fetch cache. Create once with
  //   npx wrangler kv namespace create NEXT_INC_CACHE_KV
  // and paste the id here. See docs/DEPLOYMENT.md.
  "kv_namespaces": [{ "binding": "NEXT_INC_CACHE_KV", "id": "REPLACE_WITH_KV_NAMESPACE_ID" }],
  // The revalidation queue re-renders a stale page by calling this Worker.
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "heastore-web" }],
  // Runtime values. API_ORIGIN is ALSO needed at build time (the /api rewrite is fixed
  // then) — set it in both places. PROXY_SHARED_SECRET is a secret, never here:
  //   npx wrangler secret put PROXY_SHARED_SECRET
  "vars": { "API_ORIGIN": "https://api.example.com" },
```

- [ ] **Step 3: `public/_headers`**

```
# Workers static assets. Everything under /_next/static is content-hashed, so it can
# be cached forever; a new build produces new names.
/_next/static/*
  Cache-Control: public, max-age=31536000, immutable
```

- [ ] **Step 4: Env templates**
  - `.env.example`: header says local development; add `# PROXY_SHARED_SECRET — production only; see .env.production.example`.
  - `.env.production.example`: each variable with *when it is read*:
    ```
    # Build-time values for `npm run cf:build`, baked into the Worker.
    # Export these in the shell (or a CI job) that runs the build. See docs/DEPLOYMENT.md.
    #
    # BOTH build time and runtime: the /api rewrite is fixed at build, server components
    # read it at runtime (wrangler.jsonc "vars").
    API_ORIGIN=https://api.example.com
    NEXT_PUBLIC_SITE_URL=https://shop.example.com
    NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=
    # Test mode only. A pk_live_ key fails the build (ADR-016).
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_
    # A sandbox app's client id.
    NEXT_PUBLIC_PAYPAL_CLIENT_ID=
    #
    # Runtime secret, not a build value: npx wrangler secret put PROXY_SHARED_SECRET
    # Same value as the API's PROXY_SHARED_SECRET.
    ```

- [ ] **Step 5: Composer copy** — the publish `run(...)` options become:

```ts
      {
        done: `Version ${draft.version} is published`,
        // Instant here; on the deployed Worker the cached front page turns over within
        // five minutes, because there is no tag cache (open-next.config.ts).
        description: 'Visitors see it within five minutes.',
      },
```

Grep the e2e suite and unit tests for `is live` / `shows it now` and update any assertion.

- [ ] **Step 6: Build the Worker and measure**

Run: `npm --prefix front-end run cf:build && (cd front-end && npx wrangler deploy --dry-run --outdir=.wrangler/dry 2>&1 | grep -i 'total upload')`
Expected: build succeeds; record the gzipped size (was 1501.33 KiB) — must be under 3072 KiB. The dry run must not complain about the placeholder KV id; if it does, record the message for DEPLOYMENT.md.

- [ ] **Step 7: Check and commit** — `npm --prefix front-end run check`.

```bash
cd front-end && git add open-next.config.ts wrangler.jsonc public/_headers .env.example .env.production.example src/components/admin/storefront-composer.tsx
git commit -m "feat(deploy): KV page cache, Worker bindings and production env template

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: VPS compose and production API env template

**Files:**
- Create: `deploy/vps/compose.yml`
- Create: `deploy/vps/.env.example`
- Modify: root `.gitignore` so `deploy/vps/.env` is ignored and `deploy/vps/.env.example` is not
- Modify: `back-end/Dockerfile` (a `seed` stage; the runtime image is unchanged)

Why the seed runs in a container: it needs Mongo **and Redis** (and Meilisearch for the
reindex), and on the VPS Redis and Meilisearch publish no port. A one-off service on the
compose network reaches both without opening anything. The production image cannot seed
(no `tsx`, no `src`), so the seed gets its own stage.

- [ ] **Step 1: `deploy/vps/compose.yml`**

```yaml
# Hæstore on the VPS: the API and the two datastores it keeps beside it.
#
# MongoDB is NOT here — it is external (a hosted replica set). Nothing publishes a port
# except the API, and that only on the docker bridge gateway, where the host's nginx
# reaches it. See docs/DEPLOYMENT.md.
#
#   cd deploy/vps && docker compose up -d --build

name: haestore-prod

services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    # Sessions and sign-in challenges live here, so it persists (AOF) and has a password
    # even though no port is published: defence in depth for the only store holding
    # live sessions.
    command: ["sh", "-c", "exec redis-server --appendonly yes --requirepass \"$$REDIS_PASSWORD\""]
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD:?set REDIS_PASSWORD in deploy/vps/.env}
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a \"$$REDIS_PASSWORD\" --no-auth-warning ping | grep -q PONG"]
      interval: 5s
      timeout: 3s
      retries: 20

  meilisearch:
    image: getmeili/meilisearch:v1.11
    restart: unless-stopped
    environment:
      MEILI_MASTER_KEY: ${MEILI_MASTER_KEY:?set MEILI_MASTER_KEY in deploy/vps/.env}
      # production refuses to start without a master key of at least 16 bytes, and
      # turns off the unauthenticated search preview.
      MEILI_ENV: production
      MEILI_NO_ANALYTICS: "true"
    volumes:
      - meili-data:/meili_data
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:7700/health"]
      interval: 5s
      timeout: 3s
      retries: 20

  api:
    build:
      context: ../../back-end
      dockerfile: Dockerfile
    image: haestore-api:latest
    restart: unless-stopped
    env_file: ./.env
    environment:
      NODE_ENV: production
      PORT: 5000
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
      MEILISEARCH_HOST: http://meilisearch:7700
      MEILISEARCH_API_KEY: ${MEILI_MASTER_KEY}
    ports:
      # The bridge gateway, not 0.0.0.0: the host's nginx proxies here; the internet can't.
      - "172.17.0.1:5003:5000"
    depends_on:
      redis: { condition: service_healthy }
      meilisearch: { condition: service_healthy }

  # One-off: `docker compose --profile seed run --rm seed --allow-production`
  # See docs/SEEDING.md and docs/DEPLOYMENT.md. Never starts with `up`.
  seed:
    profiles: ["seed"]
    build:
      context: ../../back-end
      dockerfile: Dockerfile
      target: seed
    env_file: ./.env
    environment:
      NODE_ENV: production
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
      MEILISEARCH_HOST: http://meilisearch:7700
      MEILISEARCH_API_KEY: ${MEILI_MASTER_KEY}
      # Unsplash's download ledger is per machine (SEEDING.md); a volume keeps it across runs.
      UNSPLASH_CACHE_DIR: /unsplash-cache
      # Only the jobs' owner — the API container — drains the outboxes.
      ORDER_JOBS_ENABLED: "false"
      SEARCH_INDEXING_ENABLED: "false"
    volumes:
      - unsplash-ledger:/unsplash-cache
    depends_on:
      redis: { condition: service_healthy }
      meilisearch: { condition: service_healthy }

volumes:
  redis-data:
  meili-data:
  unsplash-ledger:
```

And in `back-end/Dockerfile`, after the `build` stage and before `runtime`, a stage that only a `target: seed` build reaches:

```dockerfile
# ---- seed (one-off, never the runtime image) --------------------------------
# The seed runs from TypeScript source with tsx, which the runtime image deliberately
# lacks. Built only by `docker compose --profile seed` (deploy/vps/compose.yml).
FROM node:22-alpine AS seed
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
USER node
ENTRYPOINT ["npx", "tsx", "src/seed/seed.cli.ts"]
```

Check the seed CLI only writes under `UNSPLASH_CACHE_DIR` (never beside `src`), and that the `node` user can write the volume — if not, `RUN mkdir /unsplash-cache && chown node:node /unsplash-cache` in the stage.

The API's Dockerfile `HEALTHCHECK` already covers it. A `REDIS_PASSWORD` with URL-special characters would break `REDIS_URL`; the template says to use hex (`openssl rand -hex 32`).

- [ ] **Step 2: `deploy/vps/.env.example`** — every key from `back-end/.env.example` that production needs, grouped, with production values or generation commands:
  - Compose-only: `REDIS_PASSWORD=` / `MEILI_MASTER_KEY=` — `openssl rand -hex 32`.
  - Runtime: `LOG_LEVEL=info`, `PUBLIC_URL=https://api.example.com`, `WEB_URL=https://shop.example.com`, `ALLOWED_ORIGINS=https://shop.example.com`.
  - `MONGODB_URL=mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/haestore?retryWrites=true&w=majority` with the comment: must be a replica set; no `directConnection`.
  - `OTP_PEPPER=`, `GUEST_COOKIE_SECRET=`, `PROXY_SHARED_SECRET=` — `openssl rand -hex 32`; the last must equal the Worker's secret.
  - `ADMIN_EMAILS=`.
  - `MAIL_DRIVER=gmail-api` and the four `MAIL_*` keys, `MAIL_FROM_ADDRESS=`, `MAIL_FROM_NAME=Hæstore`.
  - Cloudinary's four keys.
  - Payments block titled *test mode only — live keys are refused at boot (ADR-016)*: `STRIPE_SECRET_KEY=sk_test_`, `STRIPE_WEBHOOK_SECRET=` (optional — the reconcile path works without it), `PAYPAL_CLIENT_ID=`, `PAYPAL_CLIENT_SECRET=`, `PAYPAL_ENV=sandbox`, `PAYPAL_WEBHOOK_ID=` (optional).
  - `CHECKOUT_RESERVATION_MINUTES=30`, `ORDER_JOBS_ENABLED=true`, `SEARCH_INDEXING_ENABLED=true`.
  - No `UNSPLASH_*` (the image cannot seed; seeding runs from a checkout).
  - No `REDIS_URL`/`MEILISEARCH_*` (compose sets them) — say so in a comment.

- [ ] **Step 3: Validate the file**

Run: `cd deploy/vps && cp .env.example .env.check && REDIS_PASSWORD=x MEILI_MASTER_KEY=y docker compose --env-file .env.check config >/dev/null && echo ok; rm .env.check`
Expected: `ok`. (Compose reads `env_file: ./.env` at `up`, not at `config`; if `config` insists on `.env` existing, copy to `.env` temporarily and delete it after.)

- [ ] **Step 4: Run it locally for real** — the dev Mongo is bound to the host's loopback, which a container cannot reach, and the dev infrastructure is not to be changed. So a scratchpad override supplies a throwaway replica set on the compose network, standing in for the external cluster. Write `<scratchpad>/vps-check.override.yml`:

```yaml
services:
  mongo-check:
    image: mongo:7
    command: ["mongod", "--replSet", "rs0", "--bind_ip_all"]
    healthcheck:
      test: >
        mongosh --quiet --eval "try { rs.status().ok } catch (e) {
          rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo-check:27017'}]}).ok }"
      interval: 5s
      retries: 30
  api:
    environment:
      MONGODB_URL: mongodb://mongo-check:27017/haestore?replicaSet=rs0
    depends_on:
      mongo-check: { condition: service_healthy }
  seed:
    environment:
      MONGODB_URL: mongodb://mongo-check:27017/haestore?replicaSet=rs0
    depends_on:
      mongo-check: { condition: service_healthy }
```

Note the URL has **no** `directConnection` — this is the production shape. Then, from `deploy/vps/` with a `.env` made from the template (local test values, `MAIL_DRIVER=console`, no payment keys):

```bash
F="-f compose.yml -f <scratchpad>/vps-check.override.yml"
docker compose $F up -d --build
curl -fsS http://172.17.0.1:5003/readyz                              # ready; mongo, redis, meilisearch ok
docker compose $F --profile seed run --rm seed --allow-production --no-photos
curl -fsS 'http://172.17.0.1:5003/api/catalog/products?q=mug' | head -c 300   # products, via the relay
docker compose $F logs meilisearch | grep -i production
docker compose $F down -v && rm .env
```

Expected: `readyz` ready before seeding; the seed reports its counts; the product search returns mugs (proving the API's relay indexed what the seed wrote); Meilisearch logs production mode. Confirm `172.17.0.1:5003` is free first (`ss -ltn | grep 5003`). If `--no-photos` is not a flag the CLI accepts, read `seed.cli.ts` and use what it does accept.

- [ ] **Step 5: Commit (two repos)**

```bash
(cd back-end && git add Dockerfile && git commit -m "build: a seed stage for one-off seeding on the deployment host

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>")
git add deploy/vps/compose.yml deploy/vps/.env.example .gitignore
git commit -m "feat(deploy): VPS compose for the API, Redis and Meilisearch

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Smoke script, and the Worker proven locally

**Files:**
- Create: `scripts/smoke-deploy.mjs`
- Modify: root `package.json` (`"smoke": "node scripts/smoke-deploy.mjs"`)

**Interfaces:**
- CLI: `node scripts/smoke-deploy.mjs <web-url> <api-url>` → prints one line per check, exits 1 if any fails.

- [ ] **Step 1: Write the script** — plain Node 22, `fetch`, no dependencies, same style as `probe-infra.mjs` (read it first and match its output format). Checks, in order:
  1. `GET <api>/healthz` → 200.
  2. `GET <api>/readyz` → 200 and body reports mongo, redis, meilisearch ok.
  3. `GET <web>/` → 200, `text/html`, has `Content-Security-Policy` containing `frame-ancestors 'none'`, and `Strict-Transport-Security` (skip HSTS when `<web>` is `http:`, printing `skipped`).
  4. `GET <web>/sitemap.xml` → 200, contains `<urlset`; take the first `/product/` URL from it.
  5. `GET` that product URL (rewritten onto `<web>`'s origin) → 200 and contains `application/ld+json`.
  6. `GET <web>/api/does-not-exist` → 404 **JSON** with a `requestId` — proves the Worker's rewrite reaches Express, not a Next 404.
  7. `GET <web>/_next/static/...` for one asset linked from the home HTML → `Cache-Control` contains `immutable` (skip with a note if the preview server does not apply `_headers`).
- [ ] **Step 2: Run the Worker locally against the dev API** — `docker compose up -d`; API from `back-end` with `PROXY_SHARED_SECRET=<32+ chars>` and `MAIL_DRIVER=console`; `front-end/.dev.vars` (gitignored — confirm) with `API_ORIGIN=http://127.0.0.1:5000` and the same `PROXY_SHARED_SECRET`; `API_ORIGIN=http://127.0.0.1:5000 npm --prefix front-end run cf:build && npm --prefix front-end run cf:preview`.
- [ ] **Step 3: Smoke it** — `npm run smoke -- http://localhost:8787 http://127.0.0.1:5000`. All pass (HSTS skipped on http).
- [ ] **Step 4: Prove the IP stamp crosses the rewrite** — `wrangler dev` does not set `cf-connecting-ip` from a client, so send it: `curl -s -X POST http://localhost:8787/api/auth/otp/request -H 'content-type: application/json' -H 'origin: http://localhost:8787' -H 'cf-connecting-ip: 198.51.100.77' -d '{"email":"smoke@haestore.test"}'`, then check Redis for `otp:rl:ip:198.51.100.77` (`docker exec haestore-redis redis-cli --scan --pattern 'otp:rl:ip:*'`). Present ⇒ stamped through. Also run it once with the Worker's secret wrong/absent and confirm the key is `otp:rl:ip:127.0.0.1` instead. If the stamp does NOT survive the rewrite, stop and report: the fallback design is a Route Handler proxy, which is a spec change.
- [ ] **Step 5: CSP sweep in a real browser** — Playwright against `http://localhost:8787`, collecting `console` messages matching `Content Security Policy` / `Refused to` and `securitypolicyviolation` events, across: `/`, a shelf with a filter, a product page, the bag drawer, sign-in (code from `/api/dev/outbox`), `/account`, checkout paying with Stripe `4242 4242 4242 4242` through to confirmation, the PayPal button rendering on checkout (sandbox client id; do not complete a PayPal payment unless sandbox buyer credentials are in `back-end/.env`), `/admin`, and a photograph upload in the console. Expected: zero violations. Any violation: add the exact origin to `headers.ts` **with a test for it**, rebuild, re-sweep.
- [ ] **Step 6: Commit (root repo)**

```bash
git add scripts/smoke-deploy.mjs package.json
git commit -m "feat(deploy): signed-out smoke check for a deployment

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: DEPLOYMENT.md, ADR-016 and the phase record

**Files:**
- Create: `docs/DEPLOYMENT.md`
- Create: `docs/decisions/ADR-016-test-mode-only.md`
- Modify: `docs/decisions/README.md` (index), `README.md` (DEPLOYMENT link already present — verify), `docs/LOCAL-DEV.md` (`cf:preview` with `.dev.vars` and `PROXY_SHARED_SECRET`), `docs/PROGRESS.md`

- [ ] **Step 1: ADR-016** — match the existing ADRs' headings (read ADR-015 first). Context: a portfolio shop, never taking money; a live key would work silently. Decision: refused at API boot (`sk_live_`, `rk_live_`, `PAYPAL_ENV=live`) and at Worker build (`pk_live_`). Consequences: making the shop real is a code change plus this ADR superseded, which is the point; `whsec_` and PayPal client ids cannot be told apart by mode and are not checked.

- [ ] **Step 2: DEPLOYMENT.md** — sections, each with exact commands:
  1. *Shape* — the topology diagram from the spec.
  2. *Before the first deploy* — accounts; a hosted Mongo replica set (Atlas works; no `directConnection`; the IP allowlist must include the VPS); Stripe test keys; a PayPal sandbox app; Gmail API credentials (link GMAIL-API-MIGRATION-NOTE.md); Cloudinary.
  3. *The API on the VPS* — clone the root and `back-end` repos side by side as locally; `cp deploy/vps/.env.example deploy/vps/.env`, generate secrets; `docker compose up -d --build`; `curl http://172.17.0.1:5003/readyz`.
  4. *What nginx must do for 5003* — `proxy_pass http://172.17.0.1:5003;`; `proxy_set_header Host $host; X-Forwarded-For $proxy_add_x_forwarded_for; X-Forwarded-Proto $scheme;` (the API sets `trust proxy 1` — exactly one hop); `client_max_body_size 1m` or more (webhook bodies are read raw up to 1 MB; JSON bodies are smaller); don't strip or rewrite `Set-Cookie`, and don't add `proxy_cookie_*`; pass the `x-haestore-*` headers through untouched (nginx does by default — only `underscores_in_headers`-style rules or header allowlists would drop them); a `proxy_read_timeout` of at least 30s. If the API hostname is proxied through Cloudflare (orange cloud), SSL mode must be Full (strict).
  5. *The Worker* — `npx wrangler login`; `npx wrangler kv namespace create NEXT_INC_CACHE_KV` and paste the id; `npx wrangler secret put PROXY_SHARED_SECRET`; set the `vars`; export the build-time values from `.env.production.example`; `npm run cf:build`, then `npm run cf:deploy`; the custom domain.
  6. *Seeding* — on the VPS, `docker compose --profile seed run --rm seed --allow-production` (`--reset` to start again). Why a container: Redis and Meilisearch publish no port. `UNSPLASH_ACCESS_KEY` in `deploy/vps/.env` if downloads are to be reported; the ledger lives in the `unsplash-ledger` volume. The exact command verified in Task 6.
  7. *Payments, test mode* — ADR-016; the reconcile path means no webhook is needed; optionally register test-mode webhooks at `https://<api>/api/webhooks/stripe` and `/paypal` and set the secret/id.
  8. *Checking a deployment* — `npm run smoke -- https://shop… https://api…`; the signed-out limitation.
  9. *Redeploying and rolling back* — API: `git pull && docker compose up -d --build`; rollback by checking out the previous commit and rebuilding. Worker: `npx wrangler rollback`; old KV entries are keyed by build id, so a rollback reads its own build's entries and a forward deploy starts cold. The Publish delay and why.
  10. *Adding a tag cache later* — D1: `wrangler d1 create`, binding `NEXT_TAG_CACHE_D1`, `tagCache: d1NextTagCache` in `open-next.config.ts`, and the cost it adds.
  11. *Bundle size* — the measured figure from Task 5 against 3 MiB.

- [ ] **Step 3: PROGRESS.md** — Phase 11 row → ✅ Complete (config-complete; deploy run by the owner). A Phase 11 section in the established shape: Done; Verified, not assumed (test counts before → after, break-it checks, the IP-stamp proof, the CSP sweep result, the bundle size, the local VPS compose run); Decisions; Deviations (no deploy performed; no tag cache; no nginx config; external Mongo); Defects found; a *Next action* that is the owner's first-deploy checklist pointing to DEPLOYMENT.md.

- [ ] **Step 4: Commit (root repo)**

```bash
git add docs/DEPLOYMENT.md docs/decisions/ADR-016-test-mode-only.md docs/decisions/README.md docs/LOCAL-DEV.md docs/PROGRESS.md README.md
git commit -m "docs: complete phase 11 — deployment runbook and ADR-016

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review against the spec

- D1 KV cache, no tag cache → Task 5. D2 memory queue → Task 5. D3 CSP → Task 4, swept in Task 7. D4 client IP → Tasks 2, 3, proven in 7. D5 live keys → Tasks 1, 4, ADR in 8. D6 external Mongo → Tasks 1 (wording), 6, 8. D7 nginx requirements → Task 8 §4.
- Spec's "pk_live_ build guard", `_headers`, env templates, Publish copy → Tasks 4, 5. Smoke script → Task 7. Verification items 1–6 → Tasks 1–7.
