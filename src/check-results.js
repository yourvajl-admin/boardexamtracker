const { fetchResults, fetchAnnouncementLinks } = require('./scraper');

async function main() {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('Missing CRON_SECRET.');

  // Fetch from the GitHub runner, then hand the official-source data to the
  // production API. This avoids depending on Vercel outbound access to PRC.
  let results;
  try {
    results = await fetchResults({ maxPage: 2 });
  } catch (error) {
    // A PRC connection failure is not an empty feed. Fail this run so the
    // outage is visible; the next scheduled run will retry without changing
    // the baseline or sending alerts from partial data.
    throw new Error(`PRC was unreachable after retries. No results or email alerts were changed; the next scheduled run will retry. ${error.message}`);
  }
  const response = await fetch('https://www.boardexamtracker.com/api/cron/check-results', {
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
    const cacheResponse = await fetch('https://www.boardexamtracker.com/api/cron/cache-announcement-links', {
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
