const cheerio = require('cheerio');
const { execFile } = require('node:child_process');
const dns = require('node:dns');
const { promisify } = require('node:util');
const { extractAnnouncementDetails, extractResultDetails } = require('./announcement-details');
const { PROFESSION_CATEGORIES, categorize } = require('./professions');

// PRC's web server is intermittently unreachable over IPv6 from hosted runners.
// Prefer IPv4 for Node's fetch so a broken IPv6 route does not fail the check.
dns.setDefaultResultOrder('ipv4first');

const SOURCE_URL = 'https://www.prc.gov.ph/articles/exam-results';
const ALLOWED_HOSTS = new Set(['prc.gov.ph', 'www.prc.gov.ph']);
const RESULT_TERMS = /\b(result|results|licensure examination|board examination|examination result)\b/i;
const PAGE_DELAY_MS = 500;
const SOURCE_HOSTS = ['www.prc.gov.ph', 'prc.gov.ph'];
// PRC sometimes refuses new connections briefly; back off across multiple
// runner attempts instead of exhausting all retries within a few seconds.
const SOURCE_RETRY_DELAYS_MS = [1000, 4000, 12000];
const execFileAsync = promisify(execFile);
const PRC_REQUEST_HEADERS = {
  'User-Agent': 'BoardExamTracker/1.0 (+independent public results index)',
  Accept: 'text/html',
};
function normalizeUrl(href) {
  try {
    const url = new URL(href, SOURCE_URL);
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) return null;
    // PRC serves the same article from both the www and bare hostnames.
    // Treat those aliases (and index.php/trailing-slash variants) as one result.
    url.hostname = 'www.prc.gov.ph';
    if (url.pathname.startsWith('/index.php/article/')) url.pathname = url.pathname.slice('/index.php'.length);
    if (url.pathname.startsWith('/article/')) url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function parseDate(value) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
  }
  // Drupal can render date and title as adjacent text nodes without spaces.
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

function extractAnnouncementLinks(html, articleUrl) {
  const $ = cheerio.load(html);
  const resourceLabel = /(full text of (?:the )?official result|official result|performance of (?:the )?schools|successful examinees|list of (?:the )?examinees|list of successful|top\s*10|highest places|result document|examinees list)/i;
  const resources = [];
  $('a[href]').each((_, element) => {
    const anchor = $(element);
    const label = anchor.text().replace(/\s+/g, ' ').trim();
    const href = anchor.attr('href');
    if (!label || !resourceLabel.test(label) || !href) return;
    try {
      const url = new URL(href, articleUrl);
      if (url.protocol !== 'https:' || !['www.prc.gov.ph', 'prc.gov.ph', 'drive.google.com', 'docs.google.com'].includes(url.hostname)) return;
      resources.push({ label, url: url.href });
    } catch {
      // Ignore malformed links published in the announcement.
    }
  });
  return [...new Map(resources.map((resource) => [resource.url, resource])).values()];
}

async function fetchAnnouncementLinks(articleUrl, options = {}) {
  const html = await fetchPrcHtml(articleUrl, { maxBytes: 4 * 1024 * 1024, ...options });
  return {
    resources: extractAnnouncementLinks(html, articleUrl),
    details: extractAnnouncementDetails(html),
  };
}

async function fetchPrcHtml(sourceUrl, { maxBytes = 2 * 1024 * 1024, fetchImpl = fetch, curlFallback = true, retryDelays = SOURCE_RETRY_DELAYS_MS, timeoutMs = 8000 } = {}) {
  const original = new URL(sourceUrl);
  if (original.protocol !== 'https:' || !ALLOWED_HOSTS.has(original.hostname)) throw new Error('Only official PRC HTTPS URLs can be fetched.');
  const urls = SOURCE_HOSTS.map((host) => {
    const url = new URL(original.href);
    url.hostname = host;
    return url.href;
  });
  const errors = [];
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt - 1]));
    for (const url of urls) {
      try {
        let candidate = new URL(url);
        let response;
        for (let redirects = 0; redirects <= 5; redirects += 1) {
          response = await fetchImpl(candidate, { headers: PRC_REQUEST_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          const redirect = location ? new URL(location, candidate) : null;
          if (!redirect || redirect.protocol !== 'https:' || !ALLOWED_HOSTS.has(redirect.hostname)) throw new Error('PRC redirected outside the approved PRC hosts.');
          candidate = redirect;
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error('PRC exceeded the redirect limit.');
        if (!response.ok) throw new Error(`PRC returned HTTP ${response.status}`);
        const html = await response.text();
        if (Buffer.byteLength(html) > maxBytes) throw new Error(`PRC page exceeded the ${maxBytes}-byte response limit.`);
        return html;
      } catch (fetchError) {
        try {
          if (!curlFallback || /redirected outside|redirect limit/.test(fetchError.message)) throw fetchError;
          const { stdout } = await execFileAsync('curl', [
            '--ipv4', '--fail', '--silent', '--show-error', '--compressed', '--max-time', String(Math.ceil(timeoutMs / 1000)),
            '--user-agent', 'Mozilla/5.0 (compatible; BoardExamTracker/1.0; +https://www.boardexamtracker.com)',
            '--header', 'Accept: text/html,application/xhtml+xml',
            url,
          ], { maxBuffer: maxBytes, timeout: 10000 });
          if (Buffer.byteLength(stdout) > maxBytes) throw new Error(`PRC page exceeded the ${maxBytes}-byte response limit.`);
          return stdout;
        } catch (curlError) {
          errors.push(`${new URL(url).hostname}: ${fetchError.message}; curl: ${curlError.message}`);
        }
      }
    }
  }
  throw new Error(`PRC page could not be fetched after retries (${errors.join(' | ')})`);
}

function extractResults(html) {
  const $ = cheerio.load(html);
  const rows = [];
  // PRC currently renders results as dated listing items with a linked announcement title.
  $('a[href]').each((_, element) => {
    const anchor = $(element);
    const title = anchor.text().replace(/\s+/g, ' ').trim();
    const url = normalizeUrl(anchor.attr('href'));
    if (!url || !title || !RESULT_TERMS.test(title) || /articles\/exam-results\/?$/.test(url)) return;
    let container = anchor;
    for (let depth = 0; depth < 5 && container.parent().length; depth += 1) {
      container = container.parent();
      if (/\b\d{1,2}\s*[A-Za-z]+,?\s*\d{4}(?!\d)/.test(container.text())) break;
    }
    const text = container.text().replace(/\s+/g, ' ').trim();
    const date = parseDate(text);
    if (!date) return;
    const excerpt = container.find('p').first().text().replace(/\s+/g, ' ').trim() || text.replace(title, '').replace(/\d{1,2}\s+[A-Za-z]+,?\s+\d{4}/, '').trim();
    const category = categorize(title);
    const details = extractResultDetails(excerpt);
    rows.push({ title, category, date, description: [details.summary, ...details.facts].filter(Boolean).join(' ') || excerpt || title, url });
  });
  const unique = new Map();
  for (const item of rows) if (!unique.has(item.url)) unique.set(item.url, item);
  return [...unique.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function getLastPage(html) {
  const $ = cheerio.load(html);
  let lastPage = 0;
  $('.pager a[href], nav[aria-label*="pagination"] a[href], [class*="pager"] a[href]').each((_, element) => {
    try {
      const url = new URL($(element).attr('href'), SOURCE_URL);
      if (!ALLOWED_HOSTS.has(url.hostname) || !url.pathname.startsWith('/articles/exam-results')) return;
      const page = Number(url.searchParams.get('page'));
      if (Number.isInteger(page) && page >= 0 && page <= 500) lastPage = Math.max(lastPage, page);
    } catch {
      // Ignore malformed pagination links.
    }
  });
  return lastPage;
}

async function fetchListingPage(page = 0) {
  const url = new URL(SOURCE_URL);
  if (page > 0) url.searchParams.set('page', String(page));
  try {
    return await fetchPrcHtml(url.href);
  } catch (error) {
    throw new Error(`PRC results page ${page} could not be fetched: ${error.message}`);
  }
}

async function fetchResults({ maxPage } = {}) {
  const firstPage = await fetchListingPage();
  const archiveLastPage = getLastPage(firstPage);
  const lastPage = Number.isInteger(maxPage) ? Math.min(archiveLastPage, maxPage) : archiveLastPage;
  const pages = [extractResults(firstPage)];
  for (let page = 1; page <= lastPage; page += 1) {
    await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
    pages.push(extractResults(await fetchListingPage(page)));
  }
  const results = pages.flat();
  if (!results.length) throw new Error('No dated exam result announcements were found on the PRC page.');
  const unique = new Map();
  for (const item of results) if (!unique.has(item.url)) unique.set(item.url, item);
  return [...unique.values()].sort((a, b) => b.date.localeCompare(a.date));
}

module.exports = { SOURCE_URL, PROFESSION_CATEGORIES, extractResults, fetchResults, fetchPrcHtml, normalizeUrl, parseDate, categorize, fetchAnnouncementLinks, extractAnnouncementLinks, extractAnnouncementDetails, getLastPage };
