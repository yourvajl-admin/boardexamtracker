const { createHash } = require('node:crypto');

const ANNOUNCEMENT_KEY_PREFIX = 'boardexamtracker:announcement:v1:';
const ANNOUNCEMENT_INDEX_KEY = 'boardexamtracker:announcements:index:v1';
const OFFICIAL_HOSTS = new Set(['www.prc.gov.ph', 'prc.gov.ph']);

function canonicalArticleUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !OFFICIAL_HOSTS.has(url.hostname)) return null;
    if (!/^\/(?:index\.php\/)?article\/[a-z0-9-]+\/?$/i.test(url.pathname) && !/^\/node\/\d+\/?$/i.test(url.pathname)) return null;
    url.hostname = 'www.prc.gov.ph';
    url.pathname = url.pathname.replace(/^\/index\.php(?=\/article\/)/, '').replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateAnnouncement(input) {
  if (!input || typeof input !== 'object') return { valid: false, reason: 'Announcement data is missing.' };
  const url = canonicalArticleUrl(input.url);
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
  if (!url) return { valid: false, reason: 'The source URL is not a canonical PRC article URL.' };
  if (title.length < 12 || title.length > 240 || !/\b(result|results|licensure examination|board examination|examination result|successful examinees)\b/i.test(title)) {
    return { valid: false, reason: 'The announcement title is incomplete or is not clearly a result notice.', url, title };
  }
  if (!isValidIsoDate(input.date)) return { valid: false, reason: 'The official publication date is missing or invalid.', url, title };
  const category = typeof input.category === 'string' ? input.category.replace(/[<>]/g, '').trim().slice(0, 80) : 'PRC Examination Result';
  const description = typeof input.description === 'string' ? input.description.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 1200) : '';
  return { valid: true, announcement: { title, date: input.date, url, category: category || 'PRC Examination Result', description } };
}

function announcementId(url) {
  const canonical = canonicalArticleUrl(url);
  if (!canonical) throw new Error('Cannot create an ID for an invalid PRC article URL.');
  return createHash('sha256').update(canonical).digest('hex');
}

function announcementKey(url) {
  return `${ANNOUNCEMENT_KEY_PREFIX}${announcementId(url)}`;
}

async function upsertAnnouncement(input, redisCommand, now = Date.now()) {
  const checked = validateAnnouncement(input);
  if (!checked.valid) {
    if (!checked.url || !checked.title) return { valid: false, reason: checked.reason, status: 'pending' };
    const key = announcementKey(checked.url);
    const saved = await redisCommand('GET', key);
    let previous = null;
    if (typeof saved === 'string') {
      try { previous = JSON.parse(saved); } catch { previous = null; }
    }
    const record = {
      id: announcementId(checked.url),
      title: checked.title,
      publicationDate: isValidIsoDate(input.date) ? input.date : null,
      canonicalUrl: checked.url,
      documentUrls: Array.isArray(previous?.documentUrls) ? previous.documentUrls : [],
      firstDetectedAt: previous?.firstDetectedAt || new Date(now).toISOString(),
      lastVerifiedAt: new Date(now).toISOString(),
      publicationStatus: 'pending',
      notificationStatus: 'not-required',
      errorDetails: checked.reason,
    };
    await redisCommand('SET', key, JSON.stringify(record));
    return { valid: false, reason: checked.reason, status: 'pending', record };
  }
  const item = checked.announcement;
  const key = announcementKey(item.url);
  const initialRecord = {
    id: announcementId(item.url),
    title: item.title,
    publicationDate: item.date,
    canonicalUrl: item.url,
    documentUrls: [],
    firstDetectedAt: new Date(now).toISOString(),
    lastVerifiedAt: new Date(now).toISOString(),
    publicationStatus: 'published',
    notificationStatus: 'pending',
    category: item.category,
    description: item.description,
  };
  if (await redisCommand('SET', key, JSON.stringify(initialRecord), 'NX') === 'OK') {
    await redisCommand('ZADD', ANNOUNCEMENT_INDEX_KEY, String(Date.parse(item.date)), item.url);
    return { valid: true, isNew: true, record: initialRecord };
  }
  const saved = await redisCommand('GET', key);
  let previous = null;
  if (typeof saved === 'string') {
    try { previous = JSON.parse(saved); } catch { previous = null; }
  }
  const record = {
    ...initialRecord,
    documentUrls: Array.isArray(previous?.documentUrls) ? previous.documentUrls : [],
    firstDetectedAt: previous?.firstDetectedAt || initialRecord.firstDetectedAt,
    notificationStatus: previous?.notificationStatus || 'pending',
  };
  await redisCommand('SET', key, JSON.stringify(record));
  await redisCommand('ZADD', ANNOUNCEMENT_INDEX_KEY, String(Date.parse(item.date)), item.url);
  return { valid: true, isNew: false, record };
}

async function loadPublishedAnnouncements(redisCommand, limit = 5000) {
  const urls = await redisCommand('ZREVRANGE', ANNOUNCEMENT_INDEX_KEY, '0', String(Math.max(0, Math.min(10000, limit) - 1)));
  if (!Array.isArray(urls) || !urls.length) return [];
  const keys = urls.map(announcementKey);
  const values = await redisCommand('MGET', ...keys);
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    if (typeof value !== 'string') return [];
    try {
      const record = JSON.parse(value);
      if (record.publicationStatus !== 'published' || !isValidIsoDate(record.publicationDate) || canonicalArticleUrl(record.canonicalUrl) !== record.canonicalUrl) return [];
      return [{ title: record.title, date: record.publicationDate, url: record.canonicalUrl, category: record.category || 'PRC Examination Result', description: record.description || '' }];
    } catch { return []; }
  });
}

async function attachAnnouncementDocuments(url, resources, redisCommand, now = Date.now()) {
  const canonicalUrl = canonicalArticleUrl(url);
  if (!canonicalUrl) return false;
  const key = announcementKey(canonicalUrl);
  const saved = await redisCommand('GET', key);
  if (typeof saved !== 'string') return false;
  let record;
  try { record = JSON.parse(saved); } catch { return false; }
  const documents = (Array.isArray(resources) ? resources : []).flatMap((resource) => {
    if (typeof resource?.label !== 'string' || typeof resource?.url !== 'string') return [];
    try {
      const candidate = new URL(resource.url);
      if (candidate.protocol !== 'https:' || !['prc.gov.ph', 'www.prc.gov.ph', 'drive.google.com', 'docs.google.com'].includes(candidate.hostname)) return [];
      return [{ label: resource.label.replace(/[<>]/g, '').trim().slice(0, 200), url: candidate.href }];
    } catch { return []; }
  });
  record.documentUrls = [...new Map(documents.map((document) => [document.url, document])).values()].slice(0, 30);
  record.lastVerifiedAt = new Date(now).toISOString();
  await redisCommand('SET', key, JSON.stringify(record));
  return true;
}

module.exports = { ANNOUNCEMENT_KEY_PREFIX, ANNOUNCEMENT_INDEX_KEY, announcementId, announcementKey, attachAnnouncementDocuments, canonicalArticleUrl, isValidIsoDate, loadPublishedAnnouncements, upsertAnnouncement, validateAnnouncement };
