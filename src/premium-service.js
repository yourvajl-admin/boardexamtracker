const crypto = require('node:crypto');
const { isEmailConfigured, sendEmail } = require('./email');
const { redisCommand } = require('./subscriptions');
const {
  PLAN_NAME,
  addAuditLog,
  addMonthsToDate,
  createPayment,
  effectiveStatus,
  endOfDayIso,
  getActivePremiumSubscribers,
  getConfig,
  getPaymentById,
  getSubscriptionByEmail,
  getUserByEmail,
  getUserById,
  isValidEmail,
  listPaymentsByEmail,
  logEmailEvent,
  normalizeEmail,
  nowIso,
  savePayment,
  saveSubscription,
  saveUser,
  toIsoDate,
  DELIVERY_PREFIX,
  DELIVERY_TTL_SECONDS,
} = require('./premium-store');
const { makeToken } = require('./premium-auth');

const PENDING_PAYMENT_TTL_SECONDS = 60 * 60 * 24;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function publicBaseUrl(port = Number(process.env.PORT) || 3000) {
  if (process.env.NODE_ENV === 'production') return 'https://www.boardexamtracker.com';
  return (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
}

function formatPhp(amount) {
  const n = Number(amount);
  return `₱${Number.isFinite(n) ? n.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : '0'}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Manila' });
}

function sanitizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

async function ensureSubscription(email, defaults = {}) {
  const normalized = normalizeEmail(email);
  const existing = await getSubscriptionByEmail(normalized);
  if (existing) return existing;
  const sub = {
    email: normalized,
    alertEmail: normalized,
    fullName: sanitizeName(defaults.fullName),
    userId: defaults.userId || null,
    status: defaults.status || 'expired',
    startDate: defaults.startDate || null,
    expirationDate: defaults.expirationDate || null,
    cancelAtPeriodEnd: false,
    emailVerifiedAt: defaults.emailVerifiedAt || null,
    pendingEmail: null,
    pendingEmailToken: null,
    pendingEmailExpiresAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await saveSubscription(sub);
  return sub;
}

function computeExtendedExpiration(sub, months, now = new Date()) {
  const active = effectiveStatus(sub, now.getTime()) === 'active';
  const base = active && sub.expirationDate ? new Date(sub.expirationDate) : now;
  const start = active && sub.startDate ? sub.startDate : now.toISOString();
  const expirationDate = addMonthsToDate(base.toISOString(), months);
  return { startDate: start, expirationDate };
}

async function activateSubscription({ email, months = 1, actor = 'system', reason = 'payment', paymentId = null, amount = 20, method = 'Ganap', reference = '', fullName = '', userId = null, complimentary = false }) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) throw new Error('Invalid email address.');
  const sub = await ensureSubscription(normalized, { fullName, userId });
  const { startDate, expirationDate } = computeExtendedExpiration(sub, months);
  sub.fullName = sanitizeName(fullName || sub.fullName);
  sub.userId = userId || sub.userId || null;
  sub.status = 'active';
  sub.startDate = sub.startDate || startDate;
  sub.expirationDate = expirationDate;
  sub.cancelAtPeriodEnd = false;
  sub.lastPaymentId = paymentId || sub.lastPaymentId || null;
  sub.lastPaymentMethod = method;
  await saveSubscription(sub);
  await addAuditLog({
    action: complimentary ? 'subscription_complimentary_activated' : 'subscription_activated',
    actor,
    email: normalized,
    details: { months, amount, method, reference, paymentId, reason, startDate: sub.startDate, expirationDate: sub.expirationDate },
  });
  try { await sendSubscriptionActivatedEmail(sub); } catch (error) { console.error('Could not send activation email:', error.message); }
  return sub;
}

async function expireDueSubscriptions(now = Date.now(), actor = 'system') {
  const { listSubscriptions } = require('./premium-store');
  const subs = await listSubscriptions();
  let changed = 0;
  for (const sub of subs) {
    if (sub.status === 'active' && effectiveStatus(sub, now) === 'expired') {
      sub.status = 'expired';
      sub.cancelAtPeriodEnd = false;
      await saveSubscription(sub);
      await addAuditLog({ action: 'subscription_expired', actor, email: sub.email, details: { expirationDate: sub.expirationDate } });
      changed += 1;
    }
  }
  return changed;
}

async function cancelSubscription(email, actor = 'user', reason = 'cancelled by user') {
  const sub = await getSubscriptionByEmail(email);
  if (!sub) throw new Error('Subscription not found.');
  sub.status = 'cancelled';
  sub.cancelAtPeriodEnd = false;
  sub.cancelledAt = nowIso();
  await saveSubscription(sub);
  await addAuditLog({ action: 'subscription_cancelled', actor, email: sub.email, details: { reason } });
  return sub;
}

async function recordManualPayment({ email, fullName, amount, method, reference, status, months, startDate, expirationDate, actor, userId, notes, complimentary }) {
  const normalized = normalizeEmail(email);
  const sub = await ensureSubscription(normalized, { fullName, userId });
  const payment = await createPayment({
    email: normalized,
    userId: userId || sub.userId || null,
    amount: Number(amount) || 0,
    method: method || 'Other',
    reference: reference || '',
    status: status || 'Paid',
    months: Number(months) || 1,
    type: complimentary ? 'complimentary' : 'manual',
    metadata: { actor, notes: notes || '' },
  });
  await addAuditLog({ action: 'payment_recorded', actor, email: normalized, details: { paymentId: payment.id, amount: payment.amount, method: payment.method, reference: payment.reference, status: payment.status } });
  return payment;
}

async function applyManualSubscription({ email, fullName, userId, amount, paymentMethod, paymentReference, paymentStatus, subscriptionStatus, startDate, durationMonths, expirationDate, adminNotes, actor, complimentary }) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) throw new Error('A valid email address is required.');
  const sub = await ensureSubscription(normalized, { fullName, userId });
  const before = { ...sub };
  sub.fullName = sanitizeName(fullName || sub.fullName);
  if (userId) sub.userId = userId;
  if (adminNotes !== undefined) sub.adminNotes = String(adminNotes || '').slice(0, 2000);
  if (complimentary) sub.complimentary = true;

  const months = Math.max(1, Number(durationMonths) || 1);
  let start = toIsoDate(startDate) ? endOfDayIso(toIsoDate(startDate)) : sub.startDate;
  let exp = toIsoDate(expirationDate) ? endOfDayIso(toIsoDate(expirationDate)) : sub.expirationDate;
  if (!exp && start) exp = addMonthsToDate(start, months);
  if (!start && exp) start = nowIso();
  if (!start && !exp && subscriptionStatus === 'active') {
    const computed = computeExtendedExpiration(sub, months);
    start = computed.startDate;
    exp = computed.expirationDate;
  }
  if (start) sub.startDate = start;
  if (exp) sub.expirationDate = exp;
  if (subscriptionStatus) sub.status = subscriptionStatus;

  const payStatus = paymentStatus || (complimentary ? 'Complimentary' : 'Paid');
  const shouldRecordPayment = paymentStatus || amount !== undefined || paymentMethod || paymentReference || complimentary;
  let payment = null;
  if (shouldRecordPayment) {
    payment = await recordManualPayment({
      email: normalized,
      fullName: sub.fullName,
      amount: complimentary ? 0 : (Number(amount) || 0),
      method: paymentMethod || (complimentary ? 'Complimentary' : 'Other'),
      reference: paymentReference || '',
      status: payStatus,
      months,
      startDate: sub.startDate,
      expirationDate: sub.expirationDate,
      actor,
      userId: sub.userId,
      notes: adminNotes,
      complimentary,
    });
    sub.lastPaymentId = payment.id;
    sub.lastPaymentMethod = payment.method;
  }

  if (sub.status === 'active' && effectiveStatus(sub) === 'expired') {
    // Admin explicitly set active but expiration is past; keep as expired to avoid invalid active state.
    sub.status = 'expired';
  }

  await saveSubscription(sub);
  await addAuditLog({ action: 'subscription_manual_save', actor, email: normalized, details: { before: { status: before.status, startDate: before.startDate, expirationDate: before.expirationDate }, after: { status: sub.status, startDate: sub.startDate, expirationDate: sub.expirationDate }, paymentId: payment?.id || null } });
  return { subscription: sub, payment };
}

async function sendSubscriptionActivatedEmail(sub) {
  if (!isEmailConfigured()) return;
  const baseUrl = publicBaseUrl();
  const to = sub.alertEmail || sub.email;
  const subject = `Your ${PLAN_NAME} subscription is active`;
  const html = `<div style="font-family:Arial,sans-serif;color:#172b46;line-height:1.6;max-width:560px;margin:0 auto"><h1 style="font-size:22px">Premium Email Alerts are active</h1><p>Your ${escapeHtml(PLAN_NAME)} subscription for <strong>${escapeHtml(to)}</strong> is now active.</p><p><strong>Plan:</strong> ${escapeHtml(PLAN_NAME)}<br><strong>Price:</strong> ₱20/month equivalent<br><strong>Start:</strong> ${escapeHtml(formatDate(sub.startDate))}<br><strong>Expires:</strong> ${escapeHtml(formatDate(sub.expirationDate))}</p><p>You’ll receive an email whenever new Philippine board exam results are published on BoardExamTracker.</p><p><a href="${escapeHtml(baseUrl)}/account" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#2563a9;color:white;text-decoration:none;font-weight:bold">Manage subscription</a></p><p style="font-size:12px;color:#718097">BoardExamTracker is free to use for checking board exam results. Premium Email Alerts is the only paid feature.</p></div>`;
  const text = `${PLAN_NAME} is active for ${to}.\nStart: ${formatDate(sub.startDate)}\nExpires: ${formatDate(sub.expirationDate)}\nManage: ${baseUrl}/account`;
  await sendEmail({ to, subject, html, text });
  await logEmailEvent({ type: 'subscription_activated', to, status: 'sent', subject });
}

function ganapConfig() {
  const projectUuid = process.env.GANAP_PROJECT_UUID || '';
  const secretKey = process.env.GANAP_SECRET_KEY || '';
  const apiBase = (process.env.GANAP_API_BASE || 'https://api.ganap.net').replace(/\/$/, '');
  return {
    projectUuid,
    secretKey,
    apiBase,
    configured: Boolean(projectUuid && secretKey),
  };
}

function signGanapBody(rawBody, secretKey) {
  return crypto.createHmac('sha256', secretKey).update(rawBody).digest('hex');
}

async function createGanapCheckout({ email, fullName, months, amount, paymentId, userId }) {
  const cfg = ganapConfig();
  if (!cfg.configured) throw new Error('Ganap payment is not configured on this server.');
  if (Number(amount) < 200) throw new Error('Ganap requires a minimum charge of ₱200. Choose a prepaid option that preserves the ₱20/month equivalent.');
  const baseUrl = publicBaseUrl();
  const body = {
    projectUuid: cfg.projectUuid,
    amount: Number(amount),
    idempotencyKey: `bet-premium-${paymentId}`,
    customerName: sanitizeName(fullName) || email,
    customerEmail: email,
    externalReference: paymentId,
    successRedirectUrl: `${baseUrl}/account?payment=success&ref=${encodeURIComponent(paymentId)}`,
    failureRedirectUrl: `${baseUrl}/account?payment=failed&ref=${encodeURIComponent(paymentId)}`,
    metadata: {
      paymentId,
      email,
      userId: userId || null,
      months: Number(months),
      plan: PLAN_NAME,
    },
  };
  const rawBody = JSON.stringify(body);
  const signature = signGanapBody(rawBody, cfg.secretKey);
  const response = await fetch(`${cfg.apiBase}/v1/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ganap-Signature': signature,
    },
    body: rawBody,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error || data?.message || `Ganap checkout failed (${response.status}).`;
    throw new Error(typeof message === 'string' ? message : 'Ganap checkout failed.');
  }
  return { referenceNumber: data.referenceNumber, redirectUrl: data.redirectUrl, raw: data };
}

function verifyGanapCallback(rawBody, signatureHeader) {
  const cfg = ganapConfig();
  if (!cfg.configured) return false;
  if (typeof signatureHeader !== 'string' || !signatureHeader) return false;
  const expected = signGanapBody(rawBody, cfg.secretKey);
  const a = Buffer.from(expected, 'hex');
  let b;
  try { b = Buffer.from(signatureHeader, 'hex'); } catch { return false; }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handleGanapCallback(payload, rawBody, signatureHeader) {
  if (!verifyGanapCallback(rawBody, signatureHeader)) {
    await addAuditLog({ action: 'ganap_webhook_invalid_signature', actor: 'ganap', details: { hasSignature: Boolean(signatureHeader) } });
    return { ok: false, status: 401, error: 'Invalid signature.' };
  }
  if (payload?.event !== 'transaction.paid') {
    return { ok: true, ignored: true };
  }
  const paymentId = String(payload.externalReference || payload.metadata?.paymentId || '').trim();
  const referenceNumber = String(payload.referenceNumber || '').trim();
  if (!paymentId) {
    await addAuditLog({ action: 'ganap_webhook_missing_payment_id', actor: 'ganap', details: { referenceNumber } });
    return { ok: false, status: 400, error: 'Missing payment reference.' };
  }
  if (!referenceNumber) {
    await addAuditLog({ action: 'ganap_webhook_missing_reference', actor: 'ganap', details: { paymentId } });
    return { ok: false, status: 400, error: 'Missing transaction reference.' };
  }
  const payment = await getPaymentById(paymentId);
  if (!payment) {
    await addAuditLog({ action: 'ganap_webhook_unknown_payment', actor: 'ganap', details: { paymentId, referenceNumber } });
    return { ok: false, status: 404, error: 'Payment not found.' };
  }
  if (payment.status === 'Paid' || payment.ganapReference === referenceNumber) {
    return { ok: true, duplicate: true, paymentId: payment.id };
  }
  const callbackAmount = Number(payload.amount);
  if (Number.isFinite(callbackAmount) && Number(payment.amount) !== callbackAmount) {
    await addAuditLog({ action: 'ganap_webhook_amount_mismatch', actor: 'ganap', email: payment.email, details: { paymentId, expected: payment.amount, received: callbackAmount, referenceNumber } });
    return { ok: false, status: 400, error: 'Payment amount mismatch.' };
  }
  const months = Number(payment.months) || Number(payload.metadata?.months) || 1;
  const expectedAmount = Number(payment.amount);
  if (!(expectedAmount > 0) || !Number.isInteger(months) || months < 1) {
    return { ok: false, status: 400, error: 'Invalid payment record.' };
  }

  payment.status = 'Paid';
  payment.reference = referenceNumber;
  payment.ganapReference = referenceNumber;
  payment.paidAt = nowIso();
  payment.callback = {
    event: payload.event,
    referenceNumber,
    amount: payload.amount,
    currency: payload.currency,
    timestamp: payload.timestamp,
  };
  await savePayment(payment);

  await activateSubscription({
    email: payment.email,
    months,
    actor: 'ganap-webhook',
    reason: 'ganap_payment',
    paymentId: payment.id,
    amount: expectedAmount,
    method: 'Ganap',
    reference: referenceNumber,
    fullName: payment.metadata?.fullName || '',
    userId: payment.userId || null,
  });
  await addAuditLog({ action: 'ganap_payment_confirmed', actor: 'ganap', email: payment.email, details: { paymentId: payment.id, referenceNumber, months, amount: expectedAmount } });
  return { ok: true, activated: true, paymentId: payment.id };
}

async function createPremiumCheckout({ email, fullName, userId, months, method }) {
  const config = await getConfig();
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) throw new Error('A valid email address is required.');
  const selectedMonths = Number(months);
  if (!Number.isInteger(selectedMonths) || selectedMonths < 1 || selectedMonths > 24) {
    throw new Error('Invalid subscription period.');
  }
  const configuredOption = config.prepaidOptions.find((option) => Number(option.months) === selectedMonths);
  const monthlyOption = selectedMonths === 1
    ? { months: 1, amount: Number(config.monthlyPrice || 20), label: `${config.planName || PLAN_NAME} - ₱${Number(config.monthlyPrice || 20)}/month` }
    : null;
  const option = configuredOption || monthlyOption;
  if (!option) throw new Error('Selected payment option is not available.');
  const amount = Number(option.amount);
  if (!(amount > 0)) throw new Error('Invalid payment amount.');
  const ganap = ganapConfig();
  const chosenMethod = String(method || (ganap.enabled ? 'Ganap' : 'Manual')).trim();

  const sub = await ensureSubscription(normalized, { fullName, userId });
  sub.fullName = sanitizeName(fullName || sub.fullName);
  if (userId) sub.userId = userId;
  await saveSubscription(sub);

  if (chosenMethod === 'Ganap') {
    if (!ganap.configured) throw new Error('Ganap payment is not configured. Please contact support.');
    const payment = await createPayment({
      email: normalized,
      userId: userId || sub.userId || null,
      amount,
      method: 'Ganap',
      reference: '',
      status: 'Pending',
      months: selectedMonths,
      type: 'ganap_checkout',
      metadata: { fullName: sanitizeName(fullName), prepaidLabel: option.label, monthlyEquivalent: 20 },
    });
    await addAuditLog({ action: 'payment_checkout_created', actor: normalized, email: normalized, details: { paymentId: payment.id, amount, months: selectedMonths, method: 'Ganap' } });
    try {
      const checkout = await createGanapCheckout({ email: normalized, fullName, months: selectedMonths, amount, paymentId: payment.id, userId });
      payment.reference = checkout.referenceNumber || '';
      payment.metadata = { ...payment.metadata, ganap: checkout.raw };
      await savePayment(payment);
      return { payment, checkout, prepaid: option };
    } catch (error) {
      payment.status = 'Failed';
      payment.metadata = { ...payment.metadata, error: error.message };
      await savePayment(payment);
      await addAuditLog({ action: 'payment_checkout_failed', actor: normalized, email: normalized, details: { paymentId: payment.id, amount, months: selectedMonths, error: error.message } });
      throw error;
    }
  }

  const payment = await createPayment({
    email: normalized,
    userId: userId || sub.userId || null,
    amount,
    method: chosenMethod || 'Manual',
    reference: '',
    status: 'Pending',
    months: selectedMonths,
    type: 'manual_pending',
    metadata: { fullName: sanitizeName(fullName), prepaidLabel: option.label },
  });
  await addAuditLog({ action: 'payment_pending_manual', actor: normalized, email: normalized, details: { paymentId: payment.id, amount, months: selectedMonths, method: chosenMethod || 'Manual' } });
  return { payment, checkout: null, prepaid: option, manual: true };
}

async function sendPremiumResultAlert(subscriber, results, { resend = false, idempotencyKey } = {}) {
  const baseUrl = publicBaseUrl();
  const to = subscriber.alertEmail || subscriber.email;
  const itemHtml = results.slice(0, 30).map((result) => `<li style="margin-bottom:10px"><a href="${escapeHtml(boardResultPageUrl(baseUrl, result))}" style="color:#2563a9;font-weight:bold;text-decoration:none">${escapeHtml(result.title)}</a><div style="color:#718097;font-size:13px">${escapeHtml(result.date)}${result.category ? ` · ${escapeHtml(result.category)}` : ''}</div></li>`).join('');
  const itemText = results.slice(0, 30).map((result) => `- ${result.title} (${result.date})\n  ${boardResultPageUrl(baseUrl, result)}`).join('\n');
  const manageUrl = `${baseUrl}/account`;
  const heading = resend ? 'Your requested board exam result reminder' : `New board exam ${results.length === 1 ? 'result' : 'results'} published`;
  const intro = resend
    ? 'An administrator resent the latest BoardExamTracker result alert to your Premium Email Alerts subscription.'
    : `BoardExamTracker published ${results.length} new Philippine board exam ${results.length === 1 ? 'result' : 'results'}.`;
  await sendEmail({
    to,
    subject: resend ? `Reminder: latest board exam result on BoardExamTracker` : `${results.length} new PRC exam ${results.length === 1 ? 'result' : 'results'} on BoardExamTracker`,
    html: `<div style="font-family:Arial,sans-serif;color:#172b46;line-height:1.6;max-width:600px;margin:0 auto"><p style="color:#2563a9;font-weight:bold;margin:0 0 8px">BoardExamTracker Premium Email Alerts</p><h1 style="font-size:24px;line-height:1.3;margin:0 0 12px">${escapeHtml(heading)}</h1><p style="margin:0 0 16px">${escapeHtml(intro)}</p><ul style="padding-left:20px;margin:0 0 20px">${itemHtml}</ul><p><a href="${escapeHtml(baseUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#2563a9;color:white;text-decoration:none;font-weight:bold">View on BoardExamTracker</a></p><hr style="border:none;border-top:1px solid #e5ebf2;margin:24px 0"><p style="font-size:12px;color:#718097;margin:0">You’re receiving this because you have an active ${escapeHtml(PLAN_NAME)} subscription. <a href="${escapeHtml(manageUrl)}" style="color:#2563a9">Manage your subscription</a>.</p><p style="font-size:12px;color:#718097;margin:8px 0 0">BoardExamTracker is free to use for checking board exam results. Independent tracker; not affiliated with PRC.</p></div>`,
    text: `${heading}\n\n${intro}\n\n${itemText}\n\nManage subscription: ${manageUrl}\nBoardExamTracker is free to use for checking board exam results.`,
    idempotencyKey,
  });
}

function boardResultPageUrl(baseUrl, result) {
  try {
    const url = new URL(result.url);
    const slug = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'result');
    return `${baseUrl}/results/${encodeURIComponent(slug)}`;
  } catch {
    return `${baseUrl}/#latest`;
  }
}

async function sendPremiumAlertToSubscriber(subscriber, results, { resend = false } = {}) {
  const uniqueResults = [...new Map(results.filter((r) => r?.url).map((r) => [r.url, r])).values()];
  if (!uniqueResults.length) return { sent: false, alreadySent: true };
  const email = normalizeEmail(subscriber.alertEmail || subscriber.email);
  const batchId = crypto.createHash('sha256').update(uniqueResults.map((r) => r.url).sort().join('\n')).digest('hex');
  const deliveryKey = `${DELIVERY_PREFIX}${crypto.createHash('sha256').update(`${email}\n${batchId}`).digest('hex')}`;
  const existing = await redisCommand('GET', deliveryKey);
  if (existing === 'sent') return { sent: false, alreadySent: true };

  const lockKey = `${deliveryKey}:lock`;
  const lockToken = crypto.randomUUID();
  const lock = await redisCommand('SET', lockKey, lockToken, 'NX', 'EX', 300);
  if (lock !== 'OK') return { sent: false, inProgress: true };

  const idempotencyKey = `bet-premium-${crypto.createHash('sha256').update(`${email}\n${batchId}\n${resend ? 'resend' : 'auto'}`).digest('hex')}`;
  try {
    await sendPremiumResultAlert({ ...subscriber, email, alertEmail: email }, uniqueResults, { resend, idempotencyKey });
    await redisCommand('SET', deliveryKey, 'sent', 'EX', DELIVERY_TTL_SECONDS);
    await logEmailEvent({ type: resend ? 'result_alert_resend' : 'result_alert', to: email, status: 'sent', resultCount: uniqueResults.length, resultUrls: uniqueResults.map((r) => r.url).slice(0, 30) });
    return { sent: true, count: uniqueResults.length };
  } catch (error) {
    await logEmailEvent({ type: resend ? 'result_alert_resend' : 'result_alert', to: email, status: 'failed', error: String(error.message || error).slice(0, 500), resultCount: uniqueResults.length });
    throw error;
  } finally {
    try {
      const current = await redisCommand('GET', lockKey);
      if (current === lockToken) await redisCommand('DEL', lockKey);
    } catch { /* ignore */ }
  }
}

async function notifyPremiumSubscribers(results) {
  const subscribers = await getActivePremiumSubscribers();
  if (!subscribers.length) return { recipients: 0, sent: 0, failed: 0, skipped: 0 };
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < subscribers.length; i += 1) {
    const sub = subscribers[i];
    try {
      const result = await sendPremiumAlertToSubscriber(sub, results);
      if (result.sent) sent += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      console.error(`Premium alert failed for ${sub.email}: ${error.message}`);
    }
    if (i < subscribers.length - 1) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return { recipients: subscribers.length, sent, failed, skipped };
}

module.exports = {
  activateSubscription,
  applyManualSubscription,
  boardResultPageUrl,
  cancelSubscription,
  createGanapCheckout,
  createPremiumCheckout,
  ensureSubscription,
  expireDueSubscriptions,
  formatDate,
  formatPhp,
  ganapConfig,
  handleGanapCallback,
  notifyPremiumSubscribers,
  publicBaseUrl,
  recordManualPayment,
  sendPremiumAlertToSubscriber,
  sendSubscriptionActivatedEmail,
  signGanapBody,
  verifyGanapCallback,
};
