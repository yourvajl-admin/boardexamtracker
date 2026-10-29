const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchPrcPage, PRC_URL, retryAfterMs } = require('../cloudflare/prc-fetch');
const { extractResults } = require('../src/scraper');

const resultHtml = `<!doctype html><html><body><div class="views-row"><span>25 October, 2026</span><a href="/article/october-2026-civil-engineers-results">October 2026 Civil Engineers Licensure Examination Results Released</a><p>PRC announced the examination results.</p></div><nav aria-label="pagination"><a href="?page=2">Last</a></nav></body></html>`;

function makeResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8', ...headers } });
}

test('fetches and parses a successful PRC listing with safe diagnostics', async () => {
  const logs = [];
  let requestedUrl;
  const fetched = await fetchPrcPage(0, {
    fetchImpl: async (url) => { requestedUrl = url; return makeResponse(resultHtml, 200, { server: 'PRC web server', 'cf-ray': 'diagnostic-id' }); },
    logger: (line) => logs.push(JSON.parse(line)),
  });
  const results = extractResults(fetched.html);
  assert.equal(requestedUrl, PRC_URL);
  assert.equal(fetched.url, PRC_URL);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://www.prc.gov.ph/article/october-2026-civil-engineers-results');
  assert.equal(results[0].date, '2026-10-25');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 200);
  assert.equal(logs[0].requestUrl, PRC_URL);
  assert.ok(Number.isFinite(logs[0].elapsedMs));
  assert.ok(logs[0].timestamp);
  assert.equal(logs[0].responseHeaders.server, 'PRC web server');
  assert.equal(logs[0].responseHeaders['cf-ray'], 'diagnostic-id');
  assert.equal(JSON.stringify(logs).includes('subscriber'), false);
});

test('retries HTTP 521 with exponential backoff and records every response safely', async () => {
  const delays = [];
  const logs = [];
  let calls = 0;
  await assert.rejects(fetchPrcPage(0, {
    fetchImpl: async () => { calls += 1; return makeResponse('origin unavailable', 521, { server: 'cloudflare', 'retry-after': '0' }); },
    sleepImpl: async (ms) => delays.push(ms),
    random: () => 0.5,
    logger: (line) => logs.push(JSON.parse(line)),
  }), /HTTP 521/);
  assert.equal(calls, 6);
  assert.deepEqual(delays, [1000, 2000]);
  assert.deepEqual(logs.filter((entry) => entry.event === 'prc_http_attempt' && entry.status === 521).map((entry) => entry.requestUrl), [
    PRC_URL, PRC_URL.replace('www.', ''),
    PRC_URL, PRC_URL.replace('www.', ''),
    PRC_URL, PRC_URL.replace('www.', ''),
  ]);
  assert.ok(logs.some((entry) => entry.retryInMs === 1000));
});

test('falls back to the official bare PRC hostname after a retryable www failure', async () => {
  const requested = [];
  const fetched = await fetchPrcPage(0, {
    fetchImpl: async (url) => {
      requested.push(url);
      return url.startsWith('https://www.') ? makeResponse('origin unavailable', 521) : makeResponse(resultHtml);
    },
    logger: () => {},
  });
  assert.deepEqual(requested, [PRC_URL, PRC_URL.replace('www.', '')]);
  assert.equal(fetched.url, PRC_URL.replace('www.', ''));
  assert.equal(fetched.html, resultHtml);
});

test('rejects challenge pages and unexpected content types without publishing an empty result set', async () => {
  await assert.rejects(fetchPrcPage(0, {
    fetchImpl: async () => makeResponse('<html><title>Just a moment...</title><body>Checking your browser</body></html>'),
    logger: () => {},
  }), /access challenge/);
  await assert.rejects(fetchPrcPage(0, {
    fetchImpl: async () => new Response('{"error":"rate limited"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    logger: () => {},
  }), /unexpected content type/);
});

test('does not retry an explicit PRC access denial but retries rate limits with Retry-After', async () => {
  let deniedCalls = 0;
  await assert.rejects(fetchPrcPage(0, {
    fetchImpl: async () => { deniedCalls += 1; return makeResponse('Forbidden', 403); },
    logger: () => {},
  }), /HTTP 403/);
  assert.equal(deniedCalls, 1);

  const delays = [];
  let calls = 0;
  const fetched = await fetchPrcPage(0, {
    fetchImpl: async () => {
      calls += 1;
      return calls <= 2 ? makeResponse('Slow down', 429, { 'retry-after': '1' }) : makeResponse(resultHtml);
    },
    sleepImpl: async (ms) => delays.push(ms),
    random: () => 0,
    logger: () => {},
  });
  assert.equal(fetched.html, resultHtml);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000]);
});

test('honors Retry-After and defers a retry when the requested wait is too long', async () => {
  assert.equal(retryAfterMs('3', 0), 3000);
  const delays = [];
  let calls = 0;
  await assert.rejects(fetchPrcPage(0, {
    fetchImpl: async () => { calls += 1; return makeResponse('', 503, { 'retry-after': '120' }); },
    sleepImpl: async (ms) => delays.push(ms),
    logger: () => {},
  }), /HTTP 503/);
  assert.equal(calls, 2, 'tries both PRC hostnames, then defers the retry to respect PRC’s requested delay');
  assert.deepEqual(delays, []);
});

test('retries a network timeout only a bounded number of times', async () => {
  const delays = [];
  const logs = [];
  let calls = 0;
  await assert.rejects(fetchPrcPage(0, {
    fetchImpl: async () => { calls += 1; const error = new Error('request timed out'); error.name = 'TimeoutError'; throw error; },
    sleepImpl: async (ms) => delays.push(ms),
    random: () => 0.5,
    logger: (line) => logs.push(JSON.parse(line)),
  }), /request timed out/);
  assert.equal(calls, 6);
  assert.deepEqual(delays, [1000, 2000]);
  assert.ok(logs.every((entry) => entry.status === null && [PRC_URL, PRC_URL.replace('www.', '')].includes(entry.requestUrl)));
});

test('a malformed 200 response is not mistaken for an empty successful result feed', async () => {
  const fetched = await fetchPrcPage(0, {
    fetchImpl: async () => makeResponse('<html><title>Unexpected page</title><body>Maintenance</body></html>'),
    logger: () => {},
  });
  assert.deepEqual(extractResults(fetched.html), []);
  // publishCheck rejects this empty parsed result set and records a failure.
});

test('duplicate announcement URLs in a listing collapse to one result', () => {
  const duplicate = `<div class="views-row"><span>25 October, 2026</span><a href="/article/october-2026-civil-engineers-results">October 2026 Civil Engineers Licensure Examination Results</a></div><div class="views-row"><span>25 October, 2026</span><a href="https://prc.gov.ph/article/october-2026-civil-engineers-results/?utm_source=feed">October 2026 Civil Engineers Licensure Examination Results (duplicate alias)</a></div>`;
  const results = extractResults(duplicate);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://www.prc.gov.ph/article/october-2026-civil-engineers-results');
});
