require('./env').loadLocalEnv();

const express = require('express');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { fetchResults, fetchAnnouncementLinks, normalizeUrl, SOURCE_URL, PROFESSION_CATEGORIES } = require('./scraper');
const { getCache, setCache, isFresh } = require('./cache');
const { isEmailConfigured, sendEmail } = require('./email');
const { adminConfig, authenticate, clearSessionCookie, createSession, isAuthenticated, setSessionCookie } = require('./admin-auth');
const { getActiveViewerCount, recordViewerHeartbeat } = require('./viewers');
const {
  addPendingSubscriber,
  confirmSubscriber,
  isPersistentStorageConfigured,
  listConfirmedSubscribers,
  listSubscribersForAdmin,
  markConfirmationSent,
  removeSubscriber,
  removeSubscriberByEmail,
  redisCommand,
} = require('./subscriptions');

const app = express();
const port = Number(process.env.PORT) || 3000;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const INITIAL_RESULTS_LIMIT = 12;
const SHARE_FONT_REGULAR = readFileSync(path.join(__dirname, '..', 'public', 'fonts', 'dm-sans-400.woff2')).toString('base64');
const SHARE_FONT_BOLD = readFileSync(path.join(__dirname, '..', 'public', 'fonts', 'dm-sans-700.woff2')).toString('base64');
const KNOWN_RESULTS_KEY = 'boardexamtracker:known-results';
const RESULTS_CHECK_LOCK_KEY = 'boardexamtracker:results-check-lock';
const ADSENSE_ENABLED_KEY = 'boardexamtracker:ads-enabled';
let pendingFetch = null;
let pendingArchiveFetch = null;
let archiveCacheLoaded = false;
const announcementCache = new Map();
let localAdsEnabled = null;
let recentResultIndex = null;
let recentResultIndexFetchedAt = 0;
let recentResultIndexPromise = null;
let fullResultIndex = null;
let fullResultIndexFetchedAt = 0;
let fullResultIndexPromise = null;
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.get('/sitemap.xml', async (_req, res) => {
  try {
    const cached = isFresh() ? getCache() : null;
    const latest = cached?.results?.length ? cached : { results: await fetchResults({ maxPage: 0 }) };
    const urls = [
      '<url><loc>https://www.boardexamtracker.com/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>',
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
  let enabled = localAdsEnabled ?? base.defaultEnabled;
  try {
    if (isPersistentStorageConfigured()) {
      const saved = await redisCommand('GET', ADSENSE_ENABLED_KEY);
      if (saved === 'true' || saved === 'false') enabled = saved === 'true';
    } else if (process.env.NODE_ENV === 'production') {
      enabled = false;
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
  if (isPersistentStorageConfigured()) {
    try {
      await redisCommand('SET', ADSENSE_ENABLED_KEY, String(req.body.enabled));
    } catch (error) {
      console.error('Could not save AdSense display setting:', error.message);
      return res.status(503).json({ error: 'Could not save the ads setting. Check the shared storage connection and try again.' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    return res.status(503).json({ error: 'Shared Upstash Redis storage is required to persist the ads setting in production.' });
  } else {
    localAdsEnabled = req.body.enabled;
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
    const subscribers = await listSubscribersForAdmin();
    return res.json({ subscribers, persistentStorage: isPersistentStorageConfigured(), production: process.env.NODE_ENV === 'production' });
  } catch (error) {
    console.error('Could not load admin subscriber list:', error.message);
    return res.status(503).json({ error: 'Subscriber storage is unavailable. Check the private storage settings.' });
  }
});
const adminTestEmailAttempts = new Map();
app.post('/api/admin/test-latest-result', requireAdmin, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[-!#$%&'*+/0-9=?A-Z^_`{|}~.]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!isEmailConfigured()) return res.status(503).json({ error: 'Email sending is not configured.' });

  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (adminTestEmailAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 60 * 60 * 1000);
  if (recent.length >= 3) return res.status(429).json({ error: 'Test email limit reached. Try again later.' });
  recent.push(now);
  adminTestEmailAttempts.set(ip, recent);

  try {
    let results;
    try {
      results = await fetchResults({ maxPage: 2 });
    } catch (error) {
      const cached = getCache();
      if (!cached?.results?.length) throw error;
      results = cached.results;
    }
    const latest = results
      .filter((result) => result?.title && result?.date && normalizeUrl(result.url))
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!latest) return res.status(503).json({ error: 'No current result announcement is available to send.' });

    const officialUrl = normalizeUrl(latest.url);
    if (!officialUrl || !['www.prc.gov.ph', 'prc.gov.ph'].includes(new URL(officialUrl).hostname)) {
      return res.status(503).json({ error: 'The latest result does not have a valid official PRC link.' });
    }
    const resultUrl = boardResultPageUrl(publicBaseUrl(), latest);
    const title = escapeEmailHtml(latest.title);
    const date = escapeEmailHtml(latest.date);
    const description = escapeEmailHtml(latest.description || 'A new examination result announcement is available from the official source.');
    await sendEmail({
      to: email,
      subject: `Test alert: ${String(latest.title).replace(/[\r\n]+/g, ' ').slice(0, 180)}`,
      html: `<div style="font-family:Arial,sans-serif;color:#172b46;line-height:1.6"><p style="color:#2563a9;font-weight:bold">BoardExamTracker · Test email</p><h1 style="font-size:22px">${title}</h1><p><strong>Release date:</strong> ${date}</p><p>${description}</p><p><a href="${escapeEmailHtml(resultUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#2563a9;color:white;text-decoration:none;font-weight:bold">View result on BoardExamTracker</a></p><p style="font-size:12px;color:#718097">The official PRC source is available from the result page. This is a one-time test sent only to the address you entered. BoardExamTracker is independent and is not affiliated with PRC.</p></div>`,
      text: `BoardExamTracker test email\n\n${latest.title}\nRelease date: ${latest.date}\n\n${latest.description || 'A new examination result announcement is available from the official source.'}\n\nView this result on BoardExamTracker: ${resultUrl}\n\nThe official PRC source is available from the result page. This test was sent only to the address you entered.`,
    });
    return res.json({ sent: true, title: latest.title });
  } catch (error) {
    console.error('Could not send latest-result test email:', error.message);
    return res.status(502).json({ error: 'Could not send the test email. Check the email provider logs and try again.' });
  }
});
const adminResendAttempts = new Map();
app.post('/api/admin/subscribers/resend-alert', requireAdmin, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[-!#$%&'*+/0-9=?A-Z^_`{|}~.]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid subscriber email.' });
  }
  if (!isEmailConfigured()) return res.status(503).json({ error: 'Email sending is not configured.' });
  if (process.env.NODE_ENV === 'production' && !isPersistentStorageConfigured()) {
    return res.status(503).json({ error: 'Persistent subscriber storage is required to resend alerts.' });
  }

  try {
    const subscriber = (await listConfirmedSubscribers()).find((item) => item.email === email);
    if (!subscriber) return res.status(404).json({ error: 'No confirmed subscriber was found for this email.' });

    const lastSentAt = adminResendAttempts.get(email) || 0;
    if (Date.now() - lastSentAt < 60_000) {
      return res.status(429).json({ error: 'An alert was just sent to this subscriber. Wait one minute before resending.' });
    }

    let results;
    try {
      results = await fetchResults({ maxPage: 2 });
    } catch (error) {
      const cached = getCache();
      if (!cached?.results?.length) throw error;
      results = cached.results;
    }
    const latest = results
      .filter((result) => result?.title && result?.date && normalizeUrl(result.url))
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    const officialUrl = latest && normalizeUrl(latest.url);
    if (!latest || !officialUrl || !['www.prc.gov.ph', 'prc.gov.ph'].includes(new URL(officialUrl).hostname)) {
      return res.status(503).json({ error: 'No current result announcement with a valid official source is available to send.' });
    }

    await sendResultAlert(subscriber, [latest], { resend: true });
    adminResendAttempts.set(email, Date.now());
    return res.json({ sent: true, title: latest.title });
  } catch (error) {
    console.error('Could not resend latest-result alert:', error.message);
    return res.status(502).json({ error: 'Could not resend the alert. Check the email provider logs and try again.' });
  }
});
app.post('/api/admin/subscribers/unsubscribe', requireAdmin, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[-!#$%&'*+/0-9=?A-Z^_`{|}~.]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid subscriber email.' });
  }
  if (process.env.NODE_ENV === 'production' && !isPersistentStorageConfigured()) {
    return res.status(503).json({ error: 'Persistent subscriber storage is required for admin changes in production.' });
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
  for (const result of lists.flat()) merged.set(result.url, result);
  return [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
}

async function refresh() {
  if (!pendingFetch) {
    pendingFetch = fetchResults({ maxPage: 2 })
      .then((latest) => setCache(mergeResultLists(getCache()?.results || [], latest)))
      .finally(() => { pendingFetch = null; });
  }
  return pendingFetch;
}

async function loadArchiveResults() {
  const cached = getCache();
  if (archiveCacheLoaded && cached && !cached.stale) return cached;
  if (!pendingArchiveFetch) {
    pendingArchiveFetch = fetchResults()
      .then((archive) => {
        archiveCacheLoaded = true;
        return setCache(mergeResultLists(getCache()?.results || [], archive));
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

function escapeSvg(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
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

function svgTextLines(lines, { x, y, size, lineHeight, color, weight = 400 }) {
  return lines.map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" fill="${color}" font-size="${size}" font-weight="${weight}">${escapeSvg(line)}</text>`).join('');
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
    <style>@font-face{font-family:'DM Sans';font-style:normal;font-weight:400;src:url(data:font/woff2;base64,${SHARE_FONT_REGULAR}) format('woff2')}@font-face{font-family:'DM Sans';font-style:normal;font-weight:700;src:url(data:font/woff2;base64,${SHARE_FONT_BOLD}) format('woff2')}</style>
    <rect width="1200" height="630" fill="#101b2c"/>
    <circle cx="1080" cy="80" r="120" fill="#173452" opacity=".55"/><circle cx="1110" cy="40" r="42" fill="#1d4365" opacity=".5"/>
    <rect x="64" y="48" width="48" height="48" rx="14" fill="#1d4365"/><path d="m77 72 9 9 16-19" fill="none" stroke="#78d6b5" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="128" y="81" fill="#ffffff" font-size="27" font-family="DM Sans, Arial, sans-serif" font-weight="700">BoardExamTracker</text>
    <rect x="835" y="54" width="301" height="38" rx="19" fill="#153b38"/><circle cx="859" cy="73" r="5" fill="#77d9b8"/><text x="875" y="79" fill="#83e0c2" font-size="14" font-family="DM Sans, Arial, sans-serif" font-weight="700" letter-spacing="1.2">PHILIPPINE BOARD EXAM RESULT</text>
    <text x="64" y="151" fill="#73b6ee" font-size="16" font-family="DM Sans, Arial, sans-serif" font-weight="700" letter-spacing="4">BOARD EXAM RESULT</text>
    <rect x="64" y="174" width="${tagWidth}" height="39" rx="8" fill="#203e5b"/><text x="80" y="200" fill="#bfddfa" font-size="15" font-family="DM Sans, Arial, sans-serif" font-weight="700" letter-spacing="1">${escapeSvg(category)}</text>
    ${svgTextLines(title, { x: 64, y: 278, size: 38, lineHeight: 46, color: '#edf3fb', weight: 700 })}
    <text x="64" y="444" fill="#9eb0c6" font-size="19" font-family="DM Sans, Arial, sans-serif" font-weight="700">${escapeSvg(date)}</text>
    ${svgTextLines(summary, { x: 64, y: 496, size: 22, lineHeight: 30, color: '#d1dce9' })}
    <rect x="64" y="559" width="1072" height="42" rx="11" fill="#153a35"/><circle cx="85" cy="580" r="8" fill="#63cfaa"/><text x="104" y="586" fill="#c8e7dd" font-size="15" font-family="DM Sans, Arial, sans-serif">Independent results guide · Source: PRC.gov.ph</text><text x="958" y="586" fill="#c8e7dd" font-size="15" font-family="DM Sans, Arial, sans-serif">boardexamtracker.com</text>
  </svg>`;
}

async function notifySubscribers(results) {
  const subscribers = await listConfirmedSubscribers();
  if (!subscribers.length) return { recipients: 0, failed: 0 };
  const deliveries = await Promise.allSettled(subscribers.map((subscriber) => sendResultAlert(subscriber, results)));
  const failures = deliveries.filter((delivery) => delivery.status === 'rejected').length;
  if (failures) console.error(`Email delivery failed for ${failures} subscriber(s).`);
  return { recipients: subscribers.length, failed: failures };
}

async function sendResultAlert(subscriber, results, { resend = false } = {}) {
  const baseUrl = publicBaseUrl();
  const itemHtml = results.slice(0, 30).map((result) => `<li><a href="${escapeEmailHtml(boardResultPageUrl(baseUrl, result))}">${escapeEmailHtml(result.title)}</a> <span>— ${escapeEmailHtml(result.date)}</span></li>`).join('');
  const itemText = results.slice(0, 30).map((result) => `- ${result.title} (${result.date})\n  ${boardResultPageUrl(baseUrl, result)}`).join('\n');
  const unsubscribeUrl = `${baseUrl}/api/email/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribeToken)}`;
  const heading = resend ? 'Your requested board exam result reminder' : `New board exam ${results.length === 1 ? 'result' : 'results'} are available`;
  const intro = resend
    ? 'An administrator resent the latest result alert to you. You can review it on BoardExamTracker.'
    : `BoardExamTracker found ${results.length} new announcement${results.length === 1 ? '' : 's'} in the public PRC Exam Results feed.`;
  await sendEmail({
    to: subscriber.email,
    subject: resend ? `Reminder: latest board exam result on BoardExamTracker` : `${results.length} new PRC exam ${results.length === 1 ? 'result' : 'results'} on BoardExamTracker`,
    html: `<div style="font-family:Arial,sans-serif;color:#172b46;line-height:1.6"><h1 style="font-size:22px">${escapeEmailHtml(heading)}</h1><p>${escapeEmailHtml(intro)}</p><ul>${itemHtml}</ul><p><a href="${escapeEmailHtml(baseUrl)}">View BoardExamTracker</a></p><hr><p style="font-size:12px;color:#718097">Independent tracker; not affiliated with PRC. <a href="${escapeEmailHtml(unsubscribeUrl)}">Unsubscribe from these emails</a>.</p></div>`,
    text: `${heading}\n\n${intro}\n\n${itemText}\n\nUnsubscribe: ${unsubscribeUrl}`,
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
  const persistentStorageReady = process.env.NODE_ENV !== 'production' || isPersistentStorageConfigured();
  res.json({
    available: emailReady && persistentStorageReady,
    reason: !emailReady ? 'email' : !persistentStorageReady ? 'storage' : null,
  });
});

app.get('/api/cron/check-results', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.get('authorization') !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  if (!isPersistentStorageConfigured()) return res.status(503).json({ error: 'Persistent result tracking is not configured.' });
  if (!isEmailConfigured()) return res.status(503).json({ error: 'Email sending is not configured.' });

  try {
    const lock = await redisCommand('SET', RESULTS_CHECK_LOCK_KEY, randomUUID(), 'NX', 'EX', 240);
    if (lock !== 'OK') return res.json({ skipped: true, reason: 'A result check is already running.' });

    const latest = (await fetchResults({ maxPage: 2 }))
      .filter((result) => result?.title && result?.date && normalizeUrl(result.url))
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!latest.length) return res.status(502).json({ error: 'No results could be read from the official PRC page.' });

    const saved = await redisCommand('GET', KNOWN_RESULTS_KEY);
    if (typeof saved !== 'string') {
      await redisCommand('SET', KNOWN_RESULTS_KEY, JSON.stringify(latest.map((result) => result.url).slice(0, 500)));
      setCache(mergeResultLists(getCache()?.results || [], latest));
      return res.json({ initialized: true, newResults: 0, message: 'Saved current results as the notification baseline.' });
    }

    let knownUrls;
    try {
      const decoded = JSON.parse(saved);
      if (!Array.isArray(decoded) || decoded.some((url) => typeof url !== 'string')) throw new Error('Invalid notification baseline.');
      knownUrls = new Set(decoded);
    } catch {
      await redisCommand('SET', KNOWN_RESULTS_KEY, JSON.stringify(latest.map((result) => result.url).slice(0, 500)));
      setCache(mergeResultLists(getCache()?.results || [], latest));
      return res.json({ initialized: true, newResults: 0, message: 'Rebuilt the notification baseline.' });
    }
    const newResults = latest.filter((result) => !knownUrls.has(result.url));
    if (newResults.length) {
      // Pause ads whenever the official feed adds a result so an admin can
      // review the page before manually enabling the placement again.
      await redisCommand('SET', ADSENSE_ENABLED_KEY, 'false');
    }
    const delivery = newResults.length ? await notifySubscribers(newResults) : { recipients: 0, failed: 0 };
    if (delivery.failed) return res.status(502).json({ error: 'Some result-alert emails failed. The check will retry on its next scheduled run.' });
    const mergedUrls = [...new Set([...latest.map((result) => result.url), ...knownUrls])].slice(0, 500);
    await redisCommand('SET', KNOWN_RESULTS_KEY, JSON.stringify(mergedUrls));
    setCache(mergeResultLists(getCache()?.results || [], latest));
    return res.json({ initialized: false, newResults: newResults.length, recipients: delivery.recipients, failed: delivery.failed });
  } catch (error) {
    console.error('Scheduled PRC result check failed:', error.message);
    return res.status(502).json({ error: 'Scheduled PRC result check failed.' });
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
    if (process.env.NODE_ENV === 'production' && !isPersistentStorageConfigured()) {
      return res.status(503).json({ error: 'Email alerts are temporarily unavailable while persistent subscriber storage is configured.' });
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
  if (req.query.archive === 'true') {
    try {
      const value = await loadArchiveResults();
      return res.json({ results: value.results, professions: PROFESSION_CATEGORIES, lastUpdated: new Date(value.fetchedAt).toISOString(), cached: archiveCacheLoaded, archiveLoaded: true, stale: false, source: SOURCE_URL });
    } catch (error) {
      const cached = getCache();
      if (cached) return res.status(200).json({ results: cached.results, professions: PROFESSION_CATEGORIES, lastUpdated: new Date(cached.fetchedAt).toISOString(), cached: true, archiveLoaded: false, stale: true, source: SOURCE_URL, warning: 'Showing the latest cached results. Older results could not be loaded.' });
      return res.status(503).json({ results: [], professions: PROFESSION_CATEGORIES, lastUpdated: null, cached: false, archiveLoaded: false, stale: false, source: SOURCE_URL, error: 'Unable to retrieve older PRC results.', message: error.message });
    }
  }
  const force = req.query.refresh === 'true';
  if (!force && isFresh()) {
    const cached = getCache();
    return res.json({ results: cached.results.slice(0, INITIAL_RESULTS_LIMIT), professions: PROFESSION_CATEGORIES, lastUpdated: new Date(cached.fetchedAt).toISOString(), cached: true, archiveLoaded: false, stale: false, source: SOURCE_URL });
  }
  try {
    const value = await refresh();
    return res.json({ results: value.results.slice(0, INITIAL_RESULTS_LIMIT), professions: PROFESSION_CATEGORIES, lastUpdated: new Date(value.fetchedAt).toISOString(), cached: false, archiveLoaded: false, stale: false, source: SOURCE_URL });
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
  const cached = announcementCache.get(articleUrl);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
    return res.json({ url: articleUrl, resources: cached.resources, details: cached.details, cached: true });
  }
  try {
    const announcement = await fetchAnnouncementLinks(articleUrl);
    announcementCache.set(articleUrl, { ...announcement, fetchedAt: Date.now() });
    return res.json({ url: articleUrl, ...announcement, cached: false });
  } catch (error) {
    return res.status(502).json({ error: 'Could not retrieve links from this PRC announcement.', message: error.message });
  }
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
    const png = await sharp(Buffer.from(createResultCardSvg(result))).png().toBuffer();
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
