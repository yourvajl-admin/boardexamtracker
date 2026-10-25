const test = require('node:test');
const assert = require('node:assert/strict');
const { extractResults, fetchPrcHtml, fetchResults, getLastPage, normalizeUrl, parseDate } = require('../src/scraper');

const listing = (date, title, href, snippet = '') => `<div class="views-row"><span>${date}</span><a href="${href}">${title}</a><p>${snippet}</p></div>`;

test('parses dated PRC result announcements, relative links, and canonical host aliases', () => {
  const html = `${listing('25 October, 2026', 'October 2026 Civil Engineers Licensure Examination Results Released', '/index.php/article/october-2026-civil-engineers-results', 'The PRC result notice.')}<div class="pager"><a href="?page=3">Last</a></div>`;
  const results = extractResults(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].date, '2026-10-25');
  assert.equal(results[0].url, 'https://www.prc.gov.ph/article/october-2026-civil-engineers-results');
  assert.equal(results[0].category, 'Civil Engineering');
  assert.equal(normalizeUrl('https://prc.gov.ph/article/test/?utm_source=feed#top'), 'https://www.prc.gov.ph/article/test');
});

test('rejects malformed dates and URLs outside official PRC hosts', () => {
  assert.equal(parseDate('31 February, 2026'), null);
  assert.equal(parseDate('2026-13-45'), null);
  assert.equal(normalizeUrl('https://example.com/article/result'), null);
  assert.deepEqual(extractResults('<html><a href="https://example.com/article/a">Board Exam Results</a><p>25 October, 2026</p></html>'), []);
});

test('reads pagination links from official PRC pager markup', () => {
  assert.equal(getLastPage('<nav aria-label="pagination"><a href="?page=0">1</a><a href="?page=17">Last</a></nav>'), 17);
  assert.equal(getLastPage('<html><p>No pagination</p></html>'), 0);
});

test('handles malformed HTML without throwing', () => {
  assert.deepEqual(extractResults('<div><a href="/article/unclosed">October result <span>'), []);
  assert.equal(getLastPage('<a href="javascript:bad">next</a>'), 0);
});

test('fetches multiple listing pages and deduplicates the same canonical announcement', async () => {
  const originalFetch = global.fetch;
  const requested = [];
  global.fetch = async (url) => {
    const parsed = new URL(url);
    requested.push(parsed.searchParams.get('page') || '0');
    const page = parsed.searchParams.get('page') || '0';
    const html = page === '0'
      ? `${listing('25 October, 2026', 'October 2026 Nurses Licensure Examination Results Released', '/article/nursing-results')}<div class="pager"><a href="?page=1">2</a></div>`
      : `${listing('24 October, 2026', 'October 2026 Civil Engineers Licensure Examination Results Released', 'https://prc.gov.ph/article/civil-results')}<div class="pager"><a href="?page=1">2</a></div>`;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const results = await fetchResults({ maxPage: 1 });
    assert.deepEqual(requested, ['0', '1']);
    assert.equal(results.length, 2);
    assert.equal(results[0].category, 'Nursing');
  } finally { global.fetch = originalFetch; }
});

test('retries temporary failures and refuses redirects outside the PRC domain', async () => {
  let calls = 0;
  await assert.rejects(fetchPrcHtml('https://www.prc.gov.ph/articles/exam-results', {
    fetchImpl: async () => { calls += 1; return new Response('', { status: 521 }); },
    curlFallback: false,
    retryDelays: [],
  }), /HTTP 521/);
  assert.equal(calls, 2, 'tries the www and bare PRC hostnames');

  await assert.rejects(fetchPrcHtml('https://www.prc.gov.ph/articles/exam-results', {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/redirect' } }),
    curlFallback: false,
    retryDelays: [],
  }), /outside the approved PRC hosts/);
});
