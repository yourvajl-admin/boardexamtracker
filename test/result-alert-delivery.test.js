const test = require('node:test');
const assert = require('node:assert/strict');
const { sendUndeliveredResultAlert } = require('../src/result-alert-delivery');

function fakeRedis() {
  const values = new Map();
  return async (...args) => {
    if (args[0] === 'GET') return values.get(args[1]) ?? null;
    if (args[0] === 'SET') {
      if (args.includes('NX') && values.has(args[1])) return null;
      values.set(args[1], args[2]);
      return 'OK';
    }
    if (args[0] === 'DEL') return values.delete(args[1]) ? 1 : 0;
    throw new Error(`Unexpected Redis operation ${args[0]}`);
  };
}

const subscriber = { email: 'person@example.com' };
const results = [{
  url: 'https://www.prc.gov.ph/article/october-2026-chemists-computer-based-licensure-examination-and-chemical-technicians',
  title: 'October 2026 Chemists Computer-Based Licensure Examination and Chemical Technicians Licensure Examination Results Released in Three (3) Working Days',
  date: '2026-10-19',
}];

test('sends an announcement once per subscriber/result and uses a stable provider idempotency key', async () => {
  const redisCommand = fakeRedis();
  const sends = [];
  const send = async (...args) => sends.push(args);
  await sendUndeliveredResultAlert(subscriber, results, { redisCommand, send });
  const duplicate = await sendUndeliveredResultAlert(subscriber, results, { redisCommand, send });
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1][0].url, results[0].url);
  assert.match(sends[0][1][0].title, /Chemists Computer-Based Licensure Examination/);
  assert.equal(duplicate.alreadySent, true);
  assert.match(sends[0][2].idempotencyKey, /^bet-[a-f0-9]{64}$/);
});

test('releases a failed delivery lock so a later scheduled check can retry', async () => {
  const redisCommand = fakeRedis();
  let attempts = 0;
  const send = async () => { attempts += 1; if (attempts === 1) throw new Error('temporary provider error'); };
  await assert.rejects(sendUndeliveredResultAlert(subscriber, results, { redisCommand, send, logger: { error() {}, warn() {} } }));
  const retried = await sendUndeliveredResultAlert(subscriber, results, { redisCommand, send });
  assert.equal(retried.sent, true);
  assert.equal(attempts, 2);
});
