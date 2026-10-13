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
  const siteUrl = 'https://www.boardexamtracker.com/api/cron/check-results';
  const prepareResponse = await fetch(siteUrl.replace(/\/check-results$/, '/prepare-announcement-links'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'User-Agent': 'BoardExamTracker scheduled result checker',
    },
    body: JSON.stringify({ results }),
    signal: AbortSignal.timeout(60_000),
  });
  const prepareText = await prepareResponse.text();
  if (!prepareResponse.ok) throw new Error(`BoardExamTracker attachment preparation returned HTTP ${prepareResponse.status}: ${prepareText}`);
  const prepared = JSON.parse(prepareText);
  const preparedAnnouncements = [];
  for (const url of prepared.announcementUrls || []) {
    const announcement = await fetchAnnouncementLinks(url);
    if (!announcement.details?.paragraphs?.length || !announcement.resources?.length) throw new Error(`PRC announcement details or result files are not available for ${url}; the result was not published.`);
    preparedAnnouncements.push({ url, ...announcement });
  }
  if (preparedAnnouncements.length) {
    const cacheResponse = await fetch(siteUrl.replace(/\/check-results$/, '/cache-announcement-links'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'User-Agent': 'BoardExamTracker scheduled result checker',
      },
      body: JSON.stringify({ announcements: preparedAnnouncements }),
      signal: AbortSignal.timeout(60_000),
    });
    const cacheText = await cacheResponse.text();
    if (!cacheResponse.ok) throw new Error(`BoardExamTracker attachment cache returned HTTP ${cacheResponse.status}: ${cacheText}`);
    const cacheResult = JSON.parse(cacheText);
    if (cacheResult.saved !== preparedAnnouncements.length) throw new Error(`Only ${cacheResult.saved || 0} of ${preparedAnnouncements.length} new result attachment sets were saved; the result was not published.`);
  }

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
    if (preparedAnnouncements.some((entry) => entry.url === url)) continue;
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
