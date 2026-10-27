const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only-token';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.ADMIN_USERNAME = 'test-admin';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-value-at-least-32-characters';

const app = require('../src/server');
const values = new Map([['boardexamtracker:known-results', JSON.stringify(['https://www.prc.gov.ph/article/previous-exam-results'])]]);
const indexes = new Map();
const originalFetch = global.fetch;
let server;
let baseUrl;
const { extractResults } = require('../src/scraper');

const chemistsListingFixture = `<div class="views-row"><span>19 October, 2026</span><a href="/article/october-2026-chemists-computer-based-licensure-examination-and-chemical-technicians">October 2026 Chemists Computer-Based Licensure Examination and Chemical Technicians Licensure Examination Results Released in Three (3) Working Days</a><p>The Professional Regulation Commission announces the examination results.</p></div>`;

function fakeRedisResponse(command) {
  const [operation, key, value] = command;
  if (operation === 'GET') return values.get(key) ?? null;
  if (operation === 'SET') {
    if (command.includes('NX') && values.has(key)) return null;
    values.set(key, value);
    return 'OK';
  }
  if (operation === 'DEL') return values.delete(key) ? 1 : 0;
  if (operation === 'ZADD') {
    if (!indexes.has(key)) indexes.set(key, new Map());
    indexes.get(key).set(command[3], Number(value));
    return 1;
  }
  if (operation === 'ZREVRANGE') return [...(indexes.get(key) || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(Number(value), Number(command[3]) + 1).map(([member]) => member);
  if (operation === 'MGET') return command.slice(1).map((recordKey) => values.get(recordKey) ?? null);
  if (operation === 'HGETALL') return [];
  throw new Error(`Unsupported mocked Redis command: ${operation}`);
}

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test.before(async () => {
  global.fetch = async (url, options = {}) => {
    if (String(url) !== process.env.UPSTASH_REDIS_REST_URL) return originalFetch(url, options);
    const command = JSON.parse(options.body);
    return new Response(JSON.stringify({ result: fakeRedisResponse(command) }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  global.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
});

test('unauthorized users cannot inspect or trigger checker controls', async () => {
  const status = await request('/api/admin/results-check');
  const trigger = await request('/api/admin/results-check', { method: 'POST' });
  assert.equal(status.status, 401);
  assert.equal(trigger.status, 401);
});

test('latest results and professions pages are served at clean URLs', async () => {
  const results = await request('/latest-results');
  const professions = await request('/professions');
  assert.equal(results.status, 200);
  assert.match(results.data, /<link rel="canonical" href="https:\/\/www\.boardexamtracker\.com\/latest-results">/);
  assert.match(results.data, /id="results-grid"/);
  assert.equal(professions.status, 200);
  assert.match(professions.data, /<link rel="canonical" href="https:\/\/www\.boardexamtracker\.com\/professions">/);
  assert.equal((professions.data.match(/class="prof-tile"/g) || []).length, 46);
});

test('public result responses use a short edge cache', async () => {
  const cached = await request('/api/results');
  assert.match(cached.headers['cache-control'], /s-maxage=30/);
});

test('new verified results persist and appear through the existing public results API once', async () => {
  const [result] = extractResults(chemistsListingFixture);
  assert.ok(result, 'the existing PRC parser recognizes the official Chemists announcement');
  assert.equal(result.date, '2026-10-19');
  assert.equal(result.url, 'https://www.prc.gov.ph/article/october-2026-chemists-computer-based-licensure-examination-and-chemical-technicians');
  const post = () => request('/api/cron/check-results', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    body: { results: [result], pages: 2 },
  });

  const first = await post();
  assert.equal(first.status, 200);
  assert.equal(first.data.newResults, 1);
  const stored = [...values.entries()].find(([key]) => key.startsWith('boardexamtracker:announcement:v1:'));
  assert.ok(stored, 'announcement record is present in Redis');
  assert.equal(JSON.parse(stored[1]).publicationStatus, 'published');

  const visible = await request('/api/results');
  assert.equal(visible.status, 200);
  assert.ok(visible.data.results.some((item) => item.url === result.url));

  const second = await post();
  assert.equal(second.status, 200);
  assert.equal(second.data.newResults, 0);
  assert.equal([...values.keys()].filter((key) => key.startsWith('boardexamtracker:announcement:v1:')).length, 1);
});

test('an invalid or failed check leaves the already published result visible', async () => {
  const knownBefore = values.get('boardexamtracker:known-results');
  const failed = await request('/api/cron/check-results', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    body: { results: [], pages: 0 },
  });
  assert.equal(failed.status, 502);
  assert.equal(values.get('boardexamtracker:known-results'), knownBefore, 'a failed result fetch does not change the notification baseline');
  const visible = await request('/api/results');
  assert.ok(visible.data.results.some((item) => item.url.endsWith('/october-2026-chemists-computer-based-licensure-examination-and-chemical-technicians')));
});

test('a bundled fallback snapshot is displayed without creating new-result alerts', async () => {
  const [parsed] = extractResults(chemistsListingFixture);
  const result = { ...parsed, url: 'https://www.prc.gov.ph/article/october-2026-chemists-fallback-snapshot-result' };
  const fallback = await request('/api/cron/check-results', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    body: { results: [result], fallback: true, pages: 0 },
  });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.data.fallback, true);
  assert.equal(fallback.data.newResults, 0);
  const record = [...values.entries()]
    .filter(([key]) => key.startsWith('boardexamtracker:announcement:v1:'))
    .map(([, value]) => JSON.parse(value))
    .find((item) => item.canonicalUrl === result.url);
  assert.equal(record.notificationStatus, 'not-required');
  assert.ok(JSON.parse(values.get('boardexamtracker:known-results')).includes(result.url));
  const status = JSON.parse(values.get('boardexamtracker:results-check-status:v1'));
  assert.equal(status.state, 'error');
  assert.match(status.lastError, /fallback snapshot/);
});
