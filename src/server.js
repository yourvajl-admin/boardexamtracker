require('./env').loadLocalEnv();

const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fetchResults, fetchAnnouncementLinks, normalizeUrl, SOURCE_URL, PROFESSION_CATEGORIES } = require('./scraper');
const bundledResultSnapshot = require('./fallback-results.json');
const bundledAnnouncementLinks = require('./fallback-announcement-links.json');
const { RESOURCE_INDEX_VERSION } = require('./prc-resources');
const { getCache, setCache, isFresh } = require('./cache');
const { isEmailConfigured, sendEmail } = require('./email');
const { adminConfig, authenticate, clearSessionCookie, createSession, isAuthenticated, setSessionCookie } = require('./admin-auth');
const { getActiveViewerCount, recordViewerHeartbeat } = require('./viewers');
const { announcementKey, attachAnnouncementDocuments, canonicalArticleUrl, loadPublishedAnnouncements, upsertAnnouncement } = require('./announcement-store');
const { sendUndeliveredResultAlert } = require('./result-alert-delivery');
const {
  addPendingSubscriber,
  confirmSubscriber,
  isPersistentStorageConfigured,
  listConfirmedSubscribers,
  listSubscribersForAdmin,
  migrateLegacySubscribers,
  markConfirmationSent,
  removeSubscriber,
  removeSubscriberByEmail,
  redisCommand,
} = require('./subscriptions');
const {
  addAuditLog,
  addMonthsToDate,
  createOrGetUser,
  createPayment,
  effectiveStatus,
  getActivePremiumSubscribers,
  getConfig,
  getPaymentById,
  getSubscriptionByEmail,
  getUserByEmail,
  getUserById,
  isValidEmail,
  listAllPayments,
  listAuditLogs,
  listEmailLogs,
  listPaymentsByEmail,
  listSubscriptions,
  normalizeEmail,
  publicSubscription,
  saveConfig,
  savePayment,
  saveSubscription,
  saveUser,
} = require('./premium-store');
const premiumAuth = require('./premium-auth');
const {
  activateSubscription,
  applyManualSubscription,
  cancelSubscription,
  createPremiumCheckout,
  ensureSubscription,
  expireDueSubscriptions,
  formatDate,
  formatPhp,
  ganapConfig,
  handleGanapCallback,
  notifyPremiumSubscribers,
  sendPremiumAlertToSubscriber,
  sendSubscriptionActivatedEmail,
} = require('./premium-service');

const app = express();
const port = Number(process.env.PORT) || 3000;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const INITIAL_RESULTS_LIMIT = 12;
const PERSISTENT_RESULT_SYNC_MS = 5 * 1000;
let sharp;
let shareFonts;
const KNOWN_RESULTS_KEY = 'boardexamtracker:known-results';
const RESULTS_CACHE_KEY = 'boardexamtracker:results-cache:v1';
const RESULTS_CHECK_LOCK_KEY = 'boardexamtracker:results-check-lock';
const RESULTS_CHECK_STATUS_KEY = 'boardexamtracker:results-check-status:v1';
const RESULTS_SCAN_CURSOR_KEY = 'boardexamtracker:results-scan-cursor:v1';
const ANNOUNCEMENT_BACKFILL_CURSOR_KEY = 'boardexamtracker:announcement-links:backfill-cursor:v1';
const ANNOUNCEMENT_BACKFILL_LOCK_KEY = 'boardexamtracker:announcement-links:backfill-lock:v1';
const ANNOUNCEMENT_BACKFILL_BATCH_SIZE = 6;
const ANNOUNCEMENT_BACKFILL_SCAN_SIZE = 60;
const ADSENSE_ENABLED_KEY = 'boardexamtracker:ads-enabled';
const BLOG_POSTS_KEY = 'boardexamtracker:blog:posts';
const BLOG_POST_INDEX_KEY = 'boardexamtracker:blog:index';
const BLOG_POST_IMAGE_KEY_PREFIX = 'boardexamtracker:blog:image:';
const BLOG_POST_LIMIT = 100;
const BLOG_PHOTO_LIMIT_BYTES = 1_000_000;
const ANNOUNCEMENT_CACHE_KEY_PREFIX = 'boardexamtracker:announcement-links:v1:';
let pendingFetch = null;
let pendingArchiveFetch = null;
let pendingPersistentResultRestore = null;
let lastPersistentResultRestoreAt = 0;
let archiveCacheLoaded = false;
const announcementCache = new Map();
let recentResultIndex = null;
let recentResultIndexFetchedAt = 0;
let recentResultIndexPromise = null;
let fullResultIndex = null;
let fullResultIndexFetchedAt = 0;
let fullResultIndexPromise = null;

function announcementCacheKey(articleUrl) {
  return `${ANNOUNCEMENT_CACHE_KEY_PREFIX}${Buffer.from(articleUrl).toString('base64url')}`;
}

function hasVerifiedAnnouncementDetails(details) {
  return details?.source === 'prc'
    && details.version === 2
    && typeof details.summary === 'string'
    && details.summary.trim().length > 0
    && Array.isArray(details.facts);
}

function hasCompleteAnnouncementLinks(value) {
  return hasVerifiedAnnouncementDetails(value?.details)
    && value.linksVersion === RESOURCE_INDEX_VERSION
    && (value.linksVerified === true || value.resources?.length > 0);
}

function preferBundledDetails(cached, bundled) {
  if (!cached) return bundled;
  return {
    ...cached,
    resources: cached.resources?.length ? cached.resources : bundled?.resources || [],
    details: hasVerifiedAnnouncementDetails(bundled?.details) && !hasVerifiedAnnouncementDetails(cached.details)
      ? bundled.details
      : cached.details,
  };
}

function findBundledAnnouncement(articleUrl) {
  const normalizedUrl = normalizeUrl(articleUrl);
  const targetUrl = normalizedUrl || articleUrl;
  const targetPath = targetUrl ? new URL(targetUrl).pathname.replace(/\/+$/, '') : '';
  const slugCore = targetPath ? targetPath.replace(/-(?:one|two|three|four|five|six|seven|eight|nine|ten)-\d+$/i, '').replace(/-(?:one|two|three|four|five|six|seven|eight|nine|ten)$/i, '').replace(/-\d+$/i, '') : '';

  for (const [key, value] of Object.entries(bundledAnnouncementLinks)) {
    const candidate = normalizeUrl(key);
    if (!candidate) continue;
    const candidatePath = new URL(candidate).pathname.replace(/\/+$/, '');
    const candidateCore = candidatePath.replace(/-(?:one|two|three|four|five|six|seven|eight|nine|ten)-\d+$/i, '').replace(/-(?:one|two|three|four|five|six|seven|eight|nine|ten)$/i, '').replace(/-\d+$/i, '');
    if (candidate === targetUrl || candidatePath === targetPath || candidateCore === slugCore) {
      return { ...value, fetchedAt: 0, bundled: true, linksVersion: RESOURCE_INDEX_VERSION };
    }
  }
  return null;
}

async function getCachedAnnouncement(articleUrl) {
  const bundledValue = findBundledAnnouncement(articleUrl);
  const memoryValue = announcementCache.get(articleUrl);
  const memoryTtl = memoryValue?.resources?.length || hasVerifiedAnnouncementDetails(memoryValue?.details)
    ? 30 * 24 * 60 * 60 * 1000
    : 6 * 60 * 60 * 1000;
  if (memoryValue && Date.now() - memoryValue.fetchedAt < memoryTtl) {
    return preferBundledDetails(memoryValue, bundledValue);
  }
  if (!isPersistentStorageConfigured()) return bundledValue;
  try {
    const saved = await redisCommand('GET', announcementCacheKey(articleUrl));
    if (typeof saved !== 'string') return bundledValue;
    const value = JSON.parse(saved);
    if (!Array.isArray(value.resources) || !Number.isFinite(value.fetchedAt)) return bundledValue;
    const ttl = value.resources.length || hasVerifiedAnnouncementDetails(value.details)
      ? 30 * 24 * 60 * 60 * 1000
      : 6 * 60 * 60 * 1000;
    if (Date.now() - value.fetchedAt >= ttl) return bundledValue;
    announcementCache.set(articleUrl, value);
    return preferBundledDetails(value, bundledValue);
  } catch (error) {
    console.warn('Could not read cached PRC announcement links:', error.message);
    return bundledValue;
  }
}

async function saveAnnouncementCache(articleUrl, value) {
  const cached = { ...value, fetchedAt: Date.now() };
  announcementCache.set(articleUrl, cached);
  if (!isPersistentStorageConfigured()) return false;
  try {
    const ttl = cached.resources?.length || hasVerifiedAnnouncementDetails(cached.details)
      ? 60 * 60 * 24 * 30
      : 60 * 60 * 6;
    await redisCommand('SET', announcementCacheKey(articleUrl), JSON.stringify(cached), 'EX', ttl);
    return true;
  } catch (error) {
    console.warn('Could not persist PRC announcement links:', error.message);
    return false;
  }
}

async function missingAnnouncementUrls(results, limit = 12) {
  const urls = [...new Set(results.map((result) => normalizeUrl(result?.url)).filter(Boolean))];
  const missing = [];
  for (const articleUrl of urls) {
    if (missing.length >= limit) break;
    const cached = await getCachedAnnouncement(articleUrl);
    if (!hasVerifiedAnnouncementDetails(cached?.details)) missing.push(articleUrl);
  }
  return missing;
}

function restoreBundledResultCache() {
  const cached = getCache();
  const results = Array.isArray(bundledResultSnapshot.results) ? bundledResultSnapshot.results : [];
  if (!results.length) return cached;
  archiveCacheLoaded = true;
  const bundledFetchedAt = Date.parse(bundledResultSnapshot.fetchedAt) || Date.now();
  const fetchedAt = Math.max(cached?.fetchedAt || 0, bundledFetchedAt);
  return setCache(mergeResultLists(cached?.results || [], results), fetchedAt);
}

function publicBlogPost(post) {
  const { imageData, ...fields } = post;
  return { ...fields, imageUrl: post.hasImage ? `/api/blog/posts/${encodeURIComponent(post.id)}/image?v=${post.updatedAt}` : null };
}

async function listBlogPosts(offset = 0, limit = BLOG_POST_LIMIT) {
  const ids = await redisCommand('ZREVRANGE', BLOG_POST_INDEX_KEY, String(offset), String(offset + limit - 1));
  if (!Array.isArray(ids) || !ids.length) return [];
  const values = await redisCommand('HMGET', BLOG_POSTS_KEY, ...ids);
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    if (typeof value !== 'string') return [];
    try { return [publicBlogPost(JSON.parse(value))]; } catch { return []; }
  });
}

async function getBlogPostById(id) {
  const value = await redisCommand('HGET', BLOG_POSTS_KEY, id);
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function saveBlogPost(post, imageData) {
  const metadata = {
    id: post.id,
    title: post.title,
    body: post.body,
    hasImage: Boolean(post.hasImage),
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
  const imageKey = `${BLOG_POST_IMAGE_KEY_PREFIX}${post.id}`;
  if (imageData !== undefined) {
    if (imageData) await redisCommand('SET', imageKey, imageData);
    else await redisCommand('DEL', imageKey);
  }
  await redisCommand('HSET', BLOG_POSTS_KEY, post.id, JSON.stringify(metadata));
  await redisCommand('ZADD', BLOG_POST_INDEX_KEY, String(post.updatedAt), post.id);
  return metadata;
}

async function normalizeBlogPhoto(dataUrl) {
  if (dataUrl === null || dataUrl === '') return null;
  if (typeof dataUrl !== 'string') throw new Error('Choose a JPG, PNG, or WebP photo.');
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) throw new Error('Choose a JPG, PNG, or WebP photo.');
  const input = Buffer.from(match[1], 'base64');
  if (!input.length || input.length > BLOG_PHOTO_LIMIT_BYTES) throw new Error('The photo must be 1 MB or smaller after upload.');
  const imageProcessor = getSharp();
  const image = imageProcessor(input, { limitInputPixels: 25_000_000 });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('Choose a JPG, PNG, or WebP photo.');
  const output = await imageProcessor(input, { limitInputPixels: 25_000_000 })
    .rotate()
    .resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  if (output.length > BLOG_PHOTO_LIMIT_BYTES) throw new Error('The optimized photo is too large. Choose a smaller image.');
  return output.toString('base64');
}

function blogStorageReady(res) {
  if (isPersistentStorageConfigured()) return true;
  res.status(503).json({ error: 'Configure Upstash Redis REST credentials to publish and manage blog posts.' });
  return false;
}

const DONATION_QR_KEY = 'boardexamtracker:donation:qr';
const DONATION_QR_META_KEY = 'boardexamtracker:donation:qr:meta';
const DONATION_QR_LIMIT_BYTES = 1_000_000;

function donationStorageReady(res) {
  if (isPersistentStorageConfigured()) return true;
  res.status(503).json({ error: 'Configure Upstash Redis REST credentials to manage donation settings.' });
  return false;
}

async function getDonationQrMeta() {
  if (!isPersistentStorageConfigured()) return { hasQr: false, updatedAt: null };
  try {
    const raw = await redisCommand('GET', DONATION_QR_META_KEY);
    if (typeof raw !== 'string' || !raw) return { hasQr: false, updatedAt: null };
    const meta = JSON.parse(raw);
    const updatedAt = Number.isFinite(meta?.updatedAt) ? meta.updatedAt : null;
    return { hasQr: Boolean(updatedAt), updatedAt };
  } catch (error) {
    console.warn('Could not read donation QR metadata:', error.message);
    return { hasQr: false, updatedAt: null };
  }
}

async function normalizeDonationQr(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) throw new Error('Choose a JPG, PNG, or WebP QR code image to upload.');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) throw new Error('Choose a JPG, PNG, or WebP QR code image.');
  const input = Buffer.from(match[2], 'base64');
  if (!input.length || input.length > DONATION_QR_LIMIT_BYTES) throw new Error('The QR code image must be 1 MB or smaller.');
  const imageProcessor = getSharp();
  const image = imageProcessor(input, { limitInputPixels: 25_000_000 });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('Choose a JPG, PNG, or WebP QR code image.');
  const output = await imageProcessor(input, { limitInputPixels: 25_000_000 })
    .rotate()
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 92 })
    .toBuffer();
  if (output.length > DONATION_QR_LIMIT_BYTES) throw new Error('The optimized QR code image is too large. Choose a smaller image.');
  return output.toString('base64');
}



const OUTFITS_KEY = 'boardexamtracker:outfits';
const OUTFIT_INDEX_KEY = 'boardexamtracker:outfits:index';
const OUTFIT_IMAGE_KEY_PREFIX = 'boardexamtracker:outfit:image:';
const OUTFIT_IMAGE_LIMIT_BYTES = 1_000_000;

function outfitStorageReady(res) {
  if (isPersistentStorageConfigured()) return true;
  res.status(503).json({ error: 'Configure Upstash Redis REST credentials to manage oath-taking outfits.' });
  return false;
}

function isValidOutfitId(id) {
  return /^[0-9a-f-]{36}$/i.test(id);
}

function sanitizeOutfitTitle(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeOutfitStatus(value) {
  return value === 'unpublished' ? 'unpublished' : 'published';
}

function normalizeAffiliateUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

async function normalizeOutfitImage(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) throw new Error('Choose a JPG, PNG, or WebP outfit image to upload.');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) throw new Error('Choose a JPG, PNG, or WebP outfit image.');
  const input = Buffer.from(match[2], 'base64');
  if (!input.length || input.length > OUTFIT_IMAGE_LIMIT_BYTES) throw new Error('The outfit image must be 1 MB or smaller.');
  const imageProcessor = getSharp();
  const image = imageProcessor(input, { limitInputPixels: 25_000_000 });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('Choose a JPG, PNG, or WebP outfit image.');
  const output = await imageProcessor(input, { limitInputPixels: 25_000_000 })
    .rotate()
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  if (output.length > OUTFIT_IMAGE_LIMIT_BYTES) throw new Error('The optimized outfit image is too large. Choose a smaller image.');
  return output.toString('base64');
}

function publicOutfit(outfit) {
  return {
    id: outfit.id,
    title: outfit.title,
    imageUrl: outfit.hasImage ? `/api/outfits/${encodeURIComponent(outfit.id)}/image?v=${outfit.updatedAt}` : null,
    updatedAt: outfit.updatedAt,
  };
}

function adminOutfit(outfit) {
  return {
    id: outfit.id,
    title: outfit.title,
    affiliateUrl: outfit.affiliateUrl || '',
    status: outfit.status === 'unpublished' ? 'unpublished' : 'published',
    imageUrl: outfit.hasImage ? `/api/outfits/${encodeURIComponent(outfit.id)}/image?v=${outfit.updatedAt}` : null,
    hasImage: Boolean(outfit.hasImage),
    createdAt: outfit.createdAt,
    updatedAt: outfit.updatedAt,
  };
}

async function getOutfitById(id) {
  if (!isPersistentStorageConfigured()) return null;
  const value = await redisCommand('HGET', OUTFITS_KEY, id);
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function listOutfits({ publishedOnly = false } = {}) {
  if (!isPersistentStorageConfigured()) return [];
  const ids = await redisCommand('ZREVRANGE', OUTFIT_INDEX_KEY, '0', '-1');
  if (!Array.isArray(ids) || !ids.length) return [];
  const values = await redisCommand('HMGET', OUTFITS_KEY, ...ids);
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    if (typeof value !== 'string') return [];
    try {
      const outfit = JSON.parse(value);
      if (publishedOnly && outfit.status !== 'published') return [];
      return [outfit];
    } catch { return []; }
  });
}

async function saveOutfit(outfit, imageData) {
  const metadata = {
    id: outfit.id,
    title: outfit.title,
    affiliateUrl: outfit.affiliateUrl,
    status: outfit.status === 'unpublished' ? 'unpublished' : 'published',
    hasImage: Boolean(outfit.hasImage),
    createdAt: outfit.createdAt,
    updatedAt: outfit.updatedAt,
  };
  const imageKey = `${OUTFIT_IMAGE_KEY_PREFIX}${outfit.id}`;
  if (imageData !== undefined) {
    if (imageData) await redisCommand('SET', imageKey, imageData);
    else await redisCommand('DEL', imageKey);
  }
  await redisCommand('HSET', OUTFITS_KEY, outfit.id, JSON.stringify(metadata));
  await redisCommand('ZADD', OUTFIT_INDEX_KEY, String(outfit.updatedAt), outfit.id);
  return metadata;
}


app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const isCronPayload = req.method === 'POST' && ['/api/cron/check-results', '/api/cron/cache-announcement-links', '/api/cron/announcement-link-backfill', '/api/cron/check-status'].includes(req.path);
  const isBlogWrite = ['POST', 'PUT'].includes(req.method) && req.path.startsWith('/api/admin/blog/posts');
  const isDonationWrite = ['POST', 'PUT', 'DELETE'].includes(req.method) && req.path.startsWith('/api/admin/donation');
  const isOutfitWrite = ['POST', 'PUT', 'DELETE'].includes(req.method) && req.path.startsWith('/api/admin/outfits');
  const isPremiumAdminWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path.startsWith('/api/admin/premium');
  const limit = isCronPayload ? '1mb' : (isBlogWrite || isDonationWrite || isOutfitWrite || isPremiumAdminWrite) ? '2mb' : '20kb';
  return express.json({
    limit,
    verify(req, _res, buf) {
      req.rawBody = buf;
    },
  })(req, res, next);
});
app.get('/sitemap.xml', async (_req, res) => {
  try {
    await restorePersistentResultCache();
    restoreBundledResultCache();
    const cached = getCache();
    let latest = cached?.results?.length ? cached : null;
    if (!latest) latest = { results: await fetchResults({ maxPage: 0 }) };
    const urls = [
      '<url><loc>https://www.boardexamtracker.com/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>',
      '<url><loc>https://www.boardexamtracker.com/latest-results</loc><changefreq>hourly</changefreq><priority>0.9</priority></url>',
      '<url><loc>https://www.boardexamtracker.com/professions</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>',
      '<url><loc>https://www.boardexamtracker.com/blog.html</loc><changefreq>daily</changefreq><priority>0.6</priority></url>',
      '<url><loc>https://www.boardexamtracker.com/privacy.html</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>',
      ...latest.results.map((item) => `<url><loc>https://www.boardexamtracker.com/results/${encodeURIComponent(new URL(item.url).pathname.split('/').filter(Boolean).pop())}</loc><lastmod>${item.date}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`),
    ];
    res.type('application/xml').set('Cache-Control', 'public, max-age=300').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
  } catch (error) {
    console.warn('Could not refresh sitemap results:', error.message);
    res.status(503).type('text/plain').send('Sitemap temporarily unavailable.');
  }
});
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (!origin || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol;
  const host = req.get('host');
  try {
    if (new URL(origin).origin !== `${protocol}://${host}`) return res.status(403).json({ error: 'Cross-origin request blocked.' });
  } catch {
    return res.status(403).json({ error: 'Invalid request origin.' });
  }
  return next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: 0,
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(html|css|js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    if (path.basename(filePath) === 'admin.html') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('X-Frame-Options', 'DENY');
    }
  },
}));
app.use('/api/admin', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  return next();
});

function adsenseConfigBase() {
  const clientId = process.env.ADSENSE_CLIENT_ID || '';
  const resultsSlot = process.env.ADSENSE_SLOT_ID_RESULTS || '';
  const validClientId = /^ca-pub-\d+$/.test(clientId);
  const validSlot = /^\d+$/.test(resultsSlot);
  return {
    configured: validClientId && validSlot && process.env.NODE_ENV === 'production',
    defaultEnabled: process.env.ADSENSE_ENABLED === 'true',
    clientId: validClientId ? clientId : null,
    resultsSlot: validSlot ? resultsSlot : null,
  };
}

async function getAdSenseConfig() {
  const base = adsenseConfigBase();
  let enabled = base.defaultEnabled;
  try {
    if (!isPersistentStorageConfigured()) enabled = false;
    else {
      const saved = await redisCommand('GET', ADSENSE_ENABLED_KEY);
      if (saved === 'true' || saved === 'false') enabled = saved === 'true';
    }
  } catch (error) {
    console.error('Could not load AdSense display setting:', error.message);
    enabled = false;
  }
  return {
    enabled: base.configured && enabled,
    configured: base.configured,
    clientId: base.clientId,
    resultsSlot: base.resultsSlot,
  };
}

app.get('/api/donation/settings', async (_req, res) => {
  const meta = await getDonationQrMeta();
  res.set('Cache-Control', 'no-store');
  return res.json({
    hasQr: meta.hasQr,
    qrImageUrl: meta.hasQr ? `/api/donation/qr?v=${meta.updatedAt || Date.now()}` : null,
    updatedAt: meta.updatedAt,
  });
});

app.get('/api/donation/qr', async (_req, res) => {
  if (!isPersistentStorageConfigured()) return res.status(404).end();
  try {
    const meta = await getDonationQrMeta();
    if (!meta.hasQr) return res.status(404).end();
    const imageData = await redisCommand('GET', DONATION_QR_KEY);
    if (typeof imageData !== 'string' || !imageData) return res.status(404).end();
    res.set({
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(Buffer.from(imageData, 'base64'));
  } catch (error) {
    console.error('Could not load donation QR code:', error.message);
    return res.status(503).end();
  }
});

app.get('/api/adsense-config', async (_req, res) => res.json(await getAdSenseConfig()));

const adminLoginAttempts = new Map();
function allowAdminLogin(req) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (adminLoginAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  if (recent.length >= 8) return false;
  recent.push(now);
  adminLoginAttempts.set(ip, recent);
  return true;
}

function requireAdmin(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: 'Admin sign-in required.' });
}

app.get('/admin', (_req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Frame-Options': 'DENY' });
  res.redirect(302, '/admin.html');
});
app.get('/blog', (_req, res) => res.redirect(302, '/blog.html'));
app.get('/latest-results', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'latest-results.html'), { headers: { 'Cache-Control': 'no-cache, must-revalidate' } }));
app.get('/professions', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'professions.html'), { headers: { 'Cache-Control': 'no-cache, must-revalidate' } }));
app.get('/api/admin/session', (_req, res) => {
  const config = adminConfig();
  res.json({ configured: config.configured, authenticated: config.configured && isAuthenticated(_req) });
});
app.get('/api/admin/donation', requireAdmin, async (_req, res) => {
  if (!isPersistentStorageConfigured()) {
    return res.json({ hasQr: false, updatedAt: null, qrImageUrl: null, persistentStorage: false });
  }
  try {
    const meta = await getDonationQrMeta();
    return res.json({
      hasQr: meta.hasQr,
      updatedAt: meta.updatedAt,
      qrImageUrl: meta.hasQr ? `/api/donation/qr?v=${meta.updatedAt || Date.now()}` : null,
      persistentStorage: true,
    });
  } catch (error) {
    console.error('Could not load donation settings:', error.message);
    return res.status(503).json({ error: 'Could not load donation settings. Check shared storage and try again.' });
  }
});

app.post('/api/admin/donation/qr', requireAdmin, async (req, res) => {
  if (!donationStorageReady(res)) return;
  let imageData;
  try {
    imageData = await normalizeDonationQr(req.body?.image);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const updatedAt = Date.now();
  try {
    await redisCommand('SET', DONATION_QR_KEY, imageData);
    await redisCommand('SET', DONATION_QR_META_KEY, JSON.stringify({ updatedAt }));
    return res.json({ hasQr: true, updatedAt, qrImageUrl: `/api/donation/qr?v=${updatedAt}` });
  } catch (error) {
    console.error('Could not save donation QR code:', error.message);
    return res.status(503).json({ error: 'The QR code could not be saved. Check shared storage and try again.' });
  }
});

app.delete('/api/admin/donation/qr', requireAdmin, async (req, res) => {
  if (!donationStorageReady(res)) return;
  try {
    await redisCommand('DEL', DONATION_QR_KEY);
    await redisCommand('DEL', DONATION_QR_META_KEY);
    return res.json({ hasQr: false, updatedAt: null, qrImageUrl: null });
  } catch (error) {
    console.error('Could not remove donation QR code:', error.message);
    return res.status(503).json({ error: 'The QR code could not be removed. Check shared storage and try again.' });
  }
});

app.get('/api/admin/ads', requireAdmin, async (_req, res) => {
  const config = await getAdSenseConfig();
  return res.json({
    enabled: config.enabled,
    configured: config.configured,
    persistentStorage: isPersistentStorageConfigured(),
    production: process.env.NODE_ENV === 'production',
  });
});
app.post('/api/admin/ads', requireAdmin, async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Choose whether ads should be on or off.' });
  const base = adsenseConfigBase();
  if (req.body.enabled && !base.configured) {
    return res.status(503).json({ error: 'Ads cannot be turned on until the AdSense publisher ID and display ad slot ID are configured for production.' });
  }
  if (!isPersistentStorageConfigured()) {
    return res.status(503).json({ error: 'Configure Upstash Redis REST credentials to save the ads setting.' });
  }
  try {
    await redisCommand('SET', ADSENSE_ENABLED_KEY, String(req.body.enabled));
  } catch (error) {
    console.error('Could not save AdSense display setting:', error.message);
    return res.status(503).json({ error: 'Could not save the ads setting. Check the Upstash Redis REST connection and try again.' });
  }
  return res.json({ enabled: req.body.enabled });
});
app.post('/api/admin/login', (req, res) => {
  if (!adminConfig().configured) return res.status(503).json({ error: 'Admin access is not configured on this server. Add ADMIN_USERNAME, ADMIN_PASSWORD, and a 32-character ADMIN_SESSION_SECRET.' });
  if (!allowAdminLogin(req)) return res.status(429).json({ error: 'Too many sign-in attempts. Wait 15 minutes before trying again.' });
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (username.length > 120 || password.length > 1024 || !authenticate(username, password)) {
    return res.status(401).json({ error: 'Username or password is incorrect.' });
  }
  setSessionCookie(res, req, createSession(username, adminConfig().secret));
  return res.json({ authenticated: true });
});
app.post('/api/admin/logout', (req, res) => {
  clearSessionCookie(res, req);
  return res.json({ authenticated: false });
});
app.get('/api/admin/subscribers', requireAdmin, async (_req, res) => {
  try {
    await expireDueSubscriptions().catch(() => {});
    const subscribers = await buildAdminSubscriberView();
    const mapped = subscribers.map((s) => ({
      email: s.email,
      fullName: s.fullName,
      status: s.status === 'active' ? 'confirmed' : s.status,
      subscriptionStatus: s.status,
      subscribedAt: s.createdAt,
      confirmedAt: s.emailVerified ? s.createdAt : null,
      startDate: s.startDate,
      expirationDate: s.expirationDate,
      paymentMethod: s.paymentMethod,
      amountPaid: s.amountPaid,
      paymentStatus: s.paymentStatus,
      userId: s.userId,
      adminNotes: s.adminNotes,
    }));
    return res.json({ subscribers: mapped, persistentStorage: isPersistentStorageConfigured(), production: process.env.NODE_ENV === 'production', premium: true });
  } catch (error) {
    console.error('Could not load admin subscriber list:', error.message);
    return res.status(503).json({ error: 'Subscriber storage is unavailable. Check the private storage settings.' });
  }
});
app.get('/api/outfits', async (_req, res) => {
  try {
    const outfits = (await listOutfits({ publishedOnly: true })).map(publicOutfit);
    return res.json({ outfits });
  } catch (error) {
    console.error('Could not load oath-taking outfits:', error.message);
    return res.status(503).json({ error: 'Oath-taking outfits are temporarily unavailable.' });
  }
});

app.get('/api/outfits/:id/image', async (req, res) => {
  const { id } = req.params;
  if (!isValidOutfitId(id)) return res.status(404).end();
  try {
    const outfit = await getOutfitById(id);
    if (!outfit?.hasImage) return res.status(404).end();
    if (outfit.status !== 'published' && !isAuthenticated(req)) return res.status(404).end();
    const imageData = await redisCommand('GET', `${OUTFIT_IMAGE_KEY_PREFIX}${id}`);
    if (typeof imageData !== 'string' || !imageData) return res.status(404).end();
    res.set({
      'Content-Type': 'image/webp',
      'Cache-Control': outfit.status === 'published' ? 'public, max-age=300, stale-while-revalidate=3600' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(Buffer.from(imageData, 'base64'));
  } catch (error) {
    console.error('Could not load outfit image:', error.message);
    return res.status(503).end();
  }
});

app.get('/api/outfits/:id/open', async (req, res) => {
  const { id } = req.params;
  if (!isValidOutfitId(id)) return res.status(404).type('text/plain').send('Outfit not found.');
  try {
    const outfit = await getOutfitById(id);
    if (!outfit || outfit.status !== 'published') return res.status(404).type('text/plain').send('Outfit not found.');
    const affiliateUrl = normalizeAffiliateUrl(outfit.affiliateUrl);
    if (!affiliateUrl) return res.status(404).type('text/plain').send('Outfit link unavailable.');
    return res.redirect(302, affiliateUrl);
  } catch (error) {
    console.error('Could not open outfit link:', error.message);
    return res.status(503).type('text/plain').send('Outfit link temporarily unavailable.');
  }
});

app.get('/api/blog/posts', async (req, res) => {
  const requestedOffset = Number.parseInt(req.query.offset, 10);
  const offset = Number.isInteger(requestedOffset) && requestedOffset > 0 ? Math.min(requestedOffset, 10_000) : 0;
  try {
    const posts = await listBlogPosts(offset, 11);
    return res.json({ posts: posts.slice(0, 10), hasMore: posts.length > 10 });
  } catch (error) {
    console.error('Could not load blog posts:', error.message);
    return res.status(503).json({ error: 'Blog posts are temporarily unavailable.' });
  }
});
app.get('/api/blog/posts/:id/image', async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).end();
  try {
    let imageData;
    if (isPersistentStorageConfigured()) imageData = await redisCommand('GET', `${BLOG_POST_IMAGE_KEY_PREFIX}${id}`);
    if (typeof imageData !== 'string' || !imageData) return res.status(404).end();
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    return res.send(Buffer.from(imageData, 'base64'));
  } catch (error) {
    console.error('Could not load blog photo:', error.message);
    return res.status(503).end();
  }
});
app.get('/api/admin/blog/posts', requireAdmin, async (_req, res) => {
  if (!blogStorageReady(res)) return;
  try {
    return res.json({ posts: await listBlogPosts(0, BLOG_POST_LIMIT) });
  } catch (error) {
    console.error('Could not load posts for admin:', error.message);
    return res.status(503).json({ error: 'Blog posts could not be loaded. Check shared storage and try again.' });
  }
});
app.post('/api/admin/blog/posts', requireAdmin, async (req, res) => {
  if (!blogStorageReady(res)) return;
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!title || title.length > 180) return res.status(400).json({ error: 'Add a title between 1 and 180 characters.' });
  if (!body || body.length > 16_000) return res.status(400).json({ error: 'Add post text between 1 and 16,000 characters.' });
  let imageData;
  try {
    imageData = await normalizeBlogPhoto(req.body?.image ?? null);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const posts = await listBlogPosts(0, BLOG_POST_LIMIT);
    if (posts.length >= BLOG_POST_LIMIT) return res.status(409).json({ error: `The blog can store up to ${BLOG_POST_LIMIT} posts. Delete an older post before adding another.` });
    const now = Date.now();
    const post = { id: randomUUID(), title, body, hasImage: Boolean(imageData), createdAt: now, updatedAt: now };
    const saved = await saveBlogPost(post, imageData);
    return res.status(201).json({ post: publicBlogPost(saved) });
  } catch (error) {
    console.error('Could not create blog post:', error.message);
    return res.status(503).json({ error: 'The post could not be saved. Check shared storage and try again.' });
  }
});
app.put('/api/admin/blog/posts/:id', requireAdmin, async (req, res) => {
  if (!blogStorageReady(res)) return;
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ error: 'Post not found.' });
  try {
    const existing = await getBlogPostById(id);
    if (!existing) return res.status(404).json({ error: 'Post not found.' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!title || title.length > 180) return res.status(400).json({ error: 'Add a title between 1 and 180 characters.' });
    if (!body || body.length > 16_000) return res.status(400).json({ error: 'Add post text between 1 and 16,000 characters.' });
    let imageData;
    if (Object.hasOwn(req.body || {}, 'image')) {
      try { imageData = await normalizeBlogPhoto(req.body.image); }
      catch (error) { return res.status(400).json({ error: error.message }); }
    }
    const post = {
      id,
      title,
      body,
      hasImage: imageData === undefined ? Boolean(existing.hasImage) : Boolean(imageData),
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    const saved = await saveBlogPost(post, imageData);
    return res.json({ post: publicBlogPost(saved) });
  } catch (error) {
    console.error('Could not update blog post:', error.message);
    return res.status(503).json({ error: 'The post could not be updated. Check shared storage and try again.' });
  }
});
app.delete('/api/admin/blog/posts/:id', requireAdmin, async (req, res) => {
  if (!blogStorageReady(res)) return;
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ error: 'Post not found.' });
  try {
    const existing = await getBlogPostById(id);
    if (!existing) return res.status(404).json({ error: 'Post not found.' });
    await redisCommand('HDEL', BLOG_POSTS_KEY, id);
    await redisCommand('ZREM', BLOG_POST_INDEX_KEY, id);
    await redisCommand('DEL', `${BLOG_POST_IMAGE_KEY_PREFIX}${id}`);
    return res.json({ deleted: true });
  } catch (error) {
    console.error('Could not delete blog post:', error.message);
    return res.status(503).json({ error: 'The post could not be deleted. Check shared storage and try again.' });
  }
});

app.get('/api/admin/outfits', requireAdmin, async (_req, res) => {
  if (!isPersistentStorageConfigured()) {
    return res.json({ outfits: [], persistentStorage: false });
  }
  try {
    const outfits = (await listOutfits()).map(adminOutfit);
    return res.json({ outfits, persistentStorage: true });
  } catch (error) {
    console.error('Could not load outfits for admin:', error.message);
    return res.status(503).json({ error: 'Outfit listings could not be loaded. Check shared storage and try again.' });
  }
});

app.post('/api/admin/outfits', requireAdmin, async (req, res) => {
  if (!outfitStorageReady(res)) return;
  const title = sanitizeOutfitTitle(req.body?.title);
  const affiliateUrl = normalizeAffiliateUrl(req.body?.affiliateUrl);
  const status = normalizeOutfitStatus(req.body?.status);
  if (!title || title.length > 180) return res.status(400).json({ error: 'Add an outfit title between 1 and 180 characters.' });
  if (!affiliateUrl) return res.status(400).json({ error: 'Enter a valid affiliate purchase link starting with http:// or https://.' });
  let imageData;
  try {
    imageData = await normalizeOutfitImage(req.body?.image);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const now = Date.now();
    const outfit = { id: randomUUID(), title, affiliateUrl, status, hasImage: true, createdAt: now, updatedAt: now };
    const saved = await saveOutfit(outfit, imageData);
    return res.status(201).json({ outfit: adminOutfit(saved) });
  } catch (error) {
    console.error('Could not create outfit:', error.message);
    return res.status(503).json({ error: 'The outfit could not be saved. Check shared storage and try again.' });
  }
});

app.put('/api/admin/outfits/:id', requireAdmin, async (req, res) => {
  if (!outfitStorageReady(res)) return;
  const { id } = req.params;
  if (!isValidOutfitId(id)) return res.status(404).json({ error: 'Outfit not found.' });
  try {
    const existing = await getOutfitById(id);
    if (!existing) return res.status(404).json({ error: 'Outfit not found.' });
    const title = sanitizeOutfitTitle(req.body?.title);
    const affiliateUrl = normalizeAffiliateUrl(req.body?.affiliateUrl);
    const status = normalizeOutfitStatus(req.body?.status);
    if (!title || title.length > 180) return res.status(400).json({ error: 'Add an outfit title between 1 and 180 characters.' });
    if (!affiliateUrl) return res.status(400).json({ error: 'Enter a valid affiliate purchase link starting with http:// or https://.' });

    let imageData;
    if (Object.hasOwn(req.body || {}, 'image')) {
      if (req.body.image === null || req.body.image === '') {
        return res.status(400).json({ error: 'Upload an outfit image to replace the current one.' });
      }
      try { imageData = await normalizeOutfitImage(req.body.image); }
      catch (error) { return res.status(400).json({ error: error.message }); }
    }
    if (!existing.hasImage && imageData === undefined) {
      return res.status(400).json({ error: 'Upload an outfit image before saving.' });
    }

    const outfit = {
      id,
      title,
      affiliateUrl,
      status,
      hasImage: imageData === undefined ? Boolean(existing.hasImage) : true,
      createdAt: existing.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    const saved = await saveOutfit(outfit, imageData);
    return res.json({ outfit: adminOutfit(saved) });
  } catch (error) {
    console.error('Could not update outfit:', error.message);
    return res.status(503).json({ error: 'The outfit could not be updated. Check shared storage and try again.' });
  }
});

app.delete('/api/admin/outfits/:id', requireAdmin, async (req, res) => {
  if (!outfitStorageReady(res)) return;
  const { id } = req.params;
  if (!isValidOutfitId(id)) return res.status(404).json({ error: 'Outfit not found.' });
  try {
    const existing = await getOutfitById(id);
    if (!existing) return res.status(404).json({ error: 'Outfit not found.' });
    await redisCommand('HDEL', OUTFITS_KEY, id);
    await redisCommand('ZREM', OUTFIT_INDEX_KEY, id);
    await redisCommand('DEL', `${OUTFIT_IMAGE_KEY_PREFIX}${id}`);
    return res.json({ deleted: true });
  } catch (error) {
    console.error('Could not delete outfit:', error.message);
    return res.status(503).json({ error: 'The outfit could not be deleted. Check shared storage and try again.' });
  }
});

async function getLatestAvailableResult() {
  const snapshot = await refresh();
  const latest = snapshot?.results
    ?.filter((result) => result?.title && result?.date && normalizeUrl(result.url))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const officialUrl = latest && normalizeUrl(latest.url);
  if (!latest || !officialUrl || !['www.prc.gov.ph', 'prc.gov.ph'].includes(new URL(officialUrl).hostname)) return null;
  return latest;
}

function emailProviderFailureMessage(error) {
  const status = /^Email provider returned (\d{3}):/.exec(error?.message || '')?.[1];
  return status
    ? `Email provider rejected this message (HTTP ${status}). Check Resend → Emails for the delivery details.`
    : 'Could not reach or send through the email provider. Check Resend → Emails for details, then try again.';
}

const adminResultEmailAttempts = new Map();
app.post('/api/admin/send-latest-result', requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!isEmailConfigured()) return res.status(503).json({ error: 'Email sending is not configured.' });

  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (adminResultEmailAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 60 * 60 * 1000);
  if (recent.length >= 5) return res.status(429).json({ error: 'Send limit reached. Try again later.' });
  recent.push(now);
  adminResultEmailAttempts.set(ip, recent);

  let latest;
  try {
    latest = await getLatestAvailableResult();
  } catch (error) {
    console.error('Could not load a result for the admin alert:', error.message);
    return res.status(503).json({ error: 'Could not load the latest result from PRC or the saved result snapshot. Try again later.' });
  }
  if (!latest) return res.status(503).json({ error: 'No current result announcement is available to send.' });

  try {
    await expireDueSubscriptions().catch(() => {});
    const sub = await getSubscriptionByEmail(email);
    if (!sub || effectiveStatus(sub) !== 'active') {
      return res.status(403).json({ error: 'Email alerts can only be sent to active Premium subscribers.' });
    }
    await sendPremiumAlertToSubscriber(sub, [latest], { actor: req.admin?.username || 'admin', reason: 'admin_send_latest' });
    return res.json({ sent: true, title: latest.title });
  } catch (error) {
    console.error('Email provider failed to send latest-result alert:', error.message);
    return res.status(502).json({ error: emailProviderFailureMessage(error) });
  }
});
const adminResendAttempts = new Map();
app.post('/api/admin/subscribers/resend-alert', requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid subscriber email.' });
  }
  if (!isEmailConfigured()) return res.status(503).json({ error: 'Email sending is not configured.' });
  if (!isPersistentStorageConfigured()) {
    return res.status(503).json({ error: 'Configure Upstash Redis REST credentials to resend alerts.' });
  }

  try {
    await expireDueSubscriptions().catch(() => {});
    const sub = await getSubscriptionByEmail(email);
    if (!sub || effectiveStatus(sub) !== 'active') {
      return res.status(404).json({ error: 'No active Premium subscriber was found for this email.' });
    }

    const lastSentAt = adminResendAttempts.get(email) || 0;
    if (Date.now() - lastSentAt < 60_000) {
      return res.status(429).json({ error: 'An alert was just sent to this subscriber. Wait one minute before resending.' });
    }

    const latest = await getLatestAvailableResult();
    if (!latest) return res.status(503).json({ error: 'No current result announcement with a valid official source is available to send.' });

    await sendPremiumAlertToSubscriber(sub, [latest], { actor: req.admin?.username || 'admin', reason: 'admin_resend_latest', resend: true });
    adminResendAttempts.set(email, Date.now());
    return res.json({ sent: true, title: latest.title });
  } catch (error) {
    console.error('Could not prepare latest-result resend:', error.message);
    return res.status(503).json({ error: 'Could not load the latest result from PRC or the saved result snapshot. Try again later.' });
  }
});
app.post('/api/admin/subscribers/unsubscribe', requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid subscriber email.' });
  }
  if (!isPersistentStorageConfigured()) {
    return res.status(503).json({ error: 'Configure Upstash Redis REST credentials for subscriber management.' });
  }
  try {
    const sub = await getSubscriptionByEmail(email);
    if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
    await cancelSubscription(email, req.admin?.username || 'admin', 'Cancelled by admin from dashboard');
    return res.json({ removed: true, cancelled: true });
  } catch (error) {
    console.error('Could not manually cancel subscriber:', error.message);
    return res.status(503).json({ error: 'Subscriber storage is unavailable. Try again later.' });
  }
});
app.get('/api/admin/viewers', requireAdmin, async (_req, res) => {
  try {
    return res.json({ ...await getActiveViewerCount(), production: process.env.NODE_ENV === 'production' });
  } catch (error) {
    console.error('Could not load active viewer count:', error.message);
    return res.status(503).json({ error: 'Shared viewer storage is unavailable.' });
  }
});
const viewerHeartbeatAttempts = new Map();
function allowViewerHeartbeat(req) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (viewerHeartbeatAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 60 * 1000);
  if (recent.length >= 120) return false;
  recent.push(now);
  viewerHeartbeatAttempts.set(ip, recent);
  return true;
}
app.post('/api/viewers/heartbeat', async (req, res) => {
  if (!allowViewerHeartbeat(req)) return res.status(429).json({ error: 'Viewer check limit reached.' });
  try {
    const count = await recordViewerHeartbeat(req.body?.id);
    return res.json({ ok: true, ...count });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Could not record viewer.' });
  }
});

function requirePremiumUser(req, res, next) {
  const session = premiumAuth.getSession(req);
  if (!session) return res.status(401).json({ error: 'Sign in required.' });
  req.premiumSession = session;
  return next();
}

function sanitizeAdminNotes(value) {
  return typeof value === 'string' ? value.trim().slice(0, 2000) : '';
}

function parsePositiveInt(value, fallback = 1) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function buildAdminSubscriberView() {
  await expireDueSubscriptions().catch(() => {});
  const [subs, payments, users] = await Promise.all([listSubscriptions(), listAllPayments(2000), (async () => {
    const raw = await redisCommand('HGETALL', 'boardexamtracker:premium:users');
    const values = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.entries(raw).flat() : [];
    const out = [];
    for (let i = 0; i + 1 < values.length; i += 2) { try { out.push(JSON.parse(values[i + 1])); } catch {} }
    return out;
  })()]);
  const usersById = new Map(users.map((u) => [u.id, u]));
  const paymentsByEmail = new Map();
  for (const p of payments) {
    const email = normalizeEmail(p.email);
    if (!paymentsByEmail.has(email)) paymentsByEmail.set(email, []);
    paymentsByEmail.get(email).push(p);
  }
  return subs.map((sub) => {
    const email = normalizeEmail(sub.email);
    const user = sub.userId ? usersById.get(sub.userId) : users.find((u) => normalizeEmail(u.email) === email);
    const subPayments = (paymentsByEmail.get(email) || []).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const lastPayment = subPayments[0] || null;
    return {
      id: sub.id || email,
      fullName: sub.fullName || user?.fullName || '',
      email,
      alertEmail: sub.alertEmail || email,
      userId: sub.userId || user?.id || null,
      hasAccount: Boolean(sub.userId || user),
      status: effectiveStatus(sub),
      rawStatus: sub.status || 'expired',
      startDate: sub.startDate || null,
      expirationDate: sub.expirationDate || null,
      amountPaid: lastPayment ? Number(lastPayment.amount) || 0 : 0,
      paymentMethod: lastPayment?.method || sub.lastPaymentMethod || '',
      paymentReference: lastPayment?.reference || '',
      paymentStatus: lastPayment?.status || '',
      adminNotes: sub.adminNotes || '',
      complimentary: Boolean(sub.complimentary),
      cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
      emailVerified: Boolean(sub.emailVerifiedAt || user?.emailVerifiedAt),
      createdAt: sub.createdAt || null,
      updatedAt: sub.updatedAt || null,
      paymentHistory: subPayments.slice(0, 20),
    };
  }).sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

app.get('/account', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'account.html'), { headers: { 'Cache-Control': 'no-cache, must-revalidate' } });
});

app.get('/api/premium/config', async (_req, res) => {
  try {
    const config = await getConfig();
    const ganap = ganapConfig();
    res.json({
      planName: config.planName,
      monthlyPrice: config.monthlyPrice,
      ganap: { enabled: Boolean(config.ganapEnabled && ganap.configured), configured: ganap.configured, minimumAmount: 200 },
      alternativeMethods: config.alternativeMethods,
      prepaidOptions: config.prepaidOptions,
      currency: 'PHP',
    });
  } catch (error) {
    res.status(503).json({ error: 'Could not load subscription options.' });
  }
});

async function sendPremiumVerificationEmail(user) {
  if (!isEmailConfigured()) throw new Error('Email delivery is not configured.');
  const token = premiumAuth.makeToken();
  user.emailVerificationToken = token;
  user.emailVerificationExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
  await saveUser(user);
  const baseUrl = publicBaseUrl();
  const verifyUrl = `${baseUrl}/api/premium/verify-email?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: user.email,
    subject: 'Verify your BoardExamTracker account',
    html: `<div style="font-family:Arial,sans-serif;color:#172b46;line-height:1.6"><h1 style="font-size:22px">Verify your email address</h1><p>Confirm your email address to activate your BoardExamTracker account and manage your Premium Email Alerts subscription.</p><p><a href="${escapeEmailHtml(verifyUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#2563a9;color:white;text-decoration:none;font-weight:bold">Verify email address</a></p><p>If you did not create this account, you can ignore this email.</p></div>`,
    text: `Verify your BoardExamTracker account: ${verifyUrl}`,
  });
}

app.post('/api/premium/register', async (req, res) => {
  try {
    if (!premiumAuth.isConfigured()) return res.status(503).json({ error: 'Subscriber accounts are not configured on this server yet.' });
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const fullName = String(req.body?.fullName || '').trim().slice(0, 120);
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    const passwordHash = premiumAuth.hashPassword(password);
    const { user } = await createOrGetUser({ email, fullName, passwordHash });
    user.passwordHash = passwordHash;
    user.fullName = fullName || user.fullName;
    user.emailVerifiedAt = null;
    await saveUser(user);
    await sendPremiumVerificationEmail(user);
    await addAuditLog({ action: 'subscriber_registered_pending_verification', actor: email, email, details: { userId: user.id } });
    return res.json({ ok: true, requiresVerification: true, message: 'Check your email to verify your account before signing in.' });
  } catch (error) {
    console.error('Premium register failed:', error.message);
    return res.status(500).json({ error: error.message || 'Could not create account.' });
  }
});

async function completePremiumEmailVerification(req, res) {
  const token = String(req.query.token || req.body?.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return emailResultPage(res, 'Invalid link', 'This email verification link is not valid.', false);
  try {
    const rawUsers = await redisCommand('HGETALL', 'boardexamtracker:premium:users');
    const values = Array.isArray(rawUsers) ? rawUsers : rawUsers && typeof rawUsers === 'object' ? Object.entries(rawUsers).flat() : [];
    let user = null;
    for (let i = 0; i + 1 < values.length; i += 2) {
      try { const u = JSON.parse(values[i + 1]); if (u?.emailVerificationToken === token) { user = u; break; } } catch {}
    }
    if (!user || !user.emailVerificationExpiresAt || Date.now() > Number(user.emailVerificationExpiresAt)) {
      return emailResultPage(res, 'Link expired', 'This verification link is invalid or expired. Please register or request a new verification email.', false);
    }
    user.emailVerifiedAt = new Date().toISOString();
    user.emailVerificationToken = null;
    user.emailVerificationExpiresAt = null;
    await saveUser(user);
    const email = normalizeEmail(user.email);
    let sub = await getSubscriptionByEmail(email);
    if (sub) {
      if (sub.userId && sub.userId !== user.id) {
        return emailResultPage(res, 'Account conflict', 'This subscription is already linked to another account. Please contact support.', false);
      }
      sub.userId = user.id;
      sub.fullName = user.fullName || sub.fullName;
      sub.emailVerifiedAt = user.emailVerifiedAt;
      if (!sub.alertEmail) sub.alertEmail = email;
      await saveSubscription(sub);
      await addAuditLog({ action: 'subscriber_account_linked', actor: email, email, details: { userId: user.id, subscriptionStatus: effectiveStatus(sub) } });
    } else {
      sub = await ensureSubscription(email, { fullName: user.fullName, userId: user.id, emailVerifiedAt: user.emailVerifiedAt });
    }
    await addAuditLog({ action: 'subscriber_email_verified', actor: email, email, details: { userId: user.id } });
    return emailResultPage(res, 'Email verified', 'Your email is verified and your account is ready. You can now sign in to manage your Premium Email Alerts subscription.', true);
  } catch (error) {
    console.error('Premium email verification failed:', error.message);
    return emailResultPage(res, 'Verification failed', 'We could not verify your email address. Please try again.', false);
  }
}

app.get('/api/premium/verify-email', async (req, res) => {
  const token = String(req.query.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return completePremiumEmailVerification(req, res);
  return res.type('html').send(emailActionPage('Verify your email', 'Confirm your email address to activate your BoardExamTracker account.', escapeHtml(token), '/api/premium/verify-email/confirm', 'Verify email address'));
});
app.post('/api/premium/verify-email/confirm', express.urlencoded({ extended: false, limit: '2kb' }), completePremiumEmailVerification);

app.post('/api/premium/forgot-password', async (req, res) => {
  try {
    if (!premiumAuth.isConfigured()) return res.status(503).json({ error: 'Subscriber accounts are not configured on this server yet.' });
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const user = await getUserByEmail(email);
    if (user && isEmailConfigured()) {
      const token = premiumAuth.makeToken();
      user.passwordResetToken = token;
      user.passwordResetExpiresAt = Date.now() + 60 * 60 * 1000;
      await saveUser(user);
      const baseUrl = publicBaseUrl();
      const resetUrl = `${baseUrl}/account?reset=${encodeURIComponent(token)}`;
      await sendEmail({
        to: email,
        subject: 'Reset your BoardExamTracker password',
        html: `<div style="font-family:Arial,sans-serif;color:#172b46;line-height:1.6"><h1 style="font-size:22px">Reset your password</h1><p>Use the link below to reset your BoardExamTracker account password. This link expires in 1 hour.</p><p><a href="${escapeEmailHtml(resetUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#2563a9;color:white;text-decoration:none;font-weight:bold">Reset password</a></p><p>If you did not request this, you can ignore this email.</p></div>`,
        text: `Reset your BoardExamTracker password: ${resetUrl}`,
      });
      await addAuditLog({ action: 'subscriber_password_reset_requested', actor: email, email, details: { userId: user.id } });
    }
    return res.json({ ok: true, message: 'If an account exists for that email, a password reset link has been sent.' });
  } catch (error) {
    console.error('Forgot password failed:', error.message);
    return res.status(500).json({ error: 'Could not process password reset request.' });
  }
});

app.post('/api/premium/reset-password', async (req, res) => {
  try {
    const token = String(req.body?.token || '');
    const password = String(req.body?.password || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'Invalid or expired reset link.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const rawUsers = await redisCommand('HGETALL', 'boardexamtracker:premium:users');
    const values = Array.isArray(rawUsers) ? rawUsers : rawUsers && typeof rawUsers === 'object' ? Object.entries(rawUsers).flat() : [];
    let user = null;
    for (let i = 0; i + 1 < values.length; i += 2) {
      try { const u = JSON.parse(values[i + 1]); if (u?.passwordResetToken === token) { user = u; break; } } catch {}
    }
    if (!user || !user.passwordResetExpiresAt || Date.now() > Number(user.passwordResetExpiresAt)) {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }
    user.passwordHash = premiumAuth.hashPassword(password);
    user.passwordResetToken = null;
    user.passwordResetExpiresAt = null;
    await saveUser(user);
    await addAuditLog({ action: 'subscriber_password_reset', actor: user.email, email: normalizeEmail(user.email), details: { userId: user.id } });
    return res.json({ ok: true, message: 'Password updated. You can now sign in.' });
  } catch (error) {
    console.error('Reset password failed:', error.message);
    return res.status(500).json({ error: 'Could not reset password.' });
  }
});

app.post('/api/premium/login', async (req, res) => {
  try {
    if (!premiumAuth.isConfigured()) return res.status(503).json({ error: 'Subscriber accounts are not configured on this server yet.' });
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!isValidEmail(email) || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const user = await getUserByEmail(email);
    if (!user || !user.passwordHash || !premiumAuth.verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!user.emailVerifiedAt) {
      return res.status(403).json({ error: 'Please verify your email address before signing in. Check your inbox for the verification email.', requiresVerification: true });
    }
    const token = premiumAuth.createSession(user.id, user.email);
    premiumAuth.setSessionCookie(res, req, token);
    await addAuditLog({ action: 'subscriber_login', actor: email, email, details: { userId: user.id } });
    return res.json({ ok: true, user: { id: user.id, email: user.email, fullName: user.fullName || '' } });
  } catch (error) {
    console.error('Premium login failed:', error.message);
    return res.status(500).json({ error: 'Could not sign in.' });
  }
});

app.post('/api/premium/logout', (req, res) => {
  premiumAuth.clearSessionCookie(res, req);
  res.json({ ok: true });
});

app.get('/api/premium/me', requirePremiumUser, async (req, res) => {
  try {
    const user = await getUserById(req.premiumSession.sub);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    await expireDueSubscriptions().catch(() => {});
    let sub = await getSubscriptionByEmail(user.email);
    if (!sub) sub = await ensureSubscription(user.email, { fullName: user.fullName, userId: user.id, emailVerifiedAt: user.emailVerifiedAt });
    if (!sub.userId) { sub.userId = user.id; await saveSubscription(sub); }
    const payments = await listPaymentsByEmail(user.email);
    res.json({
      user: { id: user.id, email: user.email, fullName: user.fullName || '', emailVerifiedAt: user.emailVerifiedAt || null },
      subscription: publicSubscription(sub, user),
      payments: payments.slice(0, 50).map((p) => ({ id: p.id, amount: p.amount, currency: p.currency || 'PHP', method: p.method, reference: p.reference, status: p.status, months: p.months, createdAt: p.createdAt, paidAt: p.paidAt || null })),
      config: await getConfig(),
      ganap: { configured: ganapConfig().configured },
    });
  } catch (error) {
    console.error('Premium me failed:', error.message);
    res.status(500).json({ error: 'Could not load account.' });
  }
});

app.post('/api/premium/checkout', requirePremiumUser, async (req, res) => {
  try {
    const user = await getUserById(req.premiumSession.sub);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    const months = Number(req.body?.months);
    const method = String(req.body?.method || 'Ganap').trim();
    const fullName = String(req.body?.fullName || user.fullName || '').trim().slice(0, 120);
    const result = await createPremiumCheckout({ email: user.email, fullName, userId: user.id, months, method });
    if (result.manual) {
      return res.json({
        ok: true,
        manual: true,
        payment: { id: result.payment.id, status: result.payment.status, amount: result.payment.amount, months: result.payment.months, method: result.payment.method },
        message: `Your ${result.prepaid.label} request was recorded as pending. An admin can confirm this ${result.payment.method} payment after it is received.`,
      });
    }
    const redirectUrl = result.checkout?.redirectUrl;
    let redirectType = 'url';
    if (typeof redirectUrl === 'string') {
      if (redirectUrl.startsWith('data:image') || /\.(png|jpg|jpeg|webp|gif)(\?|$)/i.test(redirectUrl)) redirectType = 'image';
      else if (/^https?:\/\//i.test(redirectUrl)) redirectType = 'url';
      else redirectType = 'qr_payload';
    }
    return res.json({
      ok: true,
      payment: { id: result.payment.id, status: result.payment.status, amount: result.payment.amount, months: result.payment.months, method: result.payment.method },
      checkout: { redirectUrl, redirectType, referenceNumber: result.checkout?.referenceNumber || '' },
      prepaid: result.prepaid,
    });
  } catch (error) {
    console.error('Premium checkout failed:', error.message);
    return res.status(400).json({ error: error.message || 'Could not start checkout.' });
  }
});

async function ganapWebhookHandler(req, res) {
  try {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    const result = await handleGanapCallback(req.body, rawBody, req.get('X-Ganap-Signature'));
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error || 'Webhook rejected.' });
    return res.status(200).json({ ok: true, ignored: Boolean(result.ignored), duplicate: Boolean(result.duplicate), activated: Boolean(result.activated) });
  } catch (error) {
    console.error('Ganap webhook failed:', error.message);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
}

app.post('/api/premium/ganap/webhook', ganapWebhookHandler);
app.post('/api/webhooks/ganap', ganapWebhookHandler);

app.post('/api/premium/cancel', requirePremiumUser, async (req, res) => {
  try {
    const user = await getUserById(req.premiumSession.sub);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    const sub = await getSubscriptionByEmail(user.email);
    if (!sub) return res.status(404).json({ error: 'No subscription found.' });
    await cancelSubscription(user.email, user.email, 'Cancelled by subscriber from dashboard');
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Could not cancel subscription.' });
  }
});

app.post('/api/premium/alerts', requirePremiumUser, async (req, res) => {
  try {
    const user = await getUserById(req.premiumSession.sub);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    const sub = await getSubscriptionByEmail(user.email);
    if (!sub) return res.status(404).json({ error: 'No subscription found.' });
    sub.alertsPaused = Boolean(req.body?.paused);
    sub.updatedAt = new Date().toISOString();
    await saveSubscription(sub);
    await addAuditLog({ action: sub.alertsPaused ? 'subscriber_alerts_paused' : 'subscriber_alerts_resumed', actor: user.email, email: user.email, details: { alertsPaused: sub.alertsPaused } });
    return res.json({ ok: true, alertsPaused: sub.alertsPaused });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Could not update email alert setting.' });
  }
});

app.post('/api/premium/email-change/request', requirePremiumUser, async (req, res) => {
  try {
    const user = await getUserById(req.premiumSession.sub);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    const newEmail = normalizeEmail(req.body?.newEmail);
    if (!isValidEmail(newEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (newEmail === normalizeEmail(user.email)) return res.status(400).json({ error: 'That is already your email address.' });
    const existing = await getUserByEmail(newEmail);
    if (existing) return res.status(409).json({ error: 'That email address is already in use.' });
    if (!isEmailConfigured()) return res.status(503).json({ error: 'Email delivery is not configured.' });
    const token = premiumAuth.makeToken();
    user.pendingEmail = newEmail;
    user.pendingEmailToken = token;
    user.pendingEmailExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    await saveUser(user);
    const baseUrl = publicBaseUrl();
    const confirmUrl = `${baseUrl}/api/premium/email-change/confirm?token=${encodeURIComponent(token)}`;
    await sendEmail({
      to: newEmail,
      subject: 'Confirm your new BoardExamTracker email address',
      html: `<div style="font-family:Arial,sans-serif;color:#172b46;line-height:1.6"><h1 style="font-size:22px">Confirm your new email address</h1><p>Click below to confirm this email address for your BoardExamTracker Premium account.</p><p><a href="${escapeEmailHtml(confirmUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#2563a9;color:white;text-decoration:none;font-weight:bold">Confirm email address</a></p><p>If you did not request this change, you can ignore this email.</p></div>`,
      text: `Confirm your new BoardExamTracker email address: ${confirmUrl}`,
    });
    await addAuditLog({ action: 'subscriber_email_change_requested', actor: user.email, email: user.email, details: { newEmail } });
    return res.json({ ok: true, message: 'Confirmation email sent to your new address.' });
  } catch (error) {
    console.error('Email change request failed:', error.message);
    return res.status(500).json({ error: 'Could not request email change.' });
  }
});

async function handlePremiumEmailChangeConfirm(req, res) {
  const token = String(req.query.token || req.body?.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return emailResultPage(res, 'Invalid link', 'This email confirmation link is not valid.', false);
  try {
    const rawUsers = await redisCommand('HGETALL', 'boardexamtracker:premium:users');
    const values = Array.isArray(rawUsers) ? rawUsers : rawUsers && typeof rawUsers === 'object' ? Object.entries(rawUsers).flat() : [];
    let user = null;
    for (let i = 0; i + 1 < values.length; i += 2) {
      try { const u = JSON.parse(values[i + 1]); if (u?.pendingEmailToken === token) { user = u; break; } } catch {}
    }
    if (!user || !user.pendingEmail || !user.pendingEmailExpiresAt || Date.now() > Number(user.pendingEmailExpiresAt)) {
      return emailResultPage(res, 'Link expired', 'This email confirmation link is invalid or expired.', false);
    }
    const oldEmail = normalizeEmail(user.email);
    const newEmail = normalizeEmail(user.pendingEmail);
    const existing = await getUserByEmail(newEmail);
    if (existing && existing.id !== user.id) return emailResultPage(res, 'Email in use', 'That email address is already in use.', false);
    await redisCommand('HDEL', 'boardexamtracker:premium:user-email-index', oldEmail);
    user.email = newEmail;
    user.emailVerifiedAt = new Date().toISOString();
    user.pendingEmail = null;
    user.pendingEmailToken = null;
    user.pendingEmailExpiresAt = null;
    await saveUser(user);
    const sub = await getSubscriptionByEmail(oldEmail);
    if (sub) {
      await redisCommand('HDEL', 'boardexamtracker:premium:subscriptions', oldEmail);
      sub.email = newEmail;
      sub.alertEmail = newEmail;
      sub.userId = user.id;
      sub.emailVerifiedAt = user.emailVerifiedAt;
      await saveSubscription(sub);
      await addAuditLog({ action: 'subscription_email_changed', actor: oldEmail, email: newEmail, details: { oldEmail, newEmail, userId: user.id } });
    } else {
      await ensureSubscription(newEmail, { fullName: user.fullName, userId: user.id, emailVerifiedAt: user.emailVerifiedAt });
    }
    await addAuditLog({ action: 'subscriber_email_changed', actor: oldEmail, email: newEmail, details: { oldEmail, newEmail } });
    return emailResultPage(res, 'Email updated', 'Your email address has been updated. Please sign in again with your new email.', true);
  } catch (error) {
    console.error('Email change confirm failed:', error.message);
    return emailResultPage(res, 'Could not update email', 'We could not update your email address. Please try again.', false);
  }
}

app.get('/api/premium/email-change/confirm', handlePremiumEmailChangeConfirm);
app.get('/api/premium/email-change', async (req, res) => {
  const token = String(req.query.token || '');
  res.type('html').send(emailActionPage('Confirm email change', 'Confirm that you want to update your BoardExamTracker account email address.', escapeHtml(token), '/api/premium/email-change/confirm-post', 'Confirm email change'));
});
app.post('/api/premium/email-change/confirm-post', express.urlencoded({ extended: false, limit: '2kb' }), handlePremiumEmailChangeConfirm);

async function adminActor(req) {
  return req.admin?.username || 'admin';
}

app.get('/api/admin/premium/subscribers', requireAdmin, async (_req, res) => {
  try {
    const subscribers = await buildAdminSubscriberView();
    const now = Date.now();
    const active = subscribers.filter((s) => s.status === 'active');
    const expired = subscribers.filter((s) => s.status === 'expired');
    const pending = subscribers.filter((s) => s.status === 'pending');
    const complimentary = subscribers.filter((s) => s.complimentary);
    const payments = await listAllPayments(2000);
    const revenue = payments.filter((p) => p.status === 'paid' && !p.complimentary).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const emailLogs = await listEmailLogs(2000);
    const alertsSent = emailLogs.filter((l) => l.type === 'result_alert' && l.status === 'sent').length;
    res.json({
      stats: {
        totalSubscribers: subscribers.length,
        activePremiumSubscribers: active.length,
        expiredSubscribers: expired.length,
        pendingPayments: pending.length,
        complimentarySubscribers: complimentary.length,
        subscriptionRevenue: revenue,
        totalEmailAlertsSent: alertsSent,
      },
      subscribers,
    });
  } catch (error) {
    console.error('Admin premium subscribers failed:', error.message);
    res.status(500).json({ error: 'Could not load subscribers.' });
  }
});

app.post('/api/admin/premium/subscribers', requireAdmin, async (req, res) => {
  try {
    const actor = await adminActor(req);
    const email = normalizeEmail(req.body?.email);
    const fullName = String(req.body?.fullName || '').trim().slice(0, 120);
    const userId = String(req.body?.userId || '').trim() || null;
    const startDate = req.body?.startDate ? new Date(req.body.startDate).toISOString() : new Date().toISOString();
    const expirationDate = req.body?.expirationDate ? new Date(req.body.expirationDate).toISOString() : addMonthsToDate(startDate, parsePositiveInt(req.body?.durationMonths, 1));
    const amountPaid = Number(req.body?.amountPaid || 0);
    const paymentMethod = String(req.body?.paymentMethod || 'Other').trim();
    const paymentReference = String(req.body?.paymentReference || '').trim().slice(0, 200);
    const paymentStatus = String(req.body?.paymentStatus || 'Paid').trim();
    const subscriptionStatus = String(req.body?.subscriptionStatus || 'Active').trim().toLowerCase();
    const adminNotes = sanitizeAdminNotes(req.body?.adminNotes);
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Valid email address is required.' });
    if (subscriptionStatus === 'active') {
      const existing = await getSubscriptionByEmail(email);
      if (existing && effectiveStatus(existing) === 'active' && normalizeEmail(existing.email) === email) {
        // allow updating same record through edit; add should prevent duplicate active by other record? same email means same record in our store.
      }
    }
    let linkedUserId = userId;
    if (linkedUserId) {
      const u = await getUserById(linkedUserId);
      if (!u) return res.status(400).json({ error: 'User ID not found.' });
    } else {
      const byEmail = await getUserByEmail(email);
      if (byEmail) linkedUserId = byEmail.id;
    }
    const sub = await applyManualSubscription({
      email, fullName, userId: linkedUserId, startDate, expirationDate, amountPaid,
      paymentMethod, paymentReference, paymentStatus, status: subscriptionStatus, adminNotes,
      complimentary: paymentStatus.toLowerCase() === 'complimentary' || Boolean(req.body?.complimentary),
      actor,
    });
    await addAuditLog({ action: 'admin_subscriber_added', actor, email, details: { subscriptionStatus, amountPaid, paymentMethod, paymentReference } });
    if (effectiveStatus(sub) === 'active') sendSubscriptionActivatedEmail(sub).catch(() => {});
    res.json({ ok: true, subscription: publicSubscription(sub) });
  } catch (error) {
    console.error('Admin add subscriber failed:', error.message);
    res.status(400).json({ error: error.message || 'Could not add subscriber.' });
  }
});

app.put('/api/admin/premium/subscribers/:email', requireAdmin, async (req, res) => {
  try {
    const actor = await adminActor(req);
    const email = normalizeEmail(req.params.email);
    const sub = await getSubscriptionByEmail(email);
    if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
    const before = { ...sub };
    if (req.body.fullName !== undefined) sub.fullName = String(req.body.fullName || '').trim().slice(0, 120);
    if (req.body.adminNotes !== undefined) sub.adminNotes = sanitizeAdminNotes(req.body.adminNotes);
    if (req.body.newEmail !== undefined && isValidEmail(req.body.newEmail)) {
      const nextEmail = normalizeEmail(req.body.newEmail);
      if (nextEmail !== email) {
        const conflict = await getSubscriptionByEmail(nextEmail);
        if (conflict) return res.status(409).json({ error: 'A subscription already exists for that email address.' });
        await redisCommand('HDEL', 'boardexamtracker:premium:subscriptions', email);
        sub.email = nextEmail;
        sub.alertEmail = nextEmail;
        await addAuditLog({ action: 'admin_subscriber_email_updated', actor, email: nextEmail, details: { oldEmail: email, newEmail: nextEmail } });
      }
    }
    if (req.body.alertEmail !== undefined && isValidEmail(req.body.alertEmail)) sub.alertEmail = normalizeEmail(req.body.alertEmail);
    if (req.body.startDate) sub.startDate = new Date(req.body.startDate).toISOString();
    if (req.body.expirationDate) sub.expirationDate = new Date(req.body.expirationDate).toISOString();
    if (req.body.status) sub.status = String(req.body.status).toLowerCase();
    if (req.body.userId !== undefined) {
      const uid = String(req.body.userId || '').trim();
      if (uid) { const u = await getUserById(uid); if (!u) return res.status(400).json({ error: 'User ID not found.' }); sub.userId = uid; }
      else sub.userId = null;
    }
    if (req.body.connectEmailAccount && isValidEmail(req.body.connectEmailAccount)) {
      const u = await getUserByEmail(req.body.connectEmailAccount);
      if (u) sub.userId = u.id;
    }
    sub.updatedAt = new Date().toISOString();
    sub.updatedBy = actor;
    await saveSubscription(sub);
    await addAuditLog({ action: 'admin_subscriber_updated', actor, email, details: { beforeStatus: before.status, afterStatus: sub.status } });
    res.json({ ok: true, subscription: publicSubscription(sub) });
  } catch (error) {
    console.error('Admin update subscriber failed:', error.message);
    res.status(400).json({ error: error.message || 'Could not update subscriber.' });
  }
});

async function adminSubscriptionAction(req, res, action) {
  const actor = await adminActor(req);
  const email = normalizeEmail(req.params.email);
  const sub = await getSubscriptionByEmail(email);
  if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
  const now = new Date();
  if (action === 'activate') {
    sub.status = 'active';
    if (!sub.startDate) sub.startDate = now.toISOString();
    if (!sub.expirationDate || new Date(sub.expirationDate).getTime() <= now.getTime()) sub.expirationDate = addMonthsToDate(now, 1);
    sub.cancelAtPeriodEnd = false;
  } else if (action === 'deactivate') {
    sub.status = 'expired';
    sub.expirationDate = now.toISOString();
  } else if (action === 'cancel') {
    sub.status = 'cancelled';
    sub.cancelAtPeriodEnd = false;
    sub.cancelledAt = now.toISOString();
  } else if (action === 'renew') {
    const months = parsePositiveInt(req.body?.months, 1);
    const base = sub.expirationDate && new Date(sub.expirationDate).getTime() > now.getTime() ? new Date(sub.expirationDate) : now;
    if (!sub.startDate) sub.startDate = now.toISOString();
    sub.expirationDate = addMonthsToDate(base, months);
    sub.status = 'active';
    sub.cancelAtPeriodEnd = false;
  } else if (action === 'extend') {
    const months = parsePositiveInt(req.body?.months, 1);
    const base = sub.expirationDate ? new Date(sub.expirationDate) : now;
    sub.expirationDate = addMonthsToDate(base, months);
    if (sub.status !== 'cancelled') sub.status = 'active';
  } else if (action === 'set-expiration') {
    const exp = req.body?.expirationDate ? new Date(req.body.expirationDate) : null;
    if (!exp || Number.isNaN(exp.getTime())) return res.status(400).json({ error: 'Valid expirationDate is required.' });
    sub.expirationDate = exp.toISOString();
    sub.status = exp.getTime() > now.getTime() ? 'active' : 'expired';
  } else if (action === 'mark-complimentary') {
    sub.complimentary = true;
    sub.status = 'active';
    if (!sub.startDate) sub.startDate = now.toISOString();
    if (!sub.expirationDate || new Date(sub.expirationDate).getTime() <= now.getTime()) sub.expirationDate = addMonthsToDate(now, parsePositiveInt(req.body?.months, 1));
  } else {
    return res.status(400).json({ error: 'Unknown action.' });
  }
  sub.updatedAt = now.toISOString();
  sub.updatedBy = actor;
  await saveSubscription(sub);
  await addAuditLog({ action: `admin_subscriber_${action.replace(/-/g, '_')}`, actor, email, details: { status: sub.status, expirationDate: sub.expirationDate, months: req.body?.months || null } });
  if (['active', 'pending'].includes(sub.status) && effectiveStatus(sub) === 'active') {
    sendSubscriptionActivatedEmail(sub).catch(() => {});
  }
  return res.json({ ok: true, subscription: publicSubscription(sub) });
}

for (const [route, action] of [
  ['/api/admin/premium/subscribers/:email/activate', 'activate'],
  ['/api/admin/premium/subscribers/:email/deactivate', 'deactivate'],
  ['/api/admin/premium/subscribers/:email/cancel', 'cancel'],
  ['/api/admin/premium/subscribers/:email/renew', 'renew'],
  ['/api/admin/premium/subscribers/:email/extend', 'extend'],
  ['/api/admin/premium/subscribers/:email/set-expiration', 'set-expiration'],
  ['/api/admin/premium/subscribers/:email/complimentary', 'mark-complimentary'],
]) {
  app.post(route, requireAdmin, (req, res) => adminSubscriptionAction(req, res, action).catch((error) => {
    console.error('Admin subscriber action failed:', error.message);
    res.status(500).json({ error: 'Could not update subscriber.' });
  }));
}

app.post('/api/admin/premium/subscribers/:email/mark-paid', requireAdmin, async (req, res) => {
  try {
    const actor = await adminActor(req);
    const email = normalizeEmail(req.params.email);
    const sub = await getSubscriptionByEmail(email);
    if (!sub) return res.status(404).json({ error: 'Subscriber not found.' });
    const months = parsePositiveInt(req.body?.months, 1);
    const amount = Number(req.body?.amountPaid ?? req.body?.amount ?? (months * 20));
    const method = String(req.body?.paymentMethod || 'Other').trim();
    const reference = String(req.body?.paymentReference || `MANUAL-${Date.now()}`).trim();
    const payment = await createPayment({ email, userId: sub.userId || null, amount, currency: 'PHP', method, reference, status: 'paid', months, actor, notes: sanitizeAdminNotes(req.body?.adminNotes), metadata: { source: 'admin_mark_paid' } });
    await activateSubscription({ email, fullName: sub.fullName, userId: sub.userId || null, months, amount, method, reference, actor, paymentId: payment.id, complimentary: false });
    await addAuditLog({ action: 'admin_payment_marked_paid', actor, email, details: { paymentId: payment.id, amount, months, method, reference } });
    res.json({ ok: true, payment });
  } catch (error) {
    console.error('Admin mark paid failed:', error.message);
    res.status(400).json({ error: error.message || 'Could not mark payment as paid.' });
  }
});

app.get('/api/admin/premium/subscribers/:email/payments', requireAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const payments = await listPaymentsByEmail(email);
    res.json({ payments });
  } catch (error) {
    res.status(500).json({ error: 'Could not load payment history.' });
  }
});

app.get('/api/admin/premium/email-log', requireAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email || '');
    const logs = await listEmailLogs(500);
    res.json({ logs: email ? logs.filter((l) => normalizeEmail(l.email) === email) : logs.slice(0, 200) });
  } catch (error) {
    res.status(500).json({ error: 'Could not load email log.' });
  }
});

app.get('/api/admin/premium/audit', requireAdmin, async (_req, res) => {
  try {
    const logs = await listAuditLogs(300);
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: 'Could not load audit log.' });
  }
});

app.get('/api/admin/premium/export.csv', requireAdmin, async (_req, res) => {
  try {
    const subscribers = await buildAdminSubscriberView();
    const header = ['Name','Email','User ID','Payment Method','Amount Paid','Payment Status','Subscription Status','Start Date','Expiration Date','Email Alert Status','Payment Reference','Admin Notes'];
    const rows = subscribers.map((s) => [s.fullName, s.email, s.userId || '', s.paymentMethod, s.amountPaid, s.paymentStatus, s.status, s.startDate || '', s.expirationDate || '', s.status === 'active' ? 'enabled' : 'disabled', s.paymentReference || '', s.adminNotes || '']);
    const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="premium-subscribers.csv"');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: 'Could not export subscribers.' });
  }
});

app.get('/api/admin/premium/config', requireAdmin, async (_req, res) => {
  try {
    const config = await getConfig();
    res.json({ config, ganapConfigured: ganapConfig().configured });
  } catch (error) {
    res.status(500).json({ error: 'Could not load config.' });
  }
});

app.put('/api/admin/premium/config', requireAdmin, async (req, res) => {
  try {
    const actor = await adminActor(req);
    const current = await getConfig();
    const next = {
      ...current,
      ganapEnabled: req.body?.ganapEnabled !== undefined ? Boolean(req.body.ganapEnabled) : current.ganapEnabled,
      alternativeMethods: Array.isArray(req.body?.alternativeMethods) ? req.body.alternativeMethods.map((v) => String(v).trim()).filter(Boolean).slice(0, 20) : current.alternativeMethods,
      prepaidOptions: Array.isArray(req.body?.prepaidOptions) ? req.body.prepaidOptions.map((o) => ({ label: String(o.label || '').trim().slice(0, 120), months: parsePositiveInt(o.months, 1), amount: Number(o.amount) || 0 })).filter((o) => o.label && o.amount > 0) : current.prepaidOptions,
    };
    await saveConfig(next);
    await addAuditLog({ action: 'admin_premium_config_updated', actor, email: null, details: { ganapEnabled: next.ganapEnabled, prepaidOptions: next.prepaidOptions.length } });
    res.json({ ok: true, config: next });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not save config.' });
  }
});


app.get('/ads.txt', (_req, res) => {
  const clientId = process.env.ADSENSE_CLIENT_ID || '';
  if (!/^ca-pub-\d+$/.test(clientId)) return res.status(404).type('text/plain').send('');
  const publisherId = clientId.replace(/^ca-/, '');
  return res.type('text/plain').send(`google.com, ${publisherId}, DIRECT, f08c47fec0942fa0\n`);
});

function mergeResultLists(...lists) {
  const merged = new Map();
  for (const result of lists.flat()) {
    const url = normalizeUrl(result?.url);
    if (!url || !result?.title || !result?.date) continue;
    merged.set(url, { ...result, url });
  }
  return [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
}

async function restorePersistentResultCache() {
  if (!isPersistentStorageConfigured()) return getCache();
  if (getCache() && Date.now() - lastPersistentResultRestoreAt < PERSISTENT_RESULT_SYNC_MS) return getCache();
  if (!pendingPersistentResultRestore) {
    pendingPersistentResultRestore = (async () => {
      try {
        const saved = await redisCommand('GET', RESULTS_CACHE_KEY);
        let snapshot = {};
        if (typeof saved === 'string') {
          try { snapshot = JSON.parse(saved); } catch { snapshot = {}; }
        }
        const indexedAnnouncements = await loadPublishedAnnouncements(redisCommand);
        const snapshotResults = Array.isArray(snapshot.results) ? snapshot.results : [];
        const results = mergeResultLists(getCache()?.results || [], snapshotResults, indexedAnnouncements);
        if (!results.length) return getCache() || null;
        const fetchedAt = Math.max(getCache()?.fetchedAt || 0, Number.isFinite(snapshot.fetchedAt) ? snapshot.fetchedAt : 0) || Date.now();
        const restored = setCache(results, fetchedAt);
        if (snapshot.archiveLoaded === true) archiveCacheLoaded = true;
        lastPersistentResultRestoreAt = Date.now();
        return restored;
      } catch (error) {
        console.warn('Could not restore shared result cache:', error.message);
        return getCache() || null;
      } finally {
        pendingPersistentResultRestore = null;
      }
    })();
  }
  return pendingPersistentResultRestore;
}

async function persistResultCache(results, fetchedAt = Date.now(), archiveLoaded = archiveCacheLoaded) {
  if (!isPersistentStorageConfigured() || !results?.length) return;
  try {
    // Keep a useful archive snapshot in shared storage so cold Vercel functions
    // can still serve results while PRC is temporarily unavailable.
    const snapshot = JSON.stringify({ results: results.slice(0, 500), fetchedAt, archiveLoaded });
    await redisCommand('SET', RESULTS_CACHE_KEY, snapshot, 'EX', 60 * 60 * 24 * 30);
  } catch (error) {
    console.warn('Could not save shared result cache:', error.message);
  }
}

async function refresh() {
  if (!pendingFetch) {
    pendingFetch = restorePersistentResultCache()
      .then(() => {
        restoreBundledResultCache();
        return fetchResults({ maxPage: 2 });
      })
      .then(async (latest) => {
        const value = setCache(mergeResultLists(getCache()?.results || [], latest));
        await persistResultCache(value.results, value.fetchedAt, archiveCacheLoaded);
        return value;
      })
      .catch(async (error) => {
        await restorePersistentResultCache();
        const fallback = restoreBundledResultCache();
        if (fallback) await persistResultCache(fallback.results, fallback.fetchedAt, archiveCacheLoaded);
        if (getCache()) {
          console.warn('PRC refresh failed; serving the last saved results:', error.message);
          return getCache();
        }
        throw error;
      })
      .finally(() => { pendingFetch = null; });
  }
  return pendingFetch;
}

async function loadArchiveResults() {
  await restorePersistentResultCache();
  const bundled = restoreBundledResultCache();
  if (bundled) await persistResultCache(bundled.results, bundled.fetchedAt, true);
  const cached = getCache();
  if (archiveCacheLoaded && cached) return cached;
  if (!pendingArchiveFetch) {
    pendingArchiveFetch = fetchResults()
      .then(async (archive) => {
        archiveCacheLoaded = true;
        const value = setCache(mergeResultLists(getCache()?.results || [], archive));
        await persistResultCache(value.results, value.fetchedAt, true);
        return value;
      })
      .finally(() => { pendingArchiveFetch = null; });
  }
  return pendingArchiveFetch;
}

function escapeEmailHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function publicBaseUrl() {
  if (process.env.NODE_ENV === 'production') return 'https://www.boardexamtracker.com';
  return (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
}

function boardResultPageUrl(baseUrl, result) {
  const officialUrl = normalizeUrl(result.url);
  if (!officialUrl) return `${baseUrl}/#latest`;
  const pathParts = new URL(officialUrl).pathname.split('/').filter(Boolean);
  const slug = decodeURIComponent(pathParts[pathParts.length - 1] || 'result');
  return `${baseUrl}/results/${encodeURIComponent(slug)}`;
}

function resultSlug(result) {
  const officialUrl = normalizeUrl(result?.url);
  if (!officialUrl) return '';
  return decodeURIComponent(new URL(officialUrl).pathname.split('/').filter(Boolean).pop() || '');
}

async function findResultBySlug(slug) {
  await restorePersistentResultCache();
  restoreBundledResultCache();
  const cachedResults = getCache()?.results || [];
  const cachedMatch = cachedResults.find((result) => resultSlug(result) === slug);
  if (cachedMatch) return cachedMatch;

  if (!recentResultIndex || Date.now() - recentResultIndexFetchedAt > 5 * 60 * 1000) {
    if (!recentResultIndexPromise) {
      recentResultIndexPromise = fetchResults({ maxPage: 2 })
        .then((results) => {
          recentResultIndex = results;
          recentResultIndexFetchedAt = Date.now();
          return results;
        })
        .finally(() => { recentResultIndexPromise = null; });
    }
    await recentResultIndexPromise;
  }
  const recentMatch = recentResultIndex?.find((result) => resultSlug(result) === slug);
  if (recentMatch) return recentMatch;

  if (archiveCacheLoaded) return (getCache()?.results || []).find((result) => resultSlug(result) === slug) || null;
  if (!fullResultIndex || Date.now() - fullResultIndexFetchedAt > 5 * 60 * 1000) {
    if (!fullResultIndexPromise) {
      fullResultIndexPromise = fetchResults()
        .then((results) => {
          fullResultIndex = results;
          fullResultIndexFetchedAt = Date.now();
          return results;
        })
        .finally(() => { fullResultIndexPromise = null; });
    }
    await fullResultIndexPromise;
  }
  return fullResultIndex?.find((result) => resultSlug(result) === slug) || null;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function replaceMetaValue(html, pattern, value) {
  return html.replace(pattern, (_match, prefix, suffix) => `${prefix}${value}${suffix}`);
}

function wrapSvgText(value, maxCharacters, maxLines) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxCharacters && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    } else line = next;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const consumed = lines.join(' ').length;
  if (lines.length && consumed < String(value || '').trim().length) {
    const last = lines.length - 1;
    lines[last] = `${lines[last].replace(/[.…]*$/, '')}…`;
  }
  return lines;
}

function svgText(value, { x, y, size, color, weight = 400, letterSpacing = 0 }) {
  const fonts = getShareFonts();
  const font = weight >= 600 ? fonts.bold : fonts.regular;
  const scale = size / font.unitsPerEm;
  const run = font.layout(String(value));
  let cursor = x;
  return run.glyphs.map((glyph, index) => {
    const position = run.positions[index];
    const glyphX = cursor + position.xOffset * scale;
    const glyphY = y - position.yOffset * scale;
    cursor += (position.xAdvance * scale) + letterSpacing;
    return `<path d="${glyph.path.toSVG()}" transform="translate(${glyphX.toFixed(2)} ${glyphY.toFixed(2)}) scale(${scale.toFixed(4)} -${scale.toFixed(4)})" fill="${color}"/>`;
  }).join('');
}

function getSharp() {
  if (!sharp) sharp = require('sharp');
  return sharp;
}

function getShareFonts() {
  if (!shareFonts) {
    const fontkit = require('fontkit');
    const { readFileSync } = require('node:fs');
    shareFonts = {
      regular: fontkit.create(readFileSync(path.join(__dirname, '..', 'public', 'fonts', 'dm-sans-400.woff2'))),
      bold: fontkit.create(readFileSync(path.join(__dirname, '..', 'public', 'fonts', 'dm-sans-700.woff2'))),
    };
  }
  return shareFonts;
}

function svgTextLines(lines, { x, y, size, lineHeight, color, weight = 400 }) {
  return lines.map((line, index) => svgText(line, { x, y: y + index * lineHeight, size, color, weight })).join('');
}

function createResultCardSvg(item) {
  const title = wrapSvgText(item.title || 'Board Exam Result', 56, 3);
  const summary = wrapSvgText(item.description || `The ${item.category || 'professional licensure'} examination result is available. Open the result page to review the files linked by its announcement.`, 94, 2);
  let date = 'See result page for release date';
  if (item.date && /^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
    date = `Released ${new Intl.DateTimeFormat('en-PH', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${item.date}T00:00:00Z`))}`;
  }
  const category = String(item.category || 'Board Exam Result').slice(0, 52).toUpperCase();
  const tagWidth = Math.min(610, Math.max(245, category.length * 10 + 40));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#101b2c"/>
    <circle cx="1080" cy="80" r="120" fill="#173452" opacity=".55"/><circle cx="1110" cy="40" r="42" fill="#1d4365" opacity=".5"/>
    <rect x="64" y="48" width="48" height="48" rx="14" fill="#1d4365"/><path d="m77 72 9 9 16-19" fill="none" stroke="#78d6b5" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    ${svgText('BoardExamTracker', { x: 128, y: 81, size: 27, color: '#ffffff', weight: 700 })}
    <rect x="835" y="54" width="301" height="38" rx="19" fill="#153b38"/><circle cx="859" cy="73" r="5" fill="#77d9b8"/>${svgText('PHILIPPINE BOARD EXAM RESULT', { x: 875, y: 79, size: 14, color: '#83e0c2', weight: 700, letterSpacing: 1.2 })}
    ${svgText('BOARD EXAM RESULT', { x: 64, y: 151, size: 16, color: '#73b6ee', weight: 700, letterSpacing: 4 })}
    <rect x="64" y="174" width="${tagWidth}" height="39" rx="8" fill="#203e5b"/>${svgText(category, { x: 80, y: 200, size: 15, color: '#bfddfa', weight: 700, letterSpacing: 1 })}
    ${svgTextLines(title, { x: 64, y: 278, size: 38, lineHeight: 46, color: '#edf3fb', weight: 700 })}
    ${svgText(date, { x: 64, y: 444, size: 19, color: '#9eb0c6', weight: 700 })}
    ${svgTextLines(summary, { x: 64, y: 496, size: 22, lineHeight: 30, color: '#d1dce9' })}
    <rect x="64" y="559" width="1072" height="42" rx="11" fill="#153a35"/><circle cx="85" cy="580" r="8" fill="#63cfaa"/>${svgText('Independent results guide · Source: PRC.gov.ph', { x: 104, y: 586, size: 15, color: '#c8e7dd' })}${svgText('boardexamtracker.com', { x: 958, y: 586, size: 15, color: '#c8e7dd' })}
  </svg>`;
}

async function notifySubscribers(results) {
  await expireDueSubscriptions().catch((error) => console.warn('Could not expire subscriptions before alert dispatch:', error.message));
  return notifyPremiumSubscribers(results);
}

async function sendResultAlert(subscriber, results, { resend = false, idempotencyKey } = {}) {
  const baseUrl = publicBaseUrl();
  const itemHtml = results.slice(0, 30).map((result) => `<li><a href="${escapeEmailHtml(boardResultPageUrl(baseUrl, result))}">${escapeEmailHtml(result.title)}</a> <span>— ${escapeEmailHtml(result.date)}</span></li>`).join('');
  const itemText = results.slice(0, 30).map((result) => `- ${result.title} (${result.date})\n  ${boardResultPageUrl(baseUrl, result)}`).join('\n');
  const unsubscribeUrl = subscriber.unsubscribeToken
    ? `${baseUrl}/api/email/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribeToken)}`
    : null;
  const heading = resend ? 'Your requested board exam result reminder' : `New board exam ${results.length === 1 ? 'result' : 'results'} are available`;
  const intro = resend
    ? 'An administrator resent the latest result alert to you. You can review it on BoardExamTracker.'
    : `BoardExamTracker found ${results.length} new announcement${results.length === 1 ? '' : 's'} in the public PRC Exam Results feed.`;
  await sendEmail({
    to: subscriber.email,
    subject: resend ? `Reminder: latest board exam result on BoardExamTracker` : `${results.length} new PRC exam ${results.length === 1 ? 'result' : 'results'} on BoardExamTracker`,
    html: `<div style="font-family:Arial,sans-serif;color:#172b46;line-height:1.6"><h1 style="font-size:22px">${escapeEmailHtml(heading)}</h1><p>${escapeEmailHtml(intro)}</p><ul>${itemHtml}</ul><p><a href="${escapeEmailHtml(baseUrl)}">View BoardExamTracker</a></p><hr><p style="font-size:12px;color:#718097">Independent tracker; not affiliated with PRC.${unsubscribeUrl ? ` <a href="${escapeEmailHtml(unsubscribeUrl)}">Unsubscribe from these emails</a>.` : ''}</p></div>`,
    text: `${heading}\n\n${intro}\n\n${itemText}${unsubscribeUrl ? `\n\nUnsubscribe: ${unsubscribeUrl}` : ''}`,
    idempotencyKey,
  });
}

function emailActionPage(title, message, token, action, buttonText) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} | BoardExamTracker</title><body style="margin:0;background:#f5f8fc;font:16px/1.6 Arial,sans-serif;color:#172b46"><main style="max-width:560px;margin:10vh auto;padding:32px;background:white;border:1px solid #e5ebf2;border-radius:16px"><p style="color:#2563a9;font-weight:bold">BoardExamTracker</p><h1>${title}</h1><p>${message}</p><form method="post" action="${action}"><input type="hidden" name="token" value="${token}"><button style="padding:12px 18px;border:0;border-radius:8px;background:#2563a9;color:white;font-weight:bold;cursor:pointer">${buttonText}</button></form></main></body></html>`;
}

function emailResultPage(res, title, message, success) {
  res.status(success ? 200 : 400).type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} | BoardExamTracker</title><body style="margin:0;background:#f5f8fc;font:16px/1.6 Arial,sans-serif;color:#172b46"><main style="max-width:560px;margin:10vh auto;padding:32px;background:white;border:1px solid #e5ebf2;border-radius:16px"><p style="color:#2563a9;font-weight:bold">BoardExamTracker</p><h1>${title}</h1><p>${message}</p><a href="/" style="color:#2563a9">Return to BoardExamTracker</a></main></body></html>`);
}

const emailAttempts = new Map();
function allowEmailAttempt(req) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (emailAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 60 * 60 * 1000);
  if (recent.length >= 5) return false;
  recent.push(now);
  emailAttempts.set(ip, recent);
  return true;
}

app.get('/api/notifications/status', async (_req, res) => {
  const emailReady = isEmailConfigured();
  const persistentStorageReady = isPersistentStorageConfigured();
  const config = await getConfig().catch(() => null);
  res.json({
    available: emailReady && persistentStorageReady,
    premium: true,
    planName: config?.planName || 'Premium Email Alerts',
    monthlyPrice: config?.monthlyPrice || 20,
    reason: !emailReady ? 'email' : !persistentStorageReady ? 'storage' : null,
  });
});

async function loadResultsCheckStatus() {
  try {
    const value = await redisCommand('GET', RESULTS_CHECK_STATUS_KEY);
    return typeof value === 'string' ? JSON.parse(value) : {};
  } catch { return {}; }
}

async function saveResultsCheckStatus(patch) {
  const previous = await loadResultsCheckStatus();
  const next = { ...previous, ...patch };
  await redisCommand('SET', RESULTS_CHECK_STATUS_KEY, JSON.stringify(next), 'EX', 60 * 60 * 24 * 90);
  return next;
}

app.all('/api/cron/check-status', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.get('authorization') !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized.' });
  if (!isPersistentStorageConfigured()) return res.status(503).json({ error: 'Persistent result tracking is not configured.' });
  try {
    const action = req.body?.action || req.query.action;
    if (action === 'acquire') {
      const lockToken = randomUUID();
      const acquired = await redisCommand('SET', RESULTS_CHECK_LOCK_KEY, lockToken, 'NX', 'EX', 240);
      if (acquired !== 'OK') return res.status(409).json({ acquired: false, reason: 'A result check is already running.' });
      return res.json({ acquired: true, lockToken });
    }
    if (action === 'release') {
      const lockToken = typeof req.body?.lockToken === 'string' ? req.body.lockToken : '';
      if (lockToken && await redisCommand('GET', RESULTS_CHECK_LOCK_KEY) === lockToken) await redisCommand('DEL', RESULTS_CHECK_LOCK_KEY);
      return res.json({ released: true });
    }
    if (action === 'scan-state') {
      if (req.method === 'GET') {
        const cursor = Number(await redisCommand('GET', RESULTS_SCAN_CURSOR_KEY)) || 3;
        return res.json({ cursor });
      }
      const cursor = Number(req.body?.cursor);
      if (!Number.isInteger(cursor) || cursor < 3 || cursor > 10000) return res.status(400).json({ error: 'Invalid page cursor.' });
      await redisCommand('SET', RESULTS_SCAN_CURSOR_KEY, String(cursor), 'EX', 60 * 60 * 24 * 365);
      return res.json({ saved: true, cursor });
    }
    if (!['started', 'success', 'failure'].includes(action)) return res.status(400).json({ error: 'Invalid checker status action.' });
    const now = new Date().toISOString();
    const checker = typeof req.body?.checker === 'string' ? req.body.checker.replace(/[^a-z0-9-]/gi, '').slice(0, 80) : '';
    const patch = { state: action === 'started' ? 'running' : action === 'success' ? 'healthy' : 'error', lastAttemptAt: now, ...(checker ? { lastChecker: checker } : {}) };
    if (action === 'success') Object.assign(patch, {
      lastSuccessAt: now,
      lastError: null,
      lastResultCount: Number(req.body?.resultCount) || 0,
      lastPublishedCount: Number(req.body?.newResults) || 0,
      lastPageCount: Number(req.body?.pageCount) || 0,
    });
    if (action === 'failure') patch.lastError = String(req.body?.error || 'The automatic PRC check failed.').replace(/[\r\n\t]+/g, ' ').slice(0, 1200);
    return res.json({ status: await saveResultsCheckStatus(patch) });
  } catch (error) {
    console.error('Could not update PRC checker status:', error.message);
    return res.status(503).json({ error: 'Could not update PRC checker state.' });
  }
});

app.post('/api/cron/check-results', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.get('authorization') !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized.' });
  if (!isPersistentStorageConfigured()) return res.status(503).json({ error: 'Persistent result tracking is not configured.' });

  let ownedLockToken = '';
  try {
    const externalLockToken = typeof req.body?.lockToken === 'string' ? req.body.lockToken : '';
    if (externalLockToken) {
      if (await redisCommand('GET', RESULTS_CHECK_LOCK_KEY) !== externalLockToken) return res.status(409).json({ skipped: true, reason: 'The scheduled-check lock expired.' });
    } else {
      ownedLockToken = randomUUID();
      const lock = await redisCommand('SET', RESULTS_CHECK_LOCK_KEY, ownedLockToken, 'NX', 'EX', 240);
      if (lock !== 'OK') return res.json({ skipped: true, reason: 'A result check is already running.' });
    }
    await restorePersistentResultCache();
    restoreBundledResultCache();

    const usingFallbackSnapshot = req.body?.fallback === true;
    const sourceResults = Array.isArray(req.body?.results) ? req.body.results : await fetchResults({ maxPage: 2 });
    const validateAnnouncement = require('./announcement-store').validateAnnouncement;
    const latest = [];
    const records = [];
    for (const sourceResult of sourceResults) {
      const checked = validateAnnouncement(sourceResult);
      if (checked.valid) latest.push({ ...checked.announcement });
      else {
        const pending = await upsertAnnouncement(sourceResult, redisCommand);
        if (pending.record) records.push(pending);
      }
    }
    latest.sort((a, b) => b.date.localeCompare(a.date));
    if (!latest.length) throw new Error('No validated, dated result announcements could be read from the official PRC page.');
    if (req.body?.archiveLoaded === true) archiveCacheLoaded = true;

    let knownUrls = new Set();
    let initialized = false;
    const saved = await redisCommand('GET', KNOWN_RESULTS_KEY);
    initialized = typeof saved !== 'string';
    if (typeof saved === 'string') {
      try {
        const decoded = JSON.parse(saved);
        if (!Array.isArray(decoded)) throw new Error('Invalid notification baseline.');
        knownUrls = new Set(decoded.map((url) => normalizeUrl(url)).filter(Boolean));
      } catch { knownUrls = new Set(); initialized = true; }
    }
    for (const result of latest) records.push(await upsertAnnouncement(result, redisCommand));
    if (usingFallbackSnapshot) {
      for (const { record } of records) {
        if (!record) continue;
        record.notificationStatus = 'not-required';
        await redisCommand('SET', announcementKey(record.canonicalUrl), JSON.stringify(record));
      }
      const mergedUrls = [...new Set([...latest.map((result) => result.url), ...knownUrls])].slice(0, 5000);
      await redisCommand('SET', KNOWN_RESULTS_KEY, JSON.stringify(mergedUrls));
      const cache = setCache(mergeResultLists(getCache()?.results || [], latest));
      await persistResultCache(cache.results, cache.fetchedAt, archiveCacheLoaded);
      await saveResultsCheckStatus({
        state: 'error',
        lastAttemptAt: new Date().toISOString(),
        lastError: 'PRC live fetch failed in the scheduled runner; the verified fallback snapshot was published without new-result alerts.',
        lastResultCount: latest.length,
        lastPublishedCount: 0,
        lastPageCount: Number(req.body?.pages) || 0,
      });
      return res.json({ initialized: false, fallback: true, newResults: 0, recipients: 0, failed: 0, announcementUrls: [] });
    }
    if (initialized) {
      for (const { record } of records) {
        record.notificationStatus = 'not-required';
        await redisCommand('SET', announcementKey(record.canonicalUrl), JSON.stringify(record));
      }
      await redisCommand('SET', KNOWN_RESULTS_KEY, JSON.stringify(latest.map((result) => result.url).slice(0, 5000)));
      const cache = setCache(mergeResultLists(getCache()?.results || [], latest));
      await persistResultCache(cache.results, cache.fetchedAt, archiveCacheLoaded);
      const announcementUrls = await missingAnnouncementUrls(latest);
      await saveResultsCheckStatus({ state: 'healthy', lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastError: null, ...(typeof req.body?.checker === 'string' ? { lastChecker: req.body.checker.replace(/[^a-z0-9-]/gi, '').slice(0, 80) } : {}), lastResultCount: latest.length, lastPublishedCount: 0, lastPageCount: Number(req.body?.pages) || 0 });
      return res.json({ initialized: true, newResults: 0, announcementUrls, message: 'Saved current PRC results as the notification baseline.' });
    }

    const pendingRecords = records.filter(({ record }) => record.publicationStatus === 'published' && record.notificationStatus === 'pending' && !knownUrls.has(record.canonicalUrl));
    const resultByUrl = new Map(latest.map((result) => [result.url, result]));
    const newResults = pendingRecords.map(({ record }) => resultByUrl.get(record.canonicalUrl)).filter(Boolean);
    if (newResults.length) await redisCommand('SET', ADSENSE_ENABLED_KEY, 'false');
    const cache = setCache(mergeResultLists(getCache()?.results || [], latest));
    await persistResultCache(cache.results, cache.fetchedAt, archiveCacheLoaded);

    const delivery = newResults.length ? await notifySubscribers(newResults) : { recipients: 0, failed: 0 };
    if (delivery.failed) {
      await saveResultsCheckStatus({ state: 'error', lastAttemptAt: new Date().toISOString(), lastError: `${delivery.failed} subscriber alert(s) could not be delivered.`, lastResultCount: latest.length, lastPageCount: Number(req.body?.pages) || 0 });
      return res.status(502).json({ error: 'Some result-alert emails failed. The failed deliveries will retry idempotently on the next scheduled check.', recipients: delivery.recipients, failed: delivery.failed, failureStatuses: delivery.failureStatuses });
    }
    for (const { record } of pendingRecords) {
      record.notificationStatus = 'sent';
      await redisCommand('SET', announcementKey(record.canonicalUrl), JSON.stringify(record));
    }
    const mergedUrls = [...new Set([...latest.map((result) => result.url), ...knownUrls])].slice(0, 5000);
    await redisCommand('SET', KNOWN_RESULTS_KEY, JSON.stringify(mergedUrls));
    const announcementUrls = await missingAnnouncementUrls([...newResults, ...latest]);
    await saveResultsCheckStatus({ state: 'healthy', lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastError: null, ...(typeof req.body?.checker === 'string' ? { lastChecker: req.body.checker.replace(/[^a-z0-9-]/gi, '').slice(0, 80) } : {}), lastResultCount: latest.length, lastPublishedCount: newResults.length, lastPageCount: Number(req.body?.pages) || 0 });
    return res.json({ initialized: false, newResults: newResults.length, recipients: delivery.recipients, failed: delivery.failed, announcementUrls });
  } catch (error) {
    console.error('Scheduled PRC result check failed:', error.message);
    const detail = String(error.message || 'Check failed.').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
    try { await saveResultsCheckStatus({ state: 'error', lastAttemptAt: new Date().toISOString(), lastError: detail }); } catch { /* Preserve the original failure if status storage is also down. */ }
    return res.status(502).json({ error: 'Scheduled PRC result check failed.', detail });
  } finally {
    if (ownedLockToken) {
      try {
        if (await redisCommand('GET', RESULTS_CHECK_LOCK_KEY) === ownedLockToken) await redisCommand('DEL', RESULTS_CHECK_LOCK_KEY);
      } catch (error) { console.warn('Could not release result-check lock:', error.message); }
    }
  }
});

app.get('/api/admin/results-check', requireAdmin, async (_req, res) => {
  try { return res.json({ source: SOURCE_URL, ...(await loadResultsCheckStatus()) }); }
  catch { return res.status(503).json({ error: 'Could not read the checker status.' }); }
});

app.post('/api/admin/results-check', requireAdmin, async (_req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const checkerUrl = process.env.PRC_CHECKER_URL || 'https://boardexamtracker-prc-checker.boardexamtracker.workers.dev';
  if (!cronSecret) return res.status(503).json({ error: 'Set CRON_SECRET on the site and Cloudflare Worker before running a manual check.' });
  try {
    const url = new URL(checkerUrl);
    if (url.protocol !== 'https:') throw new Error('The PRC checker URL must use HTTPS.');
    const response = await fetch(`${url.href.replace(/\/$/, '')}/manual-check`, { method: 'POST', headers: { Authorization: `Bearer ${cronSecret}`, Accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: body.error || 'The online PRC checker could not run.' });
    if (body.started !== true) return res.status(502).json({ error: 'The online checker does not expose the secure manual-check endpoint yet. Deploy the updated Cloudflare Worker first.' });
    return res.json(body);
  } catch (error) {
    console.error('Manual PRC checker invocation failed:', error.message);
    return res.status(502).json({ error: 'Could not reach the online PRC checker. Confirm it has been deployed and try again.' });
  }
});

app.post('/api/notifications/subscribe', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  return res.status(400).json({
    error: 'Free email alerts are no longer available. Subscribe to Premium Email Alerts for ₱20/month to receive email notifications when new board exam results are published.',
    premium: true,
    redirect: '/account',
  });
});

app.get('/api/email/confirm', (req, res) => {
  const token = String(req.query.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return emailResultPage(res, 'Invalid confirmation link', 'This email confirmation link is not valid.', false);
  res.type('html').send(emailActionPage('Confirm email alerts', 'Confirm that you want to receive an email when new PRC exam results are found.', token, '/api/email/confirm', 'Confirm subscription'));
});

app.post('/api/email/confirm', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  const token = String(req.body?.token || '');
  const confirmed = /^[a-f0-9]{64}$/.test(token) && await confirmSubscriber(token);
  emailResultPage(res, confirmed ? 'Email alerts activated' : 'Confirmation link expired', confirmed ? 'You will receive an email when new PRC exam results are found. You can unsubscribe from any alert email.' : 'Request a new confirmation email from the signup form and try again.', confirmed);
});

app.get('/api/email/unsubscribe', (req, res) => {
  const token = String(req.query.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return emailResultPage(res, 'Invalid unsubscribe link', 'This unsubscribe link is not valid.', false);
  res.type('html').send(emailActionPage('Unsubscribe from email alerts', 'Confirm that you want to stop receiving BoardExamTracker email alerts.', token, '/api/email/unsubscribe', 'Unsubscribe'));
});

app.post('/api/email/unsubscribe', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  const token = String(req.body?.token || '');
  const removed = /^[a-f0-9]{64}$/.test(token) && await removeSubscriber(token);
  emailResultPage(res, removed ? 'Unsubscribed' : 'Link not found', removed ? 'This email address has been removed from BoardExamTracker alerts.' : 'This unsubscribe link is invalid or has already been used.', removed);
});

app.get('/api/results', async (req, res) => {
  // Results are already validated and stored before this endpoint serves them.
  // A brief edge cache avoids a Redis round trip for every visitor without
  // materially delaying newly published announcements.
  const force = req.query.refresh === 'true';
  res.set('Cache-Control', force
    ? 'no-store'
    : 'public, max-age=0, s-maxage=5, stale-while-revalidate=10');
  if (req.query.archive === 'true') {
    try {
      const value = await loadArchiveResults();
      const stale = Date.now() - value.fetchedAt >= AUTO_REFRESH_MS;
      return res.json({ results: value.results, professions: PROFESSION_CATEGORIES, lastUpdated: new Date(value.fetchedAt).toISOString(), cached: archiveCacheLoaded, archiveLoaded: true, stale, source: SOURCE_URL, ...(stale ? { warning: 'Showing the saved PRC results archive while the live feed is unavailable.' } : {}) });
    } catch (error) {
      const cached = getCache();
      if (cached) return res.status(200).json({ results: cached.results, professions: PROFESSION_CATEGORIES, lastUpdated: new Date(cached.fetchedAt).toISOString(), cached: true, archiveLoaded: false, stale: true, source: SOURCE_URL, warning: 'Showing the latest cached results. Older results could not be loaded.' });
      return res.status(503).json({ results: [], professions: PROFESSION_CATEGORIES, lastUpdated: null, cached: false, archiveLoaded: false, stale: false, source: SOURCE_URL, error: 'Unable to retrieve older PRC results.', message: error.message });
    }
  }
  if (!force) {
    await restorePersistentResultCache();
    restoreBundledResultCache();
    const cached = getCache();
    if (cached) {
      const stale = !isFresh();
      if (stale) refresh().catch((error) => console.warn('Background PRC result refresh failed:', error.message));
      return res.json({ results: cached.results.slice(0, INITIAL_RESULTS_LIMIT), professions: PROFESSION_CATEGORIES, lastUpdated: new Date(cached.fetchedAt).toISOString(), cached: true, archiveLoaded: false, stale, source: SOURCE_URL, ...(stale ? { warning: 'Showing the latest saved results while the official feed refreshes.' } : {}) });
    }
  }
  try {
    const value = await refresh();
    const stale = Date.now() - value.fetchedAt >= AUTO_REFRESH_MS;
    return res.json({ results: value.results.slice(0, INITIAL_RESULTS_LIMIT), professions: PROFESSION_CATEGORIES, lastUpdated: new Date(value.fetchedAt).toISOString(), cached: stale, archiveLoaded: false, stale, source: SOURCE_URL, ...(stale ? { warning: 'Showing the latest saved results while the official results feed is unavailable.' } : {}) });
  } catch (error) {
    const cached = getCache();
    if (cached) return res.status(200).json({ results: cached.results.slice(0, INITIAL_RESULTS_LIMIT), professions: PROFESSION_CATEGORIES, lastUpdated: new Date(cached.fetchedAt).toISOString(), cached: true, archiveLoaded: false, stale: true, source: SOURCE_URL, warning: 'Showing the latest cached results.' });
    return res.status(503).json({ results: [], professions: PROFESSION_CATEGORIES, lastUpdated: null, cached: false, archiveLoaded: false, stale: false, source: SOURCE_URL, error: 'Unable to retrieve the latest PRC results.', message: error.message });
  }
});

app.get('/api/announcement-links', async (req, res) => {
  const articleUrl = normalizeUrl(req.query.url);
  const articlePath = articleUrl ? new URL(articleUrl).pathname : '';
  if (!articleUrl || !(articlePath.startsWith('/article/') || /^\/node\/\d+$/.test(articlePath))) {
    return res.status(400).json({ error: 'A valid PRC announcement URL is required.' });
  }
  const cacheControl = 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600';
  const cdnCacheControl = 'public, max-age=300, stale-while-revalidate=3600';
  const sendCachedJson = (body) => res
    .set('Cache-Control', cacheControl)
    .set('CDN-Cache-Control', cdnCacheControl)
    .set('Vercel-CDN-Cache-Control', cdnCacheControl)
    .json(body);
  const sendUncachedJson = (body) => res
    .set('Cache-Control', 'no-store')
    .set('CDN-Cache-Control', 'no-store')
    .set('Vercel-CDN-Cache-Control', 'no-store')
    .json(body);
  const cached = await getCachedAnnouncement(articleUrl);
  const hasCachedDetails = hasVerifiedAnnouncementDetails(cached?.details);
  const cachedLinksAreCurrent = cached?.linksVersion === RESOURCE_INDEX_VERSION;
  if (cachedLinksAreCurrent && cached?.resources?.length && hasCachedDetails) {
    return sendCachedJson({
      url: articleUrl,
      resources: cached.resources,
      details: cached.details,
      cached: true,
    });
  }
  if (cachedLinksAreCurrent && hasCachedDetails) {
    return sendCachedJson({ url: articleUrl, resources: cached.resources, details: cached.details, cached: true });
  }
  try {
    const announcement = await fetchAnnouncementLinks(articleUrl, { timeoutMs: 4000, retryDelays: [], curlFallback: false });
    if (cached && !announcement.resources.length) announcement.resources = cached.resources;
    if (hasCachedDetails && !hasVerifiedAnnouncementDetails(announcement.details)) announcement.details = cached.details;
    await saveAnnouncementCache(articleUrl, announcement);
    return sendCachedJson({ url: articleUrl, ...announcement, cached: false });
  } catch (error) {
    if (cached?.resources?.length || hasCachedDetails) {
      const details = hasCachedDetails ? cached.details : null;
      const body = { url: articleUrl, resources: cached.resources, details, cached: true, refreshError: true };
      return hasCachedDetails ? sendCachedJson(body) : sendUncachedJson(body);
    }
    return res.status(502).json({ error: 'Could not retrieve links from this PRC announcement.', message: error.message });
  }
});

app.post('/api/cron/announcement-link-backfill', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.get('authorization') !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized.' });
  const lockToken = randomUUID();
  try {
    const acquired = await redisCommand('SET', ANNOUNCEMENT_BACKFILL_LOCK_KEY, lockToken, 'NX', 'EX', 60);
    if (acquired !== 'OK') {
      return res.json({ urls: [], scanned: 0, skipped: true });
    }
    await restorePersistentResultCache();
    restoreBundledResultCache();
    const results = mergeResultLists(getCache()?.results || [], bundledResultSnapshot.results || []);
    if (!results.length) return res.json({ urls: [], scanned: 0 });

    const savedCursor = Number(await redisCommand('GET', ANNOUNCEMENT_BACKFILL_CURSOR_KEY));
    const start = Number.isInteger(savedCursor) && savedCursor >= 0 ? savedCursor % results.length : 0;
    const scanCount = Math.min(results.length, ANNOUNCEMENT_BACKFILL_SCAN_SIZE);
    const candidates = Array.from({ length: scanCount }, (_, offset) => results[(start + offset) % results.length]);
    const cachedValues = await redisCommand('MGET', ...candidates.map((result) => announcementCacheKey(result.url)));
    const urls = [];
    let scanned = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      scanned = index + 1;
      const articleUrl = candidates[index].url;
      let cachedAnnouncement = null;
      if (typeof cachedValues?.[index] === 'string') {
        try { cachedAnnouncement = JSON.parse(cachedValues[index]); } catch { cachedAnnouncement = null; }
      }
      if (!hasCompleteAnnouncementLinks(cachedAnnouncement)
        && !hasCompleteAnnouncementLinks(findBundledAnnouncement(articleUrl))) {
        urls.push(articleUrl);
        if (urls.length >= ANNOUNCEMENT_BACKFILL_BATCH_SIZE) break;
      }
    }
    if (urls.length < ANNOUNCEMENT_BACKFILL_BATCH_SIZE) scanned = scanCount;
    await redisCommand('SET', ANNOUNCEMENT_BACKFILL_CURSOR_KEY, String((start + scanned) % results.length));
    return res.json({ urls, scanned });
  } catch (error) {
    console.error('Could not select PRC announcement links for backfill:', error.message);
    return res.status(503).json({ error: 'Could not load the saved results archive for announcement backfill.' });
  } finally {
    if (await redisCommand('GET', ANNOUNCEMENT_BACKFILL_LOCK_KEY).catch(() => null) === lockToken) {
      await redisCommand('DEL', ANNOUNCEMENT_BACKFILL_LOCK_KEY).catch((error) => {
        console.warn('Could not release PRC announcement backfill lock:', error.message);
      });
    }
  }
});

app.post('/api/cron/cache-announcement-links', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.get('authorization') !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized.' });
  const backfillBatch = req.body?.backfill === true;
  const lockToken = typeof req.body?.lockToken === 'string' ? req.body.lockToken : '';
  if (!backfillBatch && (!lockToken || await redisCommand('GET', RESULTS_CHECK_LOCK_KEY) !== lockToken)) {
    return res.status(409).json({ error: 'The scheduled-check lock is missing or expired.' });
  }
  const announcements = Array.isArray(req.body?.announcements) ? req.body.announcements.slice(0, 20) : [];
  let saved = 0;
  for (const entry of announcements) {
    const articleUrl = normalizeUrl(entry?.url);
    const articlePath = articleUrl ? new URL(articleUrl).pathname : '';
    if (!articleUrl || !(articlePath.startsWith('/article/') || /^\/node\/\d+$/.test(articlePath)) || !Array.isArray(entry.resources)) continue;
    const resources = entry.resources.slice(0, 30).flatMap((resource) => {
      if (typeof resource?.label !== 'string' || typeof resource?.url !== 'string') return [];
      try {
        const url = new URL(resource.url);
        if (url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com', 'prc.gov.ph', 'www.prc.gov.ph'].includes(url.hostname)) return [];
        return [{ label: resource.label.slice(0, 200), url: url.href }];
      } catch {
        return [];
      }
    });
    const existing = await getCachedAnnouncement(articleUrl);
    if (!resources.length && existing?.resources?.length) resources.push(...existing.resources);
    const persisted = await saveAnnouncementCache(articleUrl, {
      resources,
      linksVersion: entry.linksVersion === RESOURCE_INDEX_VERSION ? RESOURCE_INDEX_VERSION : 1,
      details: entry.details && typeof entry.details === 'object' ? {
        summary: typeof entry.details.summary === 'string' ? entry.details.summary.slice(0, 2000) : '',
        facts: Array.isArray(entry.details.facts) ? entry.details.facts.filter((fact) => typeof fact === 'string').slice(0, 12).map((fact) => fact.slice(0, 2000)) : [],
        paragraphs: Array.isArray(entry.details.paragraphs) ? entry.details.paragraphs.filter((paragraph) => typeof paragraph === 'string').slice(0, 20).map((paragraph) => paragraph.slice(0, 3000)) : [],
        source: entry.details.source === 'prc' && entry.details.version === 2 ? 'prc' : '',
        version: entry.details.source === 'prc' && entry.details.version === 2 ? 2 : 1,
      } : { summary: '', facts: [] },
      linksVerified: entry.details?.source === 'prc' && entry.details.version === 2,
    });
    if (!persisted) return res.status(503).json({ error: 'Could not persist the PRC announcement files. The new result will be retried before publication.' });
    await attachAnnouncementDocuments(articleUrl, resources, redisCommand);
    saved += 1;
  }
  return res.json({ saved });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/result-card/:slug.png', async (req, res) => {
  const slug = String(req.params.slug || '').replace(/\.png$/i, '');
  if (!/^[a-z0-9-]{1,180}$/i.test(slug)) return res.status(400).type('text/plain').send('Invalid result slug.');
  try {
    const title = String(req.query.title || '').slice(0, 240);
    const result = title ? {
      title,
      category: String(req.query.category || 'Board Exam Result').slice(0, 80),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : '',
      description: String(req.query.summary || '').slice(0, 240),
    } : await findResultBySlug(slug);
    if (!result) return res.status(404).type('text/plain').send('Result not found.');
    const png = await getSharp()(Buffer.from(createResultCardSvg(result))).png().toBuffer();
    return res.status(200).type('png').set('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800').send(png);
  } catch (error) {
    console.error('Could not generate result share image:', error.message);
    return res.status(502).type('text/plain').send('Could not generate result preview image.');
  }
});
app.get('/results/:slug', async (req, res) => {
  try {
    const html = await fs.readFile(path.join(__dirname, '..', 'public', 'result.html'), 'utf8');
    const slug = String(req.params.slug || '');
    const canonical = `https://www.boardexamtracker.com/results/${encodeURIComponent(slug)}`;
    let result = null;
    if (/^[a-z0-9-]{1,180}$/i.test(slug)) {
      try { result = await findResultBySlug(slug); }
      catch (error) { console.warn(`Could not prepare share metadata for ${slug}:`, error.message); }
    }
    const fallbackTitle = slug.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()) || 'Board Exam Result';
    const title = result?.title || fallbackTitle;
    const description = (result?.description || 'View this Philippine board exam result and the files linked by its public announcement.').slice(0, 300);
    const imageQuery = new URLSearchParams({
      v: '3',
      title: title || fallbackTitle,
      category: result?.category || 'Board Exam Result',
      date: result?.date || '',
      summary: description,
    });
    const imageUrl = `https://www.boardexamtracker.com/api/result-card/${encodeURIComponent(slug)}.png?${imageQuery.toString()}`;
    const safeImageUrl = escapeHtml(imageUrl);
    const safeTitle = escapeHtml(`${title} | BoardExamTracker`);
    const safeDescription = escapeHtml(description);
    const schema = result ? `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: result.title,
      description,
      datePublished: result.date,
      author: { '@type': 'Organization', name: 'BoardExamTracker' },
      publisher: { '@type': 'Organization', name: 'BoardExamTracker' },
      mainEntityOfPage: canonical,
      citation: result.url,
    }).replace(/</g, '\\u003c')}</script>` : '';
    let page = html.replace(/<title>[^<]*<\/title>/, `<title>${safeTitle}</title>`);
    page = replaceMetaValue(page, /(<meta name="description" content=")[^"]*(">)/, safeDescription);
    page = replaceMetaValue(page, /(<meta property="og:title" content=")[^"]*(">)/, safeTitle);
    page = replaceMetaValue(page, /(<meta property="og:description" content=")[^"]*(">)/, safeDescription);
    page = replaceMetaValue(page, /(<meta property="og:url" content=")[^"]*(">)/, canonical);
    page = replaceMetaValue(page, /(<meta property="og:image" content=")[^"]*(">)/, safeImageUrl);
    page = replaceMetaValue(page, /(<meta property="og:image:alt" content=")[^"]*(">)/, escapeHtml(`Preview image for ${title}`));
    page = replaceMetaValue(page, /(<meta name="twitter:title" content=")[^"]*(">)/, safeTitle);
    page = replaceMetaValue(page, /(<meta name="twitter:description" content=")[^"]*(">)/, safeDescription);
    page = replaceMetaValue(page, /(<meta name="twitter:image" content=")[^"]*(">)/, safeImageUrl);
    page = page.replace('</head>', `${schema}</head>`);
    res.type('html').send(page);
  } catch {
    res.status(500).type('text/plain').send('Could not load the result page.');
  }
});
if (require.main === module) {
  app.listen(port, () => {
    console.log(`BoardExamTracker listening on http://localhost:${port}`);
    refresh().catch((error) => console.warn('Initial PRC refresh failed:', error.message));
    const refreshTimer = setInterval(() => {
      refresh().catch((error) => console.warn('Scheduled PRC refresh failed:', error.message));
    }, AUTO_REFRESH_MS);
    refreshTimer.unref();
  });
}

module.exports = app;
