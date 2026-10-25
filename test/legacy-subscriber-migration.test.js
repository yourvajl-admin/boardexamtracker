const test = require('node:test');
const assert = require('node:assert/strict');

const { migrateLegacySubscribers } = require('../src/subscriptions');

const destinationUrl = 'https://new-upstash.mock';
const sourceUrl = 'https://legacy-upstash.mock';
const subscriberKey = 'boardexamtracker:subscribers';
const migrationKey = 'boardexamtracker:migrations:legacy-subscribers:v1';
const lockKey = `${migrationKey}:lock`;

function makeSubscriber(email, extra = {}) {
  return { email, unsubscribeToken: `unsubscribe-${email}`, confirmedAt: 123, ...extra };
}

test('copies legacy subscribers once without deleting or overwriting destination records', async (t) => {
  const originalEnv = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  };
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.UPSTASH_REDIS_REST_URL = destinationUrl;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-destination-token';
  process.env.KV_REST_API_URL = sourceUrl;
  process.env.KV_REST_API_TOKEN = 'test-source-token';

  const legacy = new Map([
    ['legacy@example.com', JSON.stringify(makeSubscriber('legacy@example.com'))],
    ['shared@example.com', JSON.stringify(makeSubscriber('shared@example.com', { confirmedAt: 123 }))],
  ]);
  const destination = new Map([
    ['shared@example.com', JSON.stringify(makeSubscriber('shared@example.com', { confirmedAt: 456, note: 'destination version' }))],
  ]);
  const metadata = new Map();
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    const command = JSON.parse(options.body);
    if (url === sourceUrl) {
      assert.deepEqual(command, ['HGETALL', subscriberKey]);
      return new Response(JSON.stringify({ result: [...legacy.entries()].flat() }), { status: 200 });
    }
    if (url === `${destinationUrl}/pipeline`) {
      const results = command.map(([operation, key, field, value]) => {
        assert.equal(operation, 'HSETNX');
        assert.equal(key, subscriberKey);
        if (destination.has(field)) return { result: 0 };
        destination.set(field, value);
        return { result: 1 };
      });
      return new Response(JSON.stringify(results), { status: 200 });
    }
    assert.equal(url, destinationUrl);
    const [operation, key, value, nx] = command;
    if (operation === 'GET') return new Response(JSON.stringify({ result: metadata.get(key) ?? null }), { status: 200 });
    if (operation === 'SET' && nx === 'NX') {
      if (metadata.has(key)) return new Response(JSON.stringify({ result: null }), { status: 200 });
      metadata.set(key, value);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (operation === 'SET') {
      metadata.set(key, value);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (operation === 'DEL') return new Response(JSON.stringify({ result: metadata.delete(key) ? 1 : 0 }), { status: 200 });
    throw new Error(`Unexpected target command ${operation}`);
  };

  const first = await migrateLegacySubscribers();
  assert.equal(first.imported, 1);
  assert.equal(first.alreadyPresent, 1);
  assert.equal(destination.size, 2);
  assert.equal(JSON.parse(destination.get('shared@example.com')).note, 'destination version');
  assert.equal(legacy.size, 2, 'the source subscriber hash remains unchanged');

  const second = await migrateLegacySubscribers();
  assert.equal(second.alreadyComplete, true);
  assert.equal(second.imported, 1);
  assert.equal(destination.size, 2, 'retry does not create duplicates');
});
