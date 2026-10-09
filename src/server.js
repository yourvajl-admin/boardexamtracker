require('./env').loadLocalEnv();

const express = require('express');
const path = require('node:path');
const { fetchResults, fetchAnnouncementLinks, normalizeUrl, SOURCE_URL, PROFESSION_CATEGORIES } = require('./scraper');
const { getCache, setCache, isFresh } = require('./cache');
const { isEmailConfigured, sendEmail } = require('./email');
const {
  addPendingSubscriber,
  confirmSubscriber,
  listConfirmedSubscribers,
  markConfirmationSent,
  removeSubscriber,
} = require('./subscriptions');

const app = express();
const port = Number(process.env.PORT) || 3000;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let pendingFetch = null;
const announcementCache = new Map();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: 0,
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(html|css|js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

function getAdSenseConfig() {
  const clientId = process.env.ADSENSE_CLIENT_ID || '';
  const resultsSlot = process.env.ADSENSE_SLOT_ID_RESULTS || '';
  const validClientId = /^ca-pub-\d+$/.test(clientId);
  const validSlot = /^\d+$/.test(resultsSlot);
  const enabled = validClientId && validSlot && process.env.ADSENSE_ENABLED === 'true' && process.env.NODE_ENV === 'production';
  return { enabled, clientId: validClientId ? clientId : null, resultsSlot: validSlot ? resultsSlot : null };
}

app.get('/api/adsense-config', (_req, res) => res.json(getAdSenseConfig()));
app.get('/ads.txt', (_req, res) => {
  const clientId = process.env.ADSENSE_CLIENT_ID || '';
  if (!/^ca-pub-\d+$/.test(clientId)) return res.status(404).type('text/plain').send('');
  const publisherId = clientId.replace(/^ca-/, '');
  return res.type('text/plain').send(`google.com, ${publisherId}, DIRECT, f08c47fec0942fa0\n`);
});

async function refresh() {
  if (!pendingFetch) {
    const cached = getCache();
    const options = cached ? { maxPage: 2 } : {};
    pendingFetch = fetchResults(options)
      .then((latest) => {
        if (!cached) return setCache(latest);
        const knownUrls = new Set(cached.results.map((result) => result.url));
        const newResults = latest.filter((result) => !knownUrls.has(result.url));
        const merged = new Map([...latest, ...cached.results].map((result) => [result.url, result]));
        const updated = setCache([...merged.values()].sort((a, b) => b.date.localeCompare(a.date)));
        if (newResults.length) notifySubscribers(newResults).catch((error) => console.error('Could not send new-result email alerts:', error.message));
        return updated;
      })
      .finally(() => { pendingFetch = null; });
  }
  return pendingFetch;
}

function escapeEmailHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function publicBaseUrl() {
  return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
}

async function notifySubscribers(results) {
  const subscribers = listConfirmedSubscribers();
  if (!subscribers.length) return;
  const baseUrl = publicBaseUrl();
  const itemHtml = results.slice(0, 30).map((result) => `<li><a href="${escapeEmailHtml(result.url)}">${escapeEmailHtml(result.title)}</a> <span>— ${escapeEmailHtml(result.date)}</span></li>`).join('');
  const itemText = results.slice(0, 30).map((result) => `- ${result.title} (${result.date})\n  ${result.url}`).join('\n');
  const deliveries = await Promise.allSettled(subscribers.map(async (subscriber) => {
    const unsubscribeUrl = `${baseUrl}/api/email/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribeToken)}`;
    await sendEmail({
      to: subscriber.email,
      subject: `${results.length} new PRC exam ${results.length === 1 ? 'result' : 'results'} on BoardExamTracker`,
      html: `<div style="font-family:Arial,sans-serif;color:#172b46;line-height:1.6"><h1 style="font-size:22px">New board exam ${results.length === 1 ? 'result' : 'results'} are available</h1><p>BoardExamTracker found ${results.length} new announcement${results.length === 1 ? '' : 's'} in the public PRC Exam Results feed.</p><ul>${itemHtml}</ul><p><a href="${escapeEmailHtml(baseUrl)}">View BoardExamTracker</a></p><hr><p style="font-size:12px;color:#718097">Independent tracker; not affiliated with PRC. <a href="${escapeEmailHtml(unsubscribeUrl)}">Unsubscribe from these emails</a>.</p></div>`,
      text: `New PRC exam ${results.length === 1 ? 'result' : 'results'} are available on BoardExamTracker.\n\n${itemText}\n\nUnsubscribe: ${unsubscribeUrl}`,
    });
  }));
  const failures = deliveries.filter((delivery) => delivery.status === 'rejected').length;
  if (failures) console.error(`Email delivery failed for ${failures} subscriber(s).`);
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

app.get('/api/notifications/status', (_req, res) => res.json({ available: isEmailConfigured() }));

app.post('/api/notifications/subscribe', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[-!#$%&'*+/0-9=?A-Z^_`{|}~.]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!allowEmailAttempt(req)) return res.status(429).json({ error: 'Too many signup attempts. Please try again later.' });
  if (!isEmailConfigured()) return res.status(503).json({ error: 'Email alerts are not configured on this server yet.' });

  try {
    const subscription = addPendingSubscriber(email);
    if (subscription.status === 'subscribed') return res.json({ message: 'This email is already subscribed to result alerts.' });
    if (subscription.status === 'pending') return res.json({ message: 'Check your inbox for the confirmation email.' });
    const confirmationUrl = `${publicBaseUrl()}/api/email/confirm?token=${encodeURIComponent(subscription.token)}`;
    await sendEmail({
      to: email,
      subject: 'Confirm your BoardExamTracker email alerts',
      html: `<div style="font-family:Arial,sans-serif;color:#172b46;line-height:1.6"><h1 style="font-size:22px">Confirm your email alerts</h1><p>Click below to confirm you want to receive email when new PRC exam result announcements are found.</p><p><a href="${escapeEmailHtml(confirmationUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#2563a9;color:white;text-decoration:none;font-weight:bold">Confirm email alerts</a></p><p>If you did not request these alerts, you can ignore this email.</p></div>`,
      text: `Confirm email alerts for BoardExamTracker by opening: ${confirmationUrl}\n\nIf you did not request these alerts, ignore this email.`,
    });
    markConfirmationSent(subscription.token);
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

app.post('/api/email/confirm', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  const token = String(req.body?.token || '');
  const confirmed = /^[a-f0-9]{64}$/.test(token) && confirmSubscriber(token);
  emailResultPage(res, confirmed ? 'Email alerts activated' : 'Confirmation link expired', confirmed ? 'You will receive an email when new PRC exam results are found. You can unsubscribe from any alert email.' : 'Request a new confirmation email from the signup form and try again.', confirmed);
});

app.get('/api/email/unsubscribe', (req, res) => {
  const token = String(req.query.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return emailResultPage(res, 'Invalid unsubscribe link', 'This unsubscribe link is not valid.', false);
  res.type('html').send(emailActionPage('Unsubscribe from email alerts', 'Confirm that you want to stop receiving BoardExamTracker email alerts.', token, '/api/email/unsubscribe', 'Unsubscribe'));
});

app.post('/api/email/unsubscribe', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  const token = String(req.body?.token || '');
  const removed = /^[a-f0-9]{64}$/.test(token) && removeSubscriber(token);
  emailResultPage(res, removed ? 'Unsubscribed' : 'Link not found', removed ? 'This email address has been removed from BoardExamTracker alerts.' : 'This unsubscribe link is invalid or has already been used.', removed);
});

app.get('/api/results', async (req, res) => {
  const force = req.query.refresh === 'true';
  if (!force && isFresh()) {
    const cached = getCache();
    return res.json({ results: cached.results, professions: PROFESSION_CATEGORIES, lastUpdated: new Date(cached.fetchedAt).toISOString(), cached: true, stale: false, source: SOURCE_URL });
  }
  try {
    const value = await refresh();
    return res.json({ results: value.results, professions: PROFESSION_CATEGORIES, lastUpdated: new Date(value.fetchedAt).toISOString(), cached: false, stale: false, source: SOURCE_URL });
  } catch (error) {
    const cached = getCache();
    if (cached) return res.status(200).json({ results: cached.results, professions: PROFESSION_CATEGORIES, lastUpdated: new Date(cached.fetchedAt).toISOString(), cached: true, stale: true, source: SOURCE_URL, warning: 'Showing the latest cached results.' });
    return res.status(503).json({ results: [], professions: PROFESSION_CATEGORIES, lastUpdated: null, cached: false, stale: false, source: SOURCE_URL, error: 'Unable to retrieve the latest PRC results.', message: error.message });
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
app.get('/results/:slug', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.listen(port, () => {
  console.log(`BoardExamTracker listening on http://localhost:${port}`);
  refresh().catch((error) => console.warn('Initial PRC refresh failed:', error.message));
  const refreshTimer = setInterval(() => {
    refresh().catch((error) => console.warn('Scheduled PRC refresh failed:', error.message));
  }, AUTO_REFRESH_MS);
  refreshTimer.unref();
});
