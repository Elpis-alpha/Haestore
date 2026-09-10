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

const failed = results.filter(([s]) => s === 'FAIL').length;
console.log('');
for (const [status, name] of results) {
  console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}`);
}
console.log(`\n  ${results.length - failed}/${results.length} passed\n`);
process.exit(failed > 0 ? 1 : 0);
