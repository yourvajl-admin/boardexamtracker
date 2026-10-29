const test = require('node:test');
const assert = require('node:assert/strict');
const { extractResults } = require('../src/scraper');
const { runScheduledCheck } = require('../src/check-results');
const fallbackAnnouncementLinks = require('../src/fallback-announcement-links.json');

const chemistsFixture = `<div class="views-row"><span>19 October, 2026</span><a href="/article/october-2026-chemists-computer-based-licensure-examination-and-chemical-technicians">October 2026 Chemists Computer-Based Licensure Examination and Chemical Technicians Licensure Examination Results Released in Three (3) Working Days</a><p>The Professional Regulation Commission announces the examination results.</p></div>`;
const chemistsResult = extractResults(chemistsFixture)[0];

test('the bundled announcement fallback includes the recent Metallurgical Engineers result files', () => {
  const url = 'https://www.prc.gov.ph/article/october-2026-metallurgical-engineers-computer-based-licensure-examination-results-released';
  const entry = fallbackAnnouncementLinks[url];
  assert.ok(entry, 'expected the bundled fallback to include the Metallurgical Engineers announcement');
  assert.equal(entry.resources.length >= 4, true);
  assert.match(entry.resources[0].label, /Official Result/);
  assert.match(entry.details.summary, /36 of 42/);
});

test('the bundled archive fallback includes the older Radiologic Technologists result files and details', () => {
  const url = 'https://www.prc.gov.ph/article/may-2026-radiologic-technologists-special-professional-licensure-examination-results';
  const entry = fallbackAnnouncementLinks[url];
  assert.ok(entry, 'expected the archive fallback to include the older Radiologic Technologists announcement');
  assert.equal(entry.resources.length, 2);
  assert.match(entry.resources[0].url, /drive\.google\.com\/file\/d\//);
  assert.match(entry.details.summary, /none passed out of 2 examinees/);
  assert.equal(entry.details.source, 'prc');
  assert.equal(entry.details.version, 2);
});

test('the scheduled runner triggers a live deploy hook after publishing a new result', async () => {
  const previousHook = process.env.VERCEL_DEPLOY_HOOK_URL;
  process.env.VERCEL_DEPLOY_HOOK_URL = 'https://example.vercel.app/api/deploy';
  const requests = [];
  try {
    const result = await runScheduledCheck({
      secret: 'test-only-secret',
      verifiedResultUrls: '[]',
      fetchResultsImpl: async ({ maxPage }) => {
        assert.equal(maxPage, 2);
        return [chemistsResult];
      },
      fetchAnnouncementLinksImpl: async (url) => ({
        resources: [{ label: 'Full text of the Official Result', url: 'https://drive.google.com/file/d/mock-result/view' }],
        details: { paragraphs: ['Result document summary from the official announcement.'] },
        url,
      }),
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith('/check-results')) {
          assert.deepEqual(JSON.parse(options.body).results, [chemistsResult]);
          return new Response(JSON.stringify({ newResults: 1, recipients: 1, announcementUrls: [chemistsResult.url] }), { status: 200 });
        }
        if (url === 'https://example.vercel.app/api/deploy') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        assert.match(url, /\/cache-announcement-links$/);
        assert.equal(JSON.parse(options.body).announcements[0].url, chemistsResult.url);
        return new Response(JSON.stringify({ saved: 1 }), { status: 200 });
      },
      write: () => {},
    });

    assert.equal(result.newResults, 1);
    assert.equal(requests.some((request) => request.url === 'https://example.vercel.app/api/deploy'), true);
  } finally {
    if (previousHook === undefined) delete process.env.VERCEL_DEPLOY_HOOK_URL;
    else process.env.VERCEL_DEPLOY_HOOK_URL = previousHook;
  }
});

test('the scheduled runner forwards a parsed Chemists announcement and then caches its official files', async () => {
  const requests = [];
  const output = [];
  const result = await runScheduledCheck({
    secret: 'test-only-secret',
    verifiedResultUrls: '[]',
    fetchResultsImpl: async ({ maxPage }) => {
      assert.equal(maxPage, 2);
      return [chemistsResult];
    },
    fetchAnnouncementLinksImpl: async (url) => ({
      resources: [{ label: 'Full text of the Official Result', url: 'https://drive.google.com/file/d/mock-result/view' }],
      details: { paragraphs: ['Result document summary from the official announcement.'] },
      url,
    }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/check-results')) {
        assert.deepEqual(JSON.parse(options.body).results, [chemistsResult]);
        return new Response(JSON.stringify({ newResults: 1, recipients: 1, announcementUrls: [chemistsResult.url] }), { status: 200 });
      }
      assert.match(url, /\/cache-announcement-links$/);
      assert.equal(JSON.parse(options.body).announcements[0].url, chemistsResult.url);
      return new Response(JSON.stringify({ saved: 1 }), { status: 200 });
    },
    write: (value) => output.push(value),
  });

  assert.equal(result.newResults, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-only-secret');
  assert.match(output.join(''), /Found 1 new result/);
});

test('a PRC 521 publishes the verified fallback snapshot and reports the source outage', async () => {
  let publishCalls = 0;
  const warnings = [];
  const fallbackResult = { ...chemistsResult, url: 'https://www.prc.gov.ph/article/october-2026-verified-fallback-result' };
  await runScheduledCheck({
    secret: 'test-only-secret',
    verifiedResultUrls: '[]',
    fetchResultsImpl: async () => { throw new Error('PRC returned HTTP 521'); },
    fallbackResults: [fallbackResult],
    fetchAnnouncementLinksImpl: async () => ({ resources: [], details: {} }),
    fetchImpl: async (_url, options) => {
      publishCalls += 1;
      assert.deepEqual(JSON.parse(options.body).results, [fallbackResult]);
      assert.equal(JSON.parse(options.body).fallback, true);
      return new Response(JSON.stringify({ newResults: 0, recipients: 0, announcementUrls: [] }));
    },
    write: () => {},
    warn: (message) => warnings.push(message),
  });
  assert.equal(publishCalls, 1);
  assert.match(warnings.join('\n'), /HTTP 521/);
  assert.match(warnings.join('\n'), /fallback snapshot/);
});

test('verified result URLs accept only exact official PRC article URLs and use those snapshot records', async () => {
  const verified = 'https://www.prc.gov.ph/article/october-2026-verified-result';
  const fallbackResult = { ...chemistsResult, url: verified };
  let liveFetches = 0;
  await runScheduledCheck({
    secret: 'test-only-secret',
    verifiedResultUrls: JSON.stringify([verified]),
    fallbackResults: [fallbackResult],
    fetchResultsImpl: async () => { liveFetches += 1; return []; },
    fetchImpl: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body).results, [fallbackResult]);
      assert.equal(JSON.parse(options.body).fallback, false);
      return new Response(JSON.stringify({ newResults: 0, recipients: 0, announcementUrls: [] }));
    },
    write: () => {},
  });
  assert.equal(liveFetches, 0);
  await assert.rejects(runScheduledCheck({
    secret: 'test-only-secret',
    verifiedResultUrls: '["https://www.prc.gov.ph/articles/exam-results"]',
    fallbackResults: [fallbackResult],
    write: () => {},
  }), /exact official PRC article URLs/);
});

test('an empty parsed feed is a failure and is never published as zero new results', async () => {
  let publishCalls = 0;
  await assert.rejects(runScheduledCheck({
    secret: 'test-only-secret',
    verifiedResultUrls: '[]',
    fetchResultsImpl: async () => [],
    fetchImpl: async () => { publishCalls += 1; return new Response('{}'); },
    write: () => {},
  }), /returned no validated result announcements/);
  assert.equal(publishCalls, 0);
});
