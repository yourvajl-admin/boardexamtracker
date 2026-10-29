require('./env').loadLocalEnv();

const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fetchResults, fetchAnnouncementLinks, normalizeUrl, SOURCE_URL, PROFESSION_CATEGORIES } = require('./scraper');
const bundledResultSnapshot = require('./fallback-results.json');
const bundledAnnouncementLinks = require('./fallback-announcement-links.json');
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
      return { ...value, fetchedAt: 0, bundled: true };
    }
  }
  return null;
}

async function getCachedAnnouncement(articleUrl) {
  const bundledValue = findBundledAnnouncement(articleUrl);
  const memoryValue = announcementCache.get(articleUrl);
  const memoryTtl = memoryValue?.resources?.length ? 30 * 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  if (memoryValue && Date.now() - memoryValue.fetchedAt < memoryTtl) {
    return memoryValue.resources?.length ? memoryValue : bundledValue || memoryValue;
  }
  if (!isPersistentStorageConfigured()) return bundledValue;
  try {
    const saved = await redisCommand('GET', announcementCacheKey(articleUrl));
    if (typeof saved !== 'string') return bundledValue;
    const value = JSON.parse(saved);
    if (!Array.isArray(value.resources) || !Number.isFinite(value.fetchedAt)) return bundledValue;
    const ttl = value.resources.length ? 30 * 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
    if (Date.now() - value.fetchedAt >= ttl) return bundledValue;
    if (!value.resources.length && bundledValue) return bundledValue;
    announcementCache.set(articleUrl, value);
    return value;
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
    const ttl = cached.resources?.length ? 60 * 60 * 24 * 30 : 60 * 60 * 6;
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
    if (!cached || !cached.resources?.length || cached.details?.source !== 'prc' || cached.details?.version !== 2 || !cached.details.summary || !Array.isArray(cached.details.facts)) missing.push(articleUrl);
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

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const isCronPayload = req.method === 'POST' && ['/api/cron/check-results', '/api/cron/cache-announcement-links', '/api/cron/check-status'].includes(req.path);
  const isBlogWrite = ['POST', 'PUT'].includes(req.method) && req.path.startsWith('/api/admin/blog/posts');
  const limit = isCronPayload ? '1mb' : isBlogWrite ? '2mb' : '10kb';
  return express.json({ limit })(req, res, next);
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
    const migration = await migrateLegacySubscribers();
    const subscribers = await listSubscribersForAdmin();
    return res.json({ subscribers, migration, persistentStorage: isPersistentStorageConfigured(), production: process.env.NODE_ENV === 'production' });
  } catch (error) {
    console.error('Could not load admin subscriber list:', error.message);
    return res.status(503).json({ error: 'Subscriber storage is unavailable. Check the private storage settings.' });
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
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[-!#$%&'*+/0-9=?A-Z^_`{|}~.]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!isEmailConfigured()) return res.status(503).json({ error: 'Email sending is not configured.' });

  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (adminResultEmailAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 60 * 60 * 1000);
  if (recent.length >= 3) return res.status(429).json({ error: 'Send limit reached. Try again later.' });
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
    await sendResultAlert({ email }, [latest]);
    return res.json({ sent: true, title: latest.title });
  } catch (error) {
    console.error('Email provider failed to send latest-result alert:', error.message);
    return res.status(502).json({ error: emailProviderFailureMessage(error) });
  }
});
const adminResendAttempts = new Map();
app.post('/api/admin/subscribers/resend-alert', requireAdmin, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[-!#$%&'*+/0-9=?A-Z^_`{|}~.]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid subscriber email.' });
  }
  if (!isEmailConfigured()) return res.status(503).json({ error: 'Email sending is not configured.' });
  if (!isPersistentStorageConfigured()) {
    return res.status(503).json({ error: 'Configure Upstash Redis REST credentials to resend alerts.' });
  }

  try {
    const subscriber = (await listConfirmedSubscribers()).find((item) => item.email === email);
    if (!subscriber) return res.status(404).json({ error: 'No confirmed subscriber was found for this email.' });

    const lastSentAt = adminResendAttempts.get(email) || 0;
    if (Date.now() - lastSentAt < 60_000) {
      return res.status(429).json({ error: 'An alert was just sent to this subscriber. Wait one minute before resending.' });
    }

    const latest = await getLatestAvailableResult();
    if (!latest) return res.status(503).json({ error: 'No current result announcement with a valid official source is available to send.' });

    try {
      await sendResultAlert(subscriber, [latest], { resend: true });
    } catch (error) {
      console.error('Email provider failed to resend latest-result alert:', error.message);
      return res.status(502).json({ error: emailProviderFailureMessage(error) });
    }
    adminResendAttempts.set(email, Date.now());
    return res.json({ sent: true, title: latest.title });
  } catch (error) {
    console.error('Could not prepare latest-result resend:', error.message);
    return res.status(503).json({ error: 'Could not load the latest result from PRC or the saved result snapshot. Try again later.' });
  }
});
app.post('/api/admin/subscribers/unsubscribe', requireAdmin, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[-!#$%&'*+/0-9=?A-Z^_`{|}~.]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid subscriber email.' });
  }
  if (!isPersistentStorageConfigured()) {
    return res.status(503).json({ error: 'Configure Upstash Redis REST credentials for subscriber management.' });
  }
  try {
    const removed = await removeSubscriberByEmail(email);
    return removed ? res.json({ removed: true }) : res.status(404).json({ error: 'Subscriber not found.' });
  } catch (error) {
    console.error('Could not manually unsubscribe subscriber:', error.message);
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
  const subscribers = await listConfirmedSubscribers();
  if (!subscribers.length) return { recipients: 0, failed: 0 };
  const failureStatuses = {};
  let failures = 0;
  for (const [index, subscriber] of subscribers.entries()) {
    try {
      await sendUndeliveredResultAlert(subscriber, results, {
        redisCommand,
        send: (target, items, options) => sendResultAlert(target, items, options),
      });
    } catch (lastError) {
      failures += 1;
      const status = /^Email provider returned (\d{3}):/.exec(lastError?.message || '')?.[1] || 'network';
      failureStatuses[status] = (failureStatuses[status] || 0) + 1;
    }
    if (index < subscribers.length - 1) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  if (failures) console.error(`Email delivery failed for ${failures} subscriber(s): ${JSON.stringify(failureStatuses)}.`);
  return { recipients: subscribers.length, failed: failures, failureStatuses };
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

app.get('/api/notifications/status', (_req, res) => {
  const emailReady = isEmailConfigured();
  const persistentStorageReady = isPersistentStorageConfigured();
  res.json({
    available: emailReady && persistentStorageReady,
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
    try { await saveResultsCheckStatus({ state: 'error', lastAttemptAt: new Date().toISOString(), lastError: String(error.message || 'Check failed.').slice(0, 1200) }); } catch { /* Preserve the original failure if status storage is also down. */ }
    return res.status(502).json({ error: 'Scheduled PRC result check failed.' });
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
  if (!/^[-!#$%&'*+/0-9=?A-Z^_`{|}~.]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!allowEmailAttempt(req)) return res.status(429).json({ error: 'Too many signup attempts. Please try again later.' });
  if (!isEmailConfigured()) return res.status(503).json({ error: 'Email alerts are not configured on this server yet.' });

  try {
    if (!isPersistentStorageConfigured()) {
      return res.status(503).json({ error: 'Email alerts require Upstash Redis REST credentials for subscriber storage.' });
    }
    const subscription = await addPendingSubscriber(email);
    if (subscription.status === 'subscribed') return res.json({ message: 'This email is already subscribed to result alerts.' });
    if (subscription.status === 'pending') return res.json({ message: 'Check your inbox for the confirmation email.' });
    const confirmationUrl = `${publicBaseUrl()}/api/email/confirm?token=${encodeURIComponent(subscription.token)}`;
    await sendEmail({
      to: email,
      subject: 'Confirm your BoardExamTracker email alerts',
      html: `<div style="font-family:Arial,sans-serif;color:#172b46;line-height:1.6"><h1 style="font-size:22px">Confirm your email alerts</h1><p>Click below to confirm you want to receive email when new PRC exam result announcements are found.</p><p><a href="${escapeEmailHtml(confirmationUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#2563a9;color:white;text-decoration:none;font-weight:bold">Confirm email alerts</a></p><p>If you did not request these alerts, you can ignore this email.</p></div>`,
      text: `Confirm email alerts for BoardExamTracker by opening: ${confirmationUrl}\n\nIf you did not request these alerts, ignore this email.`,
    });
    await markConfirmationSent(subscription.token);
    return res.json({ message: 'Check your inbox for a confirmation email to activate alerts.' });
  } catch (error) {
    console.error('Could not process email alert signup:', error.message);
    return res.status(502).json({ error: 'We could not send the confirmation email. Please try again later.' });
  }
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
  const hasCachedDetails = cached?.details?.source === 'prc'
    && cached.details.version === 2
    && typeof cached.details.summary === 'string'
    && Boolean(cached.details.summary)
    && Array.isArray(cached.details.facts);
  if (cached?.resources?.length && hasCachedDetails) {
    return sendCachedJson({ url: articleUrl, resources: cached.resources, details: cached.details, cached: true });
  }
  try {
    const announcement = await fetchAnnouncementLinks(articleUrl, { timeoutMs: 4000, retryDelays: [], curlFallback: false });
    if (cached && !announcement.resources.length) announcement.resources = cached.resources;
    await saveAnnouncementCache(articleUrl, announcement);
    return sendCachedJson({ url: articleUrl, ...announcement, cached: false });
  } catch (error) {
    if (cached?.resources?.length) {
      const details = hasCachedDetails ? cached.details : null;
      const body = { url: articleUrl, resources: cached.resources, details, cached: true, refreshError: true };
      return hasCachedDetails ? sendCachedJson(body) : sendUncachedJson(body);
    }
    return res.status(502).json({ error: 'Could not retrieve links from this PRC announcement.', message: error.message });
  }
});

app.post('/api/cron/cache-announcement-links', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.get('authorization') !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized.' });
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
      details: entry.details && typeof entry.details === 'object' ? {
        summary: typeof entry.details.summary === 'string' ? entry.details.summary.slice(0, 2000) : '',
        facts: Array.isArray(entry.details.facts) ? entry.details.facts.filter((fact) => typeof fact === 'string').slice(0, 12).map((fact) => fact.slice(0, 2000)) : [],
        paragraphs: Array.isArray(entry.details.paragraphs) ? entry.details.paragraphs.filter((paragraph) => typeof paragraph === 'string').slice(0, 20).map((paragraph) => paragraph.slice(0, 3000)) : [],
        source: entry.details.source === 'prc' && entry.details.version === 2 ? 'prc' : '',
        version: entry.details.source === 'prc' && entry.details.version === 2 ? 2 : 1,
      } : { summary: '', facts: [] },
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
