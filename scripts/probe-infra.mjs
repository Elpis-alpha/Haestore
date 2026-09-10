#!/usr/bin/env node
/**
 * Verifies that local infrastructure supports the four properties this design
 * depends on. Run after `npm run up`, and any time the stack behaves oddly.
 *
 *   node scripts/probe-infra.mjs
 *
 * These are not unit tests of our code — they are assertions about the *platform*.
 * If any fail, the fault is in docker-compose.yml or the connection string, and
 * chasing it in application code will waste hours. See docs/decisions/ADR-002.
 */
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';

const MONGO = process.env.PROBE_MONGODB_URL
  ?? 'mongodb://127.0.0.1:27018/haestore_probe?replicaSet=rs0&directConnection=true';
const REDIS = process.env.PROBE_REDIS_URL ?? 'redis://127.0.0.1:6380';
const MEILI = process.env.PROBE_MEILI_HOST ?? 'http://127.0.0.1:7700';

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', `${name}\n        ${e.constructor.name}: ${e.message.split('\n')[0]}`]);
  }
};

const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 8000 });

await check('mongo: connects from the host with directConnection=true', async () => {
  await client.connect();
  await client.db('admin').command({ ping: 1 });
});

await check('mongo: is a replica set with a PRIMARY', async () => {
  const status = await client.db('admin').command({ replSetGetStatus: 1 });
  if (!status.members?.some((m) => m.stateStr === 'PRIMARY')) {
    throw new Error(`no primary: ${status.members?.map((m) => m.stateStr).join(', ')}`);
  }
});

const db = client.db('haestore_probe');

await check('mongo: multi-document transactions commit (checkout depends on this)', async () => {
  const [a, b] = [db.collection('a'), db.collection('b')];
  await Promise.all([a.deleteMany({}), b.deleteMany({})]);
  const session = client.startSession();
  await session.withTransaction(async () => {
    await a.insertOne({ n: 1 }, { session });
    await b.insertOne({ n: 2 }, { session });
  });
  await session.endSession();
  const [ca, cb] = [await a.countDocuments(), await b.countDocuments()];
  if (ca !== 1 || cb !== 1) throw new Error(`expected 1 and 1, got ${ca} and ${cb}`);
});

await check('mongo: transactions roll back on throw', async () => {
  const a = db.collection('a');
  await a.deleteMany({});
  const session = client.startSession();
  await session
    .withTransaction(async () => {
      await a.insertOne({ n: 1 }, { session });
      throw new Error('deliberate');
    })
    .catch(() => {});
  await session.endSession();
  const count = await a.countDocuments();
  if (count !== 0) throw new Error(`rollback failed; ${count} documents survived`);
});

await check('mongo: change streams deliver (the search outbox depends on this)', async () => {
  const a = db.collection('a');
  const stream = a.watch();
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out after 8s')), 8000);
    stream.on('change', (ev) => { clearTimeout(timer); resolve(ev); });
    stream.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
  await new Promise((r) => setTimeout(r, 500));
  await a.insertOne({ topic: 'probe' });
  const event = await received;
  await stream.close();
  if (event.operationType !== 'insert') throw new Error(`got ${event.operationType}`);
});

await check('mongo: arrayFilters stock guard refuses to over-decrement', async () => {
  const products = db.collection('products');
  await products.deleteMany({});
  const { insertedId } = await products.insertOne({
    variants: [{ _id: 'v1', status: 'active', stock: { available: 3, reserved: 0 } }],
  });
  const reserve = (qty) =>
    products.findOneAndUpdate(
      {
        _id: insertedId,
        variants: { $elemMatch: { _id: 'v1', status: 'active', 'stock.available': { $gte: qty } } },
      },
      {
        $inc: {
          'variants.$[v].stock.available': -qty,
          'variants.$[v].stock.reserved': +qty,
        },
      },
      { arrayFilters: [{ 'v._id': 'v1' }], returnDocument: 'after' },
    );

  if (!(await reserve(2))) throw new Error('the first reservation should have succeeded');
  if (await reserve(2)) throw new Error('over-decrement was permitted; the guard is broken');

  const { stock } = (await products.findOne({ _id: insertedId })).variants[0];
  if (stock.available !== 1 || stock.reserved !== 2) {
    throw new Error(`unexpected state ${JSON.stringify(stock)}`);
  }
});

await db.dropDatabase().catch(() => {});
/**
 * The three assertions the adaptable attribute design rests on. They are here rather
 * than in a unit test because they are claims about MongoDB, not about our code, and
 * the answer could change with a server version.
 */
await check('mongo: a compound index over one array path is accepted', async () => {
  const c = db.collection('probe_attrs');
  await c.deleteMany({});
  await c.insertOne({
    status: 'active',
    attributes: [
      { key: 'roast', valueString: 'medium' },
      { key: 'weight_g', valueNumber: 250 },
      { key: 'notes', valueStrings: ['floral', 'bright'] },
    ],
  });
  // Two fields of the same array element, and an array *within* an element — both are
  // one multikey path, so both are legal. The multiselect case works.
  await c.createIndex({ status: 1, 'attributes.key': 1, 'attributes.valueString': 1 });
  await c.createIndex({ status: 1, 'attributes.key': 1, 'attributes.valueNumber': 1 });
  await c.createIndex({ status: 1, 'attributes.key': 1, 'attributes.valueStrings': 1 });
});

await check('mongo: two parallel array paths in one index are refused', async () => {
  const c = db.collection('probe_attrs');
  await c.updateOne({}, { $set: { categoryAncestors: ['a', 'b'] } });
  try {
    await c.createIndex({ status: 1, categoryAncestors: 1, 'attributes.key': 1 });
  } catch (error) {
    if (error.codeName === 'CannotIndexParallelArrays') return;
    throw error;
  }
  // This is why categoryAncestors is not in the attribute index: the branch filter and
  // the attribute filter cannot share one index, which is a large part of why the
  // storefront reads from Meilisearch instead (ADR-003).
  throw new Error('expected CannotIndexParallelArrays, but the index was created');
});

await check('mongo: an attribute range query uses an index, not a collection scan', async () => {
  const c = db.collection('probe_attrs');
  const plan = await c
    .find({
      status: 'active',
      attributes: { $elemMatch: { key: 'weight_g', valueNumber: { $gte: 200, $lte: 1000 } } },
    })
    .explain('queryPlanner');
  if (!JSON.stringify(plan.queryPlanner.winningPlan).includes('IXSCAN')) {
    // The claim typed value slots exist to make true: "weight between 250 and 1000 g"
    // is answerable by an index. A Mixed-typed { key, value } pair could not do this,
    // because a Mixed index only compares within one BSON type bracket.
    throw new Error('winning plan has no IXSCAN — typed value slots are not indexable');
  }
  await c.drop();
});

await client.close();

await check('redis: responds, and expiry is enforced on read (OTP depends on this)', async () => {
  const redis = createClient({ url: REDIS });
  await redis.connect();
  await redis.set('haestore:probe', 'value', { PX: 120 });
  if ((await redis.get('haestore:probe')) !== 'value') throw new Error('value did not round-trip');
  await new Promise((r) => setTimeout(r, 250));
  if ((await redis.get('haestore:probe')) !== null) throw new Error('key survived its TTL');
  await redis.quit();
});

await check('meilisearch: is available', async () => {
  const res = await fetch(`${MEILI}/health`);
  if (!res.ok) throw new Error(`health returned ${res.status}`);
  const body = await res.json();
  if (body.status !== 'available') throw new Error(`status is ${body.status}`);
});

/* -------------------------------------------------------------- meilisearch -- */

const MEILI_KEY = process.env.PROBE_MEILI_KEY ?? 'haestore_dev_master_key_change_me';
const MH = { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` };
const PROBE_INDEX = 'probe_products';
const PROBE_REBUILD = 'probe_products_rebuild';

const meili = async (path, options = {}) => {
  const res = await fetch(`${MEILI}${path}`, { headers: MH, ...options });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body)}`);
  return body;
};

const meiliTask = async (uid) => {
  for (let i = 0; i < 200; i += 1) {
    const task = await meili(`/tasks/${uid}`);
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed') throw new Error(`task failed: ${JSON.stringify(task.error)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('task did not settle in 20s');
};

const meiliSearch = (index, body) =>
  meili(`/indexes/${index}/search`, { method: 'POST', body: JSON.stringify(body) });

// A single fixture serves the four claims below.
let meiliReady = false;
await check('meilisearch: accepts a nested attr.<key> as a filterable attribute', async () => {
  await meili(`/indexes/${PROBE_INDEX}`, { method: 'DELETE' }).catch(() => {});
  await meiliTask(
    (
      await meili('/indexes', {
        method: 'POST',
        body: JSON.stringify({ uid: PROBE_INDEX, primaryKey: 'id' }),
      })
    ).taskUid,
  );
  await meiliTask(
    (
      await meili(`/indexes/${PROBE_INDEX}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({
          // The runtime-defined half of the catalogue reaches the index as `attr.<key>`.
          // If dot-notation nesting were not filterable, the whole read model would need
          // a different document shape.
          filterableAttributes: ['status', 'attr.roast', 'attr.weight_g', 'attr.tags'],
          sortableAttributes: ['priceMin'],
        }),
      })
    ).taskUid,
  );
  await meiliTask(
    (
      await meili(`/indexes/${PROBE_INDEX}/documents`, {
        method: 'POST',
        body: JSON.stringify([
          { id: '1', status: 'active', priceMin: 1500, attr: { roast: 'light', weight_g: 250, tags: ['organic'] } },
          { id: '2', status: 'active', priceMin: 2500, attr: { roast: 'medium', weight_g: 250, tags: ['organic'] } },
          { id: '3', status: 'active', priceMin: 3500, attr: { roast: 'dark', weight_g: 1000, tags: [] } },
          { id: '4', status: 'draft', priceMin: 999, attr: { roast: 'light', weight_g: 250, tags: [] } },
        ]),
      })
    ).taskUid,
  );

  const res = await meiliSearch(PROBE_INDEX, {
    filter: 'status = "active" AND attr.roast IN ["dark"]',
    hitsPerPage: 20,
  });
  if (res.hits.length !== 1 || res.hits[0].id !== '3') {
    throw new Error(`expected only product 3, got [${res.hits.map((h) => h.id).join(',')}]`);
  }
  meiliReady = true;
});

await check(
  'meilisearch: a facet filtered on collapses its OWN counts (why the disjunctive pass exists)',
  async () => {
    if (!meiliReady) throw new Error('fixture not built');

    // This is not a bug to route around — it is the correct answer to the question asked.
    // It is asserted because the whole disjunctive-facet arrangement in
    // back-end/src/search/facets.ts is built on it being true, and a future Meilisearch
    // that changed it would make several hundred lines of careful work redundant.
    const narrowed = await meiliSearch(PROBE_INDEX, {
      filter: 'status = "active" AND attr.roast IN ["light"]',
      facets: ['attr.roast'],
      hitsPerPage: 0,
    });
    const keys = Object.keys(narrowed.facetDistribution['attr.roast'] ?? {});
    if (keys.length !== 1 || keys[0] !== 'light') {
      throw new Error(`expected only "light" to survive its own filter, got [${keys.join(',')}]`);
    }

    // And the correction: the same query without that one group's filter.
    const corrected = await meiliSearch(PROBE_INDEX, {
      filter: 'status = "active"',
      facets: ['attr.roast'],
      hitsPerPage: 0,
    });
    const all = corrected.facetDistribution['attr.roast'] ?? {};
    if (Object.keys(all).length !== 3) {
      throw new Error(`expected all three roasts, got ${JSON.stringify(all)}`);
    }
    if (corrected.hits.length !== 0) {
      throw new Error('hitsPerPage:0 should return counts and no documents');
    }
  },
);

await check('meilisearch: an unescaped filter value can reach past its literal', async () => {
  if (!meiliReady) throw new Error('fixture not built');

  // The reason back-end/src/search/filter-expression.ts escapes, stated as a fact about
  // the platform rather than as a precaution. Interpolated raw, a value ends the literal
  // and the rest is parsed as filter syntax — here, one that returns the draft.
  const injected = await meiliSearch(PROBE_INDEX, {
    filter: 'status = "active" AND attr.roast = "light" OR status = "draft"',
    hitsPerPage: 20,
  });
  if (!injected.hits.some((h) => h.id === '4')) {
    throw new Error('expected the raw interpolation to leak the draft; it did not');
  }

  const escaped = await meiliSearch(PROBE_INDEX, {
    filter: 'status = "active" AND attr.roast = "light\\" OR status = \\"draft"',
    hitsPerPage: 20,
  });
  if (escaped.hits.length !== 0) {
    throw new Error(`escaping should make it match nothing, got ${escaped.hits.length} hits`);
  }
});

await check('meilisearch: swapIndexes exchanges settings along with documents', async () => {
  if (!meiliReady) throw new Error('fixture not built');

  // Load-bearing for the rebuild: the swap moves the whole index, so a rebuild index
  // built without settings would go live with no filterable attributes and every
  // storefront filter would start returning 400.
  await meili(`/indexes/${PROBE_REBUILD}`, { method: 'DELETE' }).catch(() => {});
  await meiliTask(
    (
      await meili('/indexes', {
        method: 'POST',
        body: JSON.stringify({ uid: PROBE_REBUILD, primaryKey: 'id' }),
      })
    ).taskUid,
  );
  await meiliTask(
    (
      await meili(`/indexes/${PROBE_REBUILD}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ filterableAttributes: ['status', 'attr.glaze'] }),
      })
    ).taskUid,
  );
  await meiliTask(
    (
      await meili('/swap-indexes', {
        method: 'POST',
        body: JSON.stringify([{ indexes: [PROBE_INDEX, PROBE_REBUILD] }]),
      })
    ).taskUid,
  );

  const settings = await meili(`/indexes/${PROBE_INDEX}/settings`);
  if (!settings.filterableAttributes.includes('attr.glaze')) {
    throw new Error(
      `settings did not travel with the swap: ${JSON.stringify(settings.filterableAttributes)}`,
    );
  }

  await meili(`/indexes/${PROBE_INDEX}`, { method: 'DELETE' }).catch(() => {});
  await meili(`/indexes/${PROBE_REBUILD}`, { method: 'DELETE' }).catch(() => {});
});

const failed = results.filter(([s]) => s === 'FAIL').length;
console.log('');
for (const [status, name] of results) {
  console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}`);
}
console.log(`\n  ${results.length - failed}/${results.length} passed\n`);
process.exit(failed > 0 ? 1 : 0);
