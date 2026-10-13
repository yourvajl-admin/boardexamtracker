const cheerio = require('cheerio');
const { extractAnnouncementDetails } = require('../src/announcement-details');

const PRC_URL = 'https://www.prc.gov.ph/articles/exam-results';
const PRC_HOSTS = ['www.prc.gov.ph', 'prc.gov.ph'];
const RESULT_TERMS = /\b(result|results|licensure examination|board examination|examination result)\b/i;
const RESOURCE_TERMS = /(full text of (?:the )?official result|official result|performance of (?:the )?schools|successful examinees|list of (?:the )?examinees|list of successful|top\s*10|highest places|result document|examinees list)/i;

function parseDate(value) {
  const match = String(value || '').replace(/\s+/g, ' ').match(/\b(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\b/);
  if (!match) return null;
  const date = new Date(`${match[2]} ${match[1]}, ${match[3]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function isPrcUrl(href, base) {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'https:' || !['prc.gov.ph', 'www.prc.gov.ph'].includes(url.hostname)) return null;
    if (url.pathname.startsWith('/index.php/article/')) url.pathname = url.pathname.slice('/index.php'.length);
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
      if (/\b\d{1,2}\s+[A-Za-z]+,?\s+\d{4}\b/.test(container.text())) break;
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

function categorize(title) {
  const labels = [
    ['Naval Architecture', /naval architects?/i], ['Nursing', /nurses?/i], ['Professional Teachers', /\bteachers?|\bLET\b/i],
    ['Civil Engineering', /civil engineers?/i], ['Fisheries', /fisheries professionals?/i], ['Psychology', /psychologists?|psychometricians?/i],
    ['Architecture', /architects?/i], ['Accountancy', /accountants?|\bCPAs?\b/i], ['Criminology', /criminologists?/i],
    ['Medical Technology', /medical technologists?/i], ['Pharmacy', /pharmacists?/i], ['Engineering', /engineers?/i],
  ];
  return labels.find(([, pattern]) => pattern.test(title))?.[0] || 'PRC Examination Result';
}

function summarize(title, description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  const passed = text.match(/([\d,]+)\s+out of\s+([\d,]+)\s+passed the\s+(.+?)(?:\s+given by|\s+in\s+\d+\s+testing centers|\.|$)/i);
  if (passed) return `${passed[1]} of ${passed[2]} candidates passed the ${passed[3].trim()} exam.`;
  return text.slice(0, 500) || `PRC published the results for ${title}.`;
}

function extractResources(html, articleUrl) {
  const $ = cheerio.load(html);
  const resources = [];
  $('a[href]').each((_, element) => {
    const label = $(element).text().replace(/\s+/g, ' ').trim();
    const href = $(element).attr('href');
    if (!label || !href || !RESOURCE_TERMS.test(label)) return;
    try {
      const url = new URL(href, articleUrl);
      if (url.protocol === 'https:' && ['drive.google.com', 'prc.gov.ph', 'www.prc.gov.ph'].includes(url.hostname)) {
        resources.push({ label, url: url.href });
      }
    } catch {
      // Skip malformed attachment URLs.
    }
  });
  return [...new Map(resources.map((resource) => [resource.url, resource])).values()];
}

async function fetchPrcPage(page) {
  const errors = [];
  for (const host of PRC_HOSTS) {
    const url = new URL(PRC_URL);
    url.hostname = host;
    if (page > 0) url.searchParams.set('page', String(page));
    for (const path of [url.pathname, `/index.php${url.pathname}`]) {
      const candidate = new URL(url.href);
      candidate.pathname = path;
      try {
        const response = await fetch(candidate, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; BoardExamTracker/1.0; +https://www.boardexamtracker.com)',
            Accept: 'text/html,application/xhtml+xml',
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { html: await response.text(), url: candidate.href };
      } catch (error) {
        errors.push(`${candidate.hostname}${candidate.pathname}: ${error.message}`);
      }
    }
  }
  throw new Error(`PRC request failed: ${errors.join(' | ')}`);
}

async function publishCheck(env) {
  if (!env.CRON_SECRET) throw new Error('Missing Worker secret CRON_SECRET.');
  const all = [];
  let pageCount = 0;
  for (let page = 0; page < 3; page += 1) {
    const fetched = await fetchPrcPage(page);
    const results = extractResults(fetched.html, fetched.url);
    if (page > 0 && !results.length) break;
    all.push(...results);
    pageCount += 1;
    if (page === 0) {
      const $ = cheerio.load(fetched.html);
      const hasNext = $('.pager a[href], nav[aria-label*="pagination"] a[href]').toArray().some((el) => {
        const href = $(el).attr('href') || '';
        return /(?:[?&]page=1\b|pager__item--next)/i.test(href) || /next/i.test($(el).text());
      });
      if (!hasNext) break;
    }
  }
  const results = [...new Map(all.map((result) => [result.url, result])).values()]
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!results.length) throw new Error('No dated result announcements were parsed from PRC.');

  const siteUrl = (env.SITE_CRON_URL || 'https://www.boardexamtracker.com/api/cron/check-results').replace(/\/$/, '');
  const response = await fetch(siteUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CRON_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ results }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Site result check returned HTTP ${response.status}: ${body}`);
  const summary = JSON.parse(body);

  const announcements = [];
  for (const url of summary.announcementUrls || []) {
    try {
      const fetched = await fetchPrcArticle(url);
      announcements.push({ url, resources: extractResources(fetched, url), details: extractAnnouncementDetails(fetched) });
    } catch (error) {
      console.warn(`Could not read attachments from ${url}: ${error.message}`);
    }
  }
  if (announcements.length) {
    const cacheUrl = siteUrl.replace(/\/check-results$/, '/cache-announcement-links');
    const cached = await fetch(cacheUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CRON_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcements }),
      signal: AbortSignal.timeout(60000),
    });
    if (!cached.ok) throw new Error(`Site attachment cache returned HTTP ${cached.status}: ${await cached.text()}`);
  }
  console.log(JSON.stringify({ checked: results.length, pages: pageCount, newResults: summary.newResults || 0, recipients: summary.recipients || 0 }));
}

async function fetchPrcArticle(articleUrl) {
  const url = isPrcUrl(articleUrl, PRC_URL);
  if (!url || !/^\/(?:index\.php\/)?article\//.test(url.pathname)) throw new Error('Invalid PRC article URL.');
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BoardExamTracker/1.0)', Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(publishCheck(env));
  },
  async fetch() {
    return new Response('PRC result checker is online. Scheduled checks run every five minutes.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
