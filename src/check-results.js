const { fetchResults, fetchAnnouncementLinks } = require('./scraper');
const { results: bundledFallbackResults } = require('./fallback-results.json');

const VERIFIED_RESULT_URL_PATTERN = /^https:\/\/www\.prc\.gov\.ph\/article\/[a-z0-9-]+$/i;

function verifiedResultsFromSnapshot(verifiedResultUrls, fallbackResults) {
  let requestedUrls;
  try {
    requestedUrls = JSON.parse(verifiedResultUrls);
  } catch {
    throw new Error('VERIFIED_RESULT_URLS must be a JSON array of official PRC article URLs.');
  }
  if (!Array.isArray(requestedUrls) || !requestedUrls.length || requestedUrls.length > 10 || requestedUrls.some((url) => typeof url !== 'string' || !VERIFIED_RESULT_URL_PATTERN.test(url))) {
    throw new Error('Provide one to ten exact official PRC article URLs.');
  }
  const requested = new Set(requestedUrls);
  const results = fallbackResults.filter((result) => requested.has(result.url));
  if (results.length !== requested.size) throw new Error('One or more requested URLs are not present in the verified result snapshot.');
  return results;
}

async function triggerLiveDeploy({ newResults, fetchImpl, deployHookUrl, warn }) {
  if (!Number.isFinite(newResults) || newResults <= 0) return null;
  const hookUrl = typeof deployHookUrl === 'string' ? deployHookUrl.trim() : (process.env.VERCEL_DEPLOY_HOOK_URL || '').trim();
  if (!hookUrl) return null;
  try {
    const response = await fetchImpl(hookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'BoardExamTracker live deploy trigger',
      },
      body: JSON.stringify({ event: 'new-prc-result', newResults, triggeredAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`Vercel deploy hook returned HTTP ${response.status}: ${payload.slice(0, 200)}`);
    }
    return response;
  } catch (error) {
    warn(`Could not trigger Vercel deploy hook: ${error.message}`);
    return null;
  }
}

async function runScheduledCheck({
  secret = process.env.CRON_SECRET,
  verifiedResultUrls = process.env.VERIFIED_RESULT_URLS,
  fetchResultsImpl = fetchResults,
  fetchAnnouncementLinksImpl = fetchAnnouncementLinks,
  fallbackResults = bundledFallbackResults,
  fetchImpl = fetch,
  siteUrl = (process.env.SITE_CRON_URL || 'https://boardexamtracker.vercel.app/api/cron/check-results').replace(/\/$/, ''),
  write = (value) => process.stdout.write(value),
  warn = (value) => console.warn(value),
} = {}) {
  if (!secret) throw new Error('Missing CRON_SECRET.');

  let results;
  let usedFallback = false;
  if (verifiedResultUrls && verifiedResultUrls !== '[]') {
    results = verifiedResultsFromSnapshot(verifiedResultUrls, fallbackResults);
  } else {
    try {
      results = await fetchResultsImpl({ maxPage: 2 });
    } catch (error) {
      if (!Array.isArray(fallbackResults) || !fallbackResults.length) throw new Error(`PRC was unreachable after retries and no verified fallback snapshot is available. ${error.message}`);
      warn(`PRC live fetch failed (${error.message}). Publishing the bundled verified fallback snapshot; no new PRC announcements can be detected until the official source is reachable.`);
      results = fallbackResults;
      usedFallback = true;
    }
  }
  if (!Array.isArray(results) || !results.length) {
    throw new Error('The official PRC source returned no validated result announcements. No results or email alerts were changed.');
  }

  // Publish only after source retrieval and parsing succeeded. This runner
  // calls the existing authenticated API; Redis remains the source of stored state.
  const response = await fetchImpl(siteUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'User-Agent': 'BoardExamTracker scheduled result checker',
    },
    body: JSON.stringify({ results, fallback: usedFallback }),
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
  write(`::notice::${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = require('node:fs');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### PRC result check\n\n${summary}\n`);
  }

  if (!result.initialized && !result.skipped && result.newResults > 0) {
    await triggerLiveDeploy({
      newResults: Number(result.newResults) || 0,
      fetchImpl,
      deployHookUrl: process.env.VERCEL_DEPLOY_HOOK_URL,
      warn,
    });
  }

  const announcements = [];
  if (usedFallback) {
    warn('Skipped linked-file refresh because the bundled fallback snapshot was used.');
  } else {
    for (const url of result.announcementUrls || []) {
      try {
        announcements.push({ url, ...(await fetchAnnouncementLinksImpl(url)) });
      } catch (error) {
        warn(`Could not index linked documents for ${url}: ${error.message}`);
      }
    }
  }
  if (announcements.length) {
    const cacheUrl = siteUrl.replace(/\/check-results$/, '/cache-announcement-links');
    const cacheResponse = await fetchImpl(cacheUrl, {
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
    write(`${message}\n${cacheMessage}\n`);
  } else {
    write(`${message}\n`);
  }
  return result;
}

if (require.main === module) {
  runScheduledCheck().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { runScheduledCheck, verifiedResultsFromSnapshot };
