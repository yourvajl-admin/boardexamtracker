const cheerio = require('cheerio');

const SOURCE_URL = 'https://www.prc.gov.ph/articles/exam-results';
const ALLOWED_HOSTS = new Set(['prc.gov.ph', 'www.prc.gov.ph']);
const RESULT_TERMS = /\b(result|results|licensure examination|board examination|examination result)\b/i;
const PAGE_DELAY_MS = 500;
const PROFESSION_CATEGORIES = [
  'Accountancy', 'Aeronautical Engineering', 'Agricultural and Biosystems Engineering', 'Agriculture', 'Architecture',
  'Chemical Engineering', 'Chemistry', 'Civil Engineering', 'Criminology', 'Customs Brokers', 'Dentistry',
  'Electrical Engineering', 'Electronics Engineering', 'Environmental Planning', 'Fisheries', 'Food Technology',
  'Foresters', 'Geodetic Engineering', 'Geology', 'Guidance and Counseling', 'Interior Design', 'Landscape Architecture',
  'Librarianship', 'Master Plumbing', 'Mechanical Engineering', 'Medical Technology', 'Medicine', 'Metallurgical Engineering',
  'Midwifery', 'Mining Engineering', 'Naval Architecture', 'Nursing', 'Nutrition and Dietetics', 'Occupational Therapy',
  'Optometry', 'Pharmacy', 'Physical Therapy', 'Professional Teachers', 'Psychology', 'Radiologic Technology',
  'Real Estate Service', 'Respiratory Therapy', 'Sanitary Engineering', 'Social Workers', 'Speech-Language Pathology',
  'Veterinary Medicine',
];

function normalizeUrl(href) {
  try {
    const url = new URL(href, SOURCE_URL);
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function parseDate(value) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  const match = text.match(/\b(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\b/);
  if (!match) return null;
  const date = new Date(`${match[2]} ${match[1]}, ${match[3]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function categorize(title) {
  const checks = [
    ['Accountancy', /\b(certified public accountants?|accountants?|cpas?)\b/i],
    ['Aeronautical Engineering', /\baeronautical engineers?\b/i],
    ['Agricultural and Biosystems Engineering', /\bagricultural and biosystems engineers?\b/i],
    ['Agriculture', /\b(agriculturists?|agriculture licensure|agriculture professionals?)\b/i],
    ['Landscape Architecture', /\blandscape architects?\b/i],
    ['Naval Architecture', /\bnaval architects?\b/i],
    ['Architecture', /\barchitects? licensure|\barchitects? examination|\barchitects?\b/i],
    ['Chemical Engineering', /\bchemical engineers?\b/i],
    ['Chemistry', /\b(chemists?|chemical technicians?)\b/i],
    ['Civil Engineering', /\bcivil engineers?\b/i],
    ['Criminology', /\bcriminologists?\b/i],
    ['Customs Brokers', /\bcustoms brokers?\b/i],
    ['Dentistry', /\b(dentists?|dental hygienists?|dental technologists?)\b/i],
    ['Electrical Engineering', /\b(electrical engineers?|master electricians?)\b/i],
    ['Electronics Engineering', /\b(electronics engineers?|electronics technicians?)\b/i],
    ['Environmental Planning', /\benvironmental planners?\b/i],
    ['Fisheries', /\bfisheries professionals?\b/i],
    ['Food Technology', /\bfood technologists?\b/i],
    ['Foresters', /\bforesters?\b/i],
    ['Geodetic Engineering', /\bgeodetic engineers?\b/i],
    ['Geology', /\bgeologists?\b/i],
    ['Guidance and Counseling', /\b(guidance counselors?|guidance and counseling)\b/i],
    ['Interior Design', /\binterior designers?\b/i],
    ['Librarianship', /\blibrarians?\b/i],
    ['Master Plumbing', /\bmaster plumbers?\b/i],
    ['Mechanical Engineering', /\b(mechanical engineers?|professional mechanical engineers?|certified plant mechanics?)\b/i],
    ['Medical Technology', /\b(medical technologists?|medical laboratory technicians?)\b/i],
    ['Medicine', /\b(physicians?|medical doctors?|foreign medical professionals?)\b/i],
    ['Metallurgical Engineering', /\bmetallurgical engineers?\b/i],
    ['Midwifery', /\bmidwives?\b/i],
    ['Mining Engineering', /\bmining engineers?\b/i],
    ['Naval Architecture', /\bnaval architects?\b/i],
    ['Nursing', /\bnurses?\b/i],
    ['Nutrition and Dietetics', /\b(nutritionist[- ]dietitians?|nutrition and dietetics)\b/i],
    ['Occupational Therapy', /\boccupational therapists?\b/i],
    ['Optometry', /\boptometrists?\b/i],
    ['Pharmacy', /\bpharmacists?\b/i],
    ['Physical Therapy', /\bphysical therapists?\b/i],
    ['Professional Teachers', /\b(teachers?|let)\b/i],
    ['Psychology', /\b(psychologists?|psychometricians?)\b/i],
    ['Radiologic Technology', /\b(radiologic technologists?|x[- ]ray technologists?)\b/i],
    ['Real Estate Service', /\b(real estate (?:brokers?|appraisers?|consultants?|service professionals?))\b/i],
    ['Respiratory Therapy', /\brespiratory therapists?\b/i],
    ['Sanitary Engineering', /\bsanitary engineers?\b/i],
    ['Social Workers', /\bsocial workers?\b/i],
    ['Speech-Language Pathology', /\bspeech[- ]language pathologists?\b/i],
    ['Veterinary Medicine', /\b(veterinarians?|veterinary medicine)\b/i],
  ];
  return checks.find(([, pattern]) => pattern.test(title))?.[0] || 'PRC Examination Result';
}

function extractAnnouncementLinks(html, articleUrl) {
  const $ = cheerio.load(html);
  const resourceLabel = /(official result|performance of schools|successful examinees|list of examinees|list of successful|result document|examinees list)/i;
  const resources = [];
  $('a[href]').each((_, element) => {
    const anchor = $(element);
    const label = anchor.text().replace(/\s+/g, ' ').trim();
    const href = anchor.attr('href');
    if (!label || !resourceLabel.test(label) || !href) return;
    try {
      const url = new URL(href, articleUrl);
      if (url.protocol !== 'https:') return;
      resources.push({ label, url: url.href });
    } catch {
      // Ignore malformed links published in the announcement.
    }
  });
  return [...new Map(resources.map((resource) => [resource.url, resource])).values()];
}

function rephraseResultDetails(title, category, sourceText) {
  const text = (sourceText || '').replace(/\s+/g, ' ');
  const passMatch = text.match(/([\d,]+)\s+out of\s+([\d,]+)\s+passed the\s+(.+?)(?:\s+given by|\s+in\s+\d+\s+testing centers|\s+last\s+[A-Z]|\.|$)/i);
  const titleSubject = title
    .replace(/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s+/i, '')
    .replace(/\s+results?\b.*$/i, '')
    .replace(/^licensure examination for\s+/i, '')
    .replace(/\s+(?:computer[- ]based\s+)?licensure examination.*$/i, '')
    .replace(/\s+examination.*$/i, '')
    .trim();
  const subject = passMatch
    ? passMatch[3].replace(/^licensure examination for\s+/i, '').replace(/\s+licensure examination$/i, '').replace(/\s+examination$/i, '').trim()
    : category !== 'PRC Examination Result' ? category : titleSubject || 'professional';
  const summary = passMatch
    ? `${passMatch[1]} of ${passMatch[2]} candidates passed the ${subject} licensure exam.`
    : `PRC published the results for the ${subject} licensure examination.`;
  const facts = [];
  const centers = text.match(/\b(\d{1,3})\s+testing centers\b/i);
  if (centers) facts.push(`The exam was administered at ${centers[1]} testing centers.`);
  const examPeriod = text.match(/\blast\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\b/i);
  if (examPeriod) facts.push(`The examination took place in ${examPeriod[1]}.`);
  const withheld = text.match(/with respect to\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s*\((\d+)\)\s+examinees?[^.]*withheld/i);
  if (withheld) facts.push(`PRC is still reviewing the results for ${withheld[1]} examinees.`);
  const turnaround = (title + ' ' + text).match(/released in\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s*(?:\(\d+\)\s*)?working days?/i);
  if (turnaround) {
    const numbers = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const days = numbers[turnaround[1].toLowerCase()] || Number(turnaround[1]);
    facts.push(`The results were posted ${days} working ${days === 1 ? 'day' : 'days'} after the exam ended.`);
  }
  if (!facts.length && !passMatch) facts.push(`The announcement was published by PRC on ${title.match(/\b\d{4}\b/)?.[0] || 'the date shown above'}.`);
  return { summary, facts };
}

function extractAnnouncementDetails(html) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const category = categorize(title);
  const paragraphs = [];
  $('article p, main p, .field--name-body p, .node__content p').each((_, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    if (text.length >= 25) paragraphs.push(text);
  });
  return rephraseResultDetails(title, category, paragraphs.join(' '));
}

async function fetchAnnouncementLinks(articleUrl) {
  const response = await fetch(articleUrl, {
    headers: { 'User-Agent': 'BoardExamTracker/1.0 (+independent public results index)', Accept: 'text/html' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`PRC returned HTTP ${response.status}`);
  const html = await response.text();
  return {
    resources: extractAnnouncementLinks(html, articleUrl),
    details: extractAnnouncementDetails(html),
  };
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
      if (/\b\d{1,2}\s+[A-Za-z]+,?\s+\d{4}\b/.test(container.text())) break;
    }
    const text = container.text().replace(/\s+/g, ' ').trim();
    const date = parseDate(text);
    if (!date) return;
    const excerpt = container.find('p').first().text().replace(/\s+/g, ' ').trim() || text.replace(title, '').replace(/\d{1,2}\s+[A-Za-z]+,?\s+\d{4}/, '').trim();
    const category = categorize(title);
    const details = rephraseResultDetails(title, category, excerpt);
    rows.push({ title, category, date, description: [details.summary, ...details.facts].join(' '), url });
  });
  const unique = new Map();
  for (const item of rows) if (!unique.has(item.url)) unique.set(item.url, item);
  return [...unique.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function getLastPage(html) {
  const $ = cheerio.load(html);
  let lastPage = 0;
  $('.pager a[href], nav[aria-label*="pagination"] a[href]').each((_, element) => {
    try {
      const url = new URL($(element).attr('href'), SOURCE_URL);
      if (url.hostname !== 'www.prc.gov.ph' || !url.pathname.startsWith('/articles/exam-results')) return;
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
  const response = await fetch(url, {
    headers: { 'User-Agent': 'BoardExamTracker/1.0 (+independent public results index)', Accept: 'text/html' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('PRC results page ' + page + ' returned HTTP ' + response.status);
  return response.text();
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

module.exports = { SOURCE_URL, PROFESSION_CATEGORIES, extractResults, fetchResults, normalizeUrl, categorize, fetchAnnouncementLinks, extractAnnouncementLinks, extractAnnouncementDetails, getLastPage };
