#!/usr/bin/env node
/**
 * Checks a deployment from the outside, signed out.
 *
 *   npm run smoke -- https://shop.example.com https://api.example.com
 *
 * The signed-out half of what the end-to-end suite proves: a deployment cannot be signed
 * into by script, because sign-in codes come from the development outbox, which
 * production does not mount. What this can prove is that the pieces are joined — the API
 * reaches its datastores, the Worker renders from the API, the Worker's /api proxy
 * reaches Express, and the headers the deploy added are on the wire. See
 * docs/DEPLOYMENT.md.
 */
const [WEB, API] = process.argv.slice(2).map((u) => u?.replace(/\/+$/, ''));
if (!WEB || !API) {
  console.error('usage: node scripts/smoke-deploy.mjs <web-url> <api-url>');
  process.exit(2);
}

const results = [];
const check = async (name, fn) => {
  try {
    const note = await fn();
    results.push([note?.skipped ? 'SKIP' : 'PASS', note?.skipped ? `${name} — ${note.skipped}` : name]);
  } catch (e) {
    results.push(['FAIL', `${name}\n        ${e.message.split('\n')[0]}`]);
  }
};

const get = async (url) => {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  return { response, body: await response.text() };
};
const expectStatus = (response, status) => {
  if (response.status !== status) throw new Error(`expected ${status}, got ${response.status}`);
};

await check('api: /healthz answers', async () => {
  expectStatus((await get(`${API}/healthz`)).response, 200);
});

await check('api: /readyz reports mongo, redis and meilisearch', async () => {
  const { response, body } = await get(`${API}/readyz`);
  expectStatus(response, 200);
  const checks = JSON.parse(body).checks ?? {};
  const down = ['mongo', 'redis', 'meilisearch'].filter((name) => !checks[name]?.ok);
  if (down.length > 0) throw new Error(`not ok: ${down.join(', ')}`);
});

let home = '';
await check('web: the front page renders', async () => {
  const { response, body } = await get(`${WEB}/`);
  expectStatus(response, 200);
  if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('not HTML');
  home = body;
});

await check('web: the Content-Security-Policy is sent', async () => {
  const { response } = await get(`${WEB}/`);
  const csp = response.headers.get('content-security-policy') ?? '';
  if (!csp.includes("frame-ancestors 'none'")) throw new Error(`no CSP, or not ours: "${csp}"`);
});

await check('web: HSTS is sent', async () => {
  if (WEB.startsWith('http:')) return { skipped: 'plain http, where HSTS means nothing' };
  const { response } = await get(`${WEB}/`);
  if (!response.headers.get('strict-transport-security')) throw new Error('missing');
});

let productUrl = '';
await check('web: /sitemap.xml lists products', async () => {
  const { response, body } = await get(`${WEB}/sitemap.xml`);
  expectStatus(response, 200);
  const match = /<loc>([^<]*\/product\/[^<]+)<\/loc>/.exec(body);
  if (!match) throw new Error('no product URL in the sitemap');
  // The sitemap names the canonical site; fetch the same path from the host under test.
  productUrl = `${WEB}${new URL(match[1]).pathname}`;
});

await check('web: a product page renders with its structured data', async () => {
  if (!productUrl) return { skipped: 'no product URL from the sitemap' };
  const { response, body } = await get(productUrl);
  expectStatus(response, 200);
  if (!body.includes('application/ld+json')) throw new Error('no JSON-LD on the page');
});

await check("web: /api/* reaches the API through the Worker's proxy", async () => {
  // A Next 404 would be HTML. The API's own 404 is JSON with a requestId.
  const { response, body } = await get(`${WEB}/api/smoke-check-no-such-route`);
  expectStatus(response, 404);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('a 404, but not JSON — the Worker answered, not the API');
  }
  if (!JSON.stringify(parsed).includes('requestId')) throw new Error('JSON without a requestId');
});

await check('web: hashed assets are cached as immutable', async () => {
  const asset = /\/_next\/static\/[^"'\s]+\.js/.exec(home)?.[0];
  if (!asset) return { skipped: 'no script found on the front page' };
  const { response } = await get(`${WEB}${asset}`);
  expectStatus(response, 200);
  const cacheControl = response.headers.get('cache-control') ?? '';
  if (!cacheControl.includes('immutable')) throw new Error(`cache-control: "${cacheControl}"`);
});

const failed = results.filter(([s]) => s === 'FAIL').length;
const mark = { PASS: '✓', FAIL: '✗', SKIP: '–' };
console.log('');
for (const [status, name] of results) console.log(`  ${mark[status]} ${name}`);
console.log(`\n  ${results.filter(([s]) => s === 'PASS').length}/${results.length} passed\n`);
process.exit(failed > 0 ? 1 : 0);
