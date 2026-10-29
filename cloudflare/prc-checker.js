const cheerio = require('cheerio');
const { extractAnnouncementDetails } = require('../src/announcement-details');
const { categorize } = require('../src/professions');
const { extractResources } = require('./prc-resources');
const { fetchPrcPage } = require('./prc-fetch');

const PRC_URL = 'https://www.prc.gov.ph/articles/exam-results';
const PRC_HOSTS = ['www.prc.gov.ph', 'prc.gov.ph'];
const RESULT_TERMS = /\b(result|results|licensure examination|board examination|examination result)\b/i;
function parseDate(value) {
  const text = String(value || '').replace(/\s+/g, ' ');
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`;
    const parsed = new Date(`${candidate}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : null;
  }
  const match = text.match(/\b(\d{1,2})\s*([A-Za-z]+),?\s*(\d{4})(?!\d)/);
  if (!match) return null;
  const month = new Date(`${match[2]} 1, 2000 UTC`).getUTCMonth();
  if (Number.isNaN(month)) return null;
  const day = Number(match[1]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function isPrcUrl(href, base) {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'https:' || !['prc.gov.ph', 'www.prc.gov.ph'].includes(url.hostname)) return null;
    url.hostname = 'www.prc.gov.ph';
    if (url.pathname.startsWith('/index.php/article/')) url.pathname = url.pathname.slice('/index.php'.length);
    if (url.pathname.startsWith('/article/')) url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function extractResults(html, pageUrl) {
  const $ = cheerio.load(html);
  const results = [];
  $('a[href]').each((_, element) => {
    const anchor = $(element);
    const title = anchor.text().replace(/\s+/g, ' ').trim();
    const url = isPrcUrl(anchor.attr('href'), pageUrl);
    if (!url || !title || !RESULT_TERMS.test(title) || /\/articles\/exam-results\/?$/.test(url.pathname)) return;
    url.hash = '';

    let container = anchor;
    for (let depth = 0; depth < 5 && container.parent().length; depth += 1) {
      container = container.parent();
      if (/\b\d{1,2}\s*[A-Za-z]+,?\s*\d{4}(?!\d)/.test(container.text())) break;
    }
    const text = container.text().replace(/\s+/g, ' ').trim();
    const date = parseDate(text);
    if (!date) return;
    const description = container.find('p').first().text().replace(/\s+/g, ' ').trim();
    results.push({
      title,
      category: categorize(title),
      date,
      description: summarize(title, description),
      url: url.href,
    });
  });
  return [...new Map(results.map((result) => [result.url, result])).values()];
}

function summarize(title, description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  const passed = text.match(/([\d,]+)\s+out of\s+([\d,]+)\s+passed the\s+(.+?)(?:\s+given by|\s+in\s+\d+\s+testing centers|\.|$)/i);
  if (passed) return `${passed[1]} of ${passed[2]} candidates passed the ${passed[3].trim()} exam.`;
  return text.slice(0, 500) || `PRC published the results for ${title}.`;
}

function getLastPage(html) {
  const $ = cheerio.load(html);
  let lastPage = 0;
  $('[class*="pager"] a[href], nav[aria-label*="pagination"] a[href]').each((_, element) => {
    try {
      const url = new URL($(element).attr('href'), PRC_URL);
      if (!PRC_HOSTS.includes(url.hostname) || !url.pathname.startsWith('/articles/exam-results')) return;
      const page = Number(url.searchParams.get('page'));
      if (Number.isInteger(page) && page >= 0 && page <= 10000) lastPage = Math.max(lastPage, page);
    } catch { /* Ignore malformed pager links. */ }
  });
  return lastPage;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function siteEndpoint(env, endpoint) {
  const configured = (env.SITE_CRON_URL || 'https://boardexamtracker.vercel.app/api/cron/check-results').replace(/\/$/, '');
  const base = configured.replace(/\/api\/cron\/check-results$/, '');
  return `${base}/api/cron/${endpoint}`;
}

async function siteRequest(env, endpoint, { method = 'POST', body, lockToken, timeoutMs = 30000 } = {}) {
  const response = await fetch(siteEndpoint(env, endpoint), {
    method,
    headers: {
      Authorization: `Bearer ${env.CRON_SECRET}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(lockToken ? { 'X-Checker-Lock': lockToken } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  if (!response.ok) throw new Error(`BoardExamTracker ${endpoint} returned HTTP ${response.status}: ${data.error || text.slice(0, 300)}`);
  return data;
}

async function backfillAnnouncementLinks(env, lockToken) {
  try {
    const batch = await siteRequest(env, 'announcement-link-backfill', { body: { lockToken }, lockToken });
    const announcements = (await Promise.all((batch.urls || []).map(async (url) => {
      try {
        const html = await fetchPrcArticle(url);
        return { url, resources: extractResources(html, url), details: extractAnnouncementDetails(html) };
      } catch (error) {
        console.warn(`Could not backfill PRC files for ${url}: ${error.message}`);
        return null;
      }
    }))).filter(Boolean);
    if (announcements.length) {
      await siteRequest(env, 'cache-announcement-links', { body: { announcements }, lockToken, timeoutMs: 60000 });
    }
    console.log(JSON.stringify({ event: 'announcement_links_backfilled', scanned: batch.scanned || 0, saved: announcements.length }));
  } catch (error) {
    console.error(`Could not backfill older PRC announcement files: ${error.message}`);
  }
}

async function publishCheck(env) {
  if (!env.CRON_SECRET) throw new Error('Missing Worker secret CRON_SECRET.');
  let lockToken;
  try {
    const lock = await siteRequest(env, 'check-status', { body: { action: 'acquire' } });
    lockToken = lock.lockToken;
    await siteRequest(env, 'check-status', { body: { action: 'started' } });
    await backfillAnnouncementLinks(env, lockToken);

    const firstPage = await fetchPrcPage(0);
    const lastPage = getLastPage(firstPage.html);
    const scanState = await siteRequest(env, 'check-status?action=scan-state', { method: 'GET' });
    const cursor = Number.isInteger(scanState.cursor) ? scanState.cursor : 3;
    const recentPages = Math.max(1, Math.min(5, Number(env.RECENT_PAGES_PER_CHECK) || 3));
    const historicalPages = Math.max(0, Math.min(5, Number(env.HISTORICAL_PAGES_PER_CHECK) || 2));
    const delayMs = Math.max(250, Math.min(5000, Number(env.PRC_PAGE_DELAY_MS) || 350));
    const pages = new Set([0]);
    for (let page = 1; page < recentPages && page <= lastPage; page += 1) pages.add(page);
    if (lastPage >= 3) {
      for (let offset = 0; offset < historicalPages; offset += 1) pages.add(Math.min(cursor + offset, lastPage));
    }

    const all = extractResults(firstPage.html, firstPage.url);
    console.log(JSON.stringify({ event: 'prc_page_parsed', timestamp: new Date().toISOString(), page: 0, resultCount: all.length }));
    for (const page of [...pages].filter((number) => number !== 0).sort((a, b) => a - b)) {
      await sleep(delayMs);
      const fetched = await fetchPrcPage(page);
      const pageResults = extractResults(fetched.html, fetched.url);
      all.push(...pageResults);
      console.log(JSON.stringify({ event: 'prc_page_parsed', timestamp: new Date().toISOString(), page, resultCount: pageResults.length }));
    }
    const results = [...new Map(all.map((result) => [result.url, result])).values()].sort((a, b) => b.date.localeCompare(a.date));
    if (!results.length) throw new Error('No dated result announcements were parsed from the official PRC page.');

    const summary = await siteRequest(env, 'check-results', {
      body: { results, pages: pages.size, lockToken }, lockToken, timeoutMs: 60000,
    });
    const announcements = [];
    for (const url of summary.announcementUrls || []) {
      try {
        const fetched = await fetchPrcArticle(url);
        announcements.push({ url, resources: extractResources(fetched, url), details: extractAnnouncementDetails(fetched) });
      } catch (error) { console.warn(`Could not read PRC files for ${url}: ${error.message}`); }
    }
    if (announcements.length) {
      await siteRequest(env, 'cache-announcement-links', { body: { announcements }, lockToken, timeoutMs: 60000 });
    }
    if (lastPage >= 3 && historicalPages > 0) {
      const nextCursor = cursor + historicalPages > lastPage ? 3 : cursor + historicalPages;
      await siteRequest(env, 'check-status', { body: { action: 'scan-state', cursor: nextCursor } });
    }
    await siteRequest(env, 'check-status', { body: { action: 'success', resultCount: results.length, newResults: summary.newResults || 0, pageCount: pages.size } });
    console.log(JSON.stringify({ event: 'check_succeeded', checked: results.length, pages: pages.size, archivePage: lastPage, newResults: summary.newResults || 0 }));
    return { ok: true, ...summary, checked: results.length, pageCount: pages.size, archivePage: lastPage };
  } catch (error) {
    if (!lockToken && /HTTP 409/.test(error.message)) {
      console.log(JSON.stringify({ event: 'check_skipped', reason: 'another check is running' }));
      return { ok: true, skipped: true, reason: 'A PRC check is already running.' };
    }
    try { await siteRequest(env, 'check-status', { body: { action: 'failure', error: error.message } }); }
    catch (statusError) { console.error(`Could not report checker failure to site: ${statusError.message}`); }
    throw error;
  } finally {
    if (lockToken) {
      try { await siteRequest(env, 'check-status', { body: { action: 'release', lockToken } }); }
      catch (error) { console.error(`Could not release result-check lock: ${error.message}`); }
    }
  }
}

async function fetchPrcArticle(articleUrl) {
  const url = isPrcUrl(articleUrl, PRC_URL);
  if (!url || !(/^\/article\/[a-z0-9-]+$/i.test(url.pathname) || /^\/node\/\d+$/i.test(url.pathname))) throw new Error('Invalid PRC article URL.');
  const errors = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await sleep([1000, 4000][attempt - 1]);
    for (const host of PRC_HOSTS) {
      const candidate = new URL(url.href);
      candidate.hostname = host;
      try {
        let current = candidate;
        let response;
        for (let redirects = 0; redirects <= 5; redirects += 1) {
          response = await fetch(current, {
            redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; BoardExamTracker/1.0; +https://www.boardexamtracker.com)',
            Accept: 'text/html,application/xhtml+xml',
          },
            signal: AbortSignal.timeout(10000),
          });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          const redirected = location ? new URL(location, current) : null;
          if (!redirected || redirected.protocol !== 'https:' || !PRC_HOSTS.includes(redirected.hostname)) throw new Error('PRC redirected outside the approved source hosts.');
          current = redirected;
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error('PRC exceeded the redirect limit.');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        if (html.length > 4 * 1024 * 1024) throw new Error('PRC article response exceeded the 4 MB limit.');
        return html;
      } catch (error) {
        errors.push(`${host}: ${error.message}`);
      }
    }
  }
  throw new Error(`PRC announcement could not be fetched after retries (${errors.join(' | ')})`);
}

export default {
  async scheduled(controller, env, ctx) {
    const startedAt = Date.now();
    console.log(JSON.stringify({ event: 'scheduled_check_started', cron: controller.cron, scheduledTime: controller.scheduledTime }));
    ctx.waitUntil(publishCheck(env)
      .then(() => console.log(JSON.stringify({ event: 'scheduled_check_finished', durationMs: Date.now() - startedAt })))
      .catch((error) => console.error(JSON.stringify({ event: 'scheduled_check_failed', durationMs: Date.now() - startedAt, error: error.message }))));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/manual-check' && request.method === 'POST') {
      if (!env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${env.CRON_SECRET}`) return new Response(JSON.stringify({ error: 'Unauthorized.' }), { status: 401, headers: { 'content-type': 'application/json' } });
      ctx.waitUntil(publishCheck(env).catch((error) => console.error(JSON.stringify({ event: 'manual_check_failed', error: error.message }))));
      return Response.json({ started: true, message: 'The online PRC check has started. Check the admin dashboard for its result.' }, { status: 202 });
    }
    return new Response('PRC result checker is online. Scheduled checks run every minute.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
