const { fetchResults, fetchAnnouncementLinks } = require('./scraper');

async function main() {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('Missing CRON_SECRET.');

  // Fetch from the GitHub runner, then hand the official-source data to the
  // production API. This avoids depending on Vercel outbound access to PRC.
  let results;
  const verifiedResultUrls = process.env.VERIFIED_RESULT_URLS;
  if (verifiedResultUrls && verifiedResultUrls !== '[]') {
    let requestedUrls;
    try {
      requestedUrls = JSON.parse(verifiedResultUrls);
    } catch {
      throw new Error('VERIFIED_RESULT_URLS must be a JSON array of official PRC article URLs.');
    }
    if (!Array.isArray(requestedUrls) || !requestedUrls.length || requestedUrls.length > 10 || requestedUrls.some((url) => typeof url !== 'string' || !/^https:\/\/www\.prc\.gov\.ph\/article\/[a-z0-9-]+$/i.test(url))) {
      throw new Error('Provide one to ten exact official PRC article URLs.');
    }
    const snapshot = require('./fallback-results.json').results;
    const requested = new Set(requestedUrls);
    results = snapshot.filter((result) => requested.has(result.url));
    if (results.length !== requested.size) throw new Error('One or more requested URLs are not present in the verified result snapshot.');
  } else {
    try {
      results = await fetchResults({ maxPage: 2 });
    } catch (error) {
      // A PRC connection failure is not an empty feed. Fail this run so the
      // outage is visible; the next scheduled run will retry without changing
      // the baseline or sending alerts from partial data.
      throw new Error(`PRC was unreachable after retries. No results or email alerts were changed; the next scheduled run will retry. ${error.message}`);
    }
  }
  // Call Vercel's production alias directly so Cloudflare/proxy issues on the
  // custom domain do not block publishing or email delivery.
  const siteUrl = (process.env.SITE_CRON_URL || 'https://boardexamtracker.vercel.app/api/cron/check-results').replace(/\/$/, '');
  const response = await fetch(siteUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'User-Agent': 'BoardExamTracker scheduled result checker',
    },
    body: JSON.stringify({ results }),
    signal: AbortSignal.timeout(60_000),
  });
  const message = await response.text();
  if (!response.ok) throw new Error(`BoardExamTracker returned HTTP ${response.status}: ${message}`);
  const result = JSON.parse(message);
  const summary = result.initialized
    ? 'Initialized the PRC result baseline; no historical alerts were sent.'
    : result.skipped
      ? `Skipped this check: ${result.reason || 'another check is running.'}`
      : `Found ${result.newResults || 0} new result(s); sent alerts to ${result.recipients || 0} confirmed subscriber(s).`;
  process.stdout.write(`::notice::${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = require('node:fs');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### PRC result check\n\n${summary}\n`);
  }

  const announcements = [];
  for (const url of result.announcementUrls || []) {
    try {
      announcements.push({ url, ...(await fetchAnnouncementLinks(url)) });
    } catch (error) {
      console.warn(`Could not index linked documents for ${url}: ${error.message}`);
    }
  }
  if (announcements.length) {
    const cacheUrl = siteUrl.replace(/\/check-results$/, '/cache-announcement-links');
    const cacheResponse = await fetch(cacheUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'User-Agent': 'BoardExamTracker scheduled result checker',
      },
      body: JSON.stringify({ announcements }),
      signal: AbortSignal.timeout(60_000),
    });
    const cacheMessage = await cacheResponse.text();
    if (!cacheResponse.ok) throw new Error(`BoardExamTracker link cache returned HTTP ${cacheResponse.status}: ${cacheMessage}`);
    process.stdout.write(`${message}\n${cacheMessage}\n`);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
