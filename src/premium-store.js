const crypto = require('node:crypto');
const { redisCommand } = require('./subscriptions');

const SUBSCRIPTIONS_KEY = 'boardexamtracker:premium:subscriptions';
const USERS_KEY = 'boardexamtracker:premium:users';
const USER_EMAIL_INDEX_KEY = 'boardexamtracker:premium:user-email-index';
const PAYMENTS_KEY = 'boardexamtracker:premium:payments';
const PAYMENT_EMAIL_INDEX_PREFIX = 'boardexamtracker:premium:payments-by-email:';
const AUDIT_KEY = 'boardexamtracker:premium:audit';
const EMAIL_LOG_KEY = 'boardexamtracker:premium:email-log';
const CONFIG_KEY = 'boardexamtracker:premium:config';
const DELIVERY_PREFIX = 'boardexamtracker:premium:alert-delivery:v1:';
const DELIVERY_TTL_SECONDS = 60 * 60 * 24 * 400;
const PLAN_MONTHLY_PRICE_CENTAVOS = 2000;
const PLAN_NAME = 'Premium Email Alerts';

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function nowIso() {
  return new Date().toISOString();
}

function hashEmail(email) {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function paymentIndexKey(email) {
  return `${PAYMENT_EMAIL_INDEX_PREFIX}${hashEmail(email)}`;
}

function toIsoDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function endOfDayIso(dateValue) {
  const date = toIsoDate(dateValue);
  if (!date) return null;
  return `${date}T23:59:59.999Z`;
}

function addMonthsToDate(dateValue, months) {
  const base = new Date(endOfDayIso(dateValue) || dateValue);
  if (Number.isNaN(base.getTime())) return null;
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = base.getUTCDate();
  const targetMonthIndex = month + Number(months);
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const result = new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay), 23, 59, 59, 999));
  return result.toISOString();
}

function isExpired(subscription, now = Date.now()) {
  if (!subscription?.expirationDate) return true;
  const exp = Date.parse(subscription.expirationDate);
  return !Number.isFinite(exp) || exp < now;
}

function effectiveStatus(subscription, now = Date.now()) {
  if (!subscription) return 'none';
  if (subscription.status === 'cancelled') return 'cancelled';
  if (subscription.status === 'pending') return 'pending';
  if (isExpired(subscription, now)) return 'expired';
  return subscription.status === 'active' ? 'active' : 'expired';
}

async function getConfig() {
  const raw = await redisCommand('GET', CONFIG_KEY);
  let config = {};
  if (typeof raw === 'string') {
    try { config = JSON.parse(raw); } catch { config = {}; }
  }
  return normalizeConfig(config);
}

function normalizeConfig(config = {}) {
  const ganapEnabled = config.ganapEnabled !== false;
  const alternativeMethods = Array.isArray(config.alternativeMethods) && config.alternativeMethods.length
    ? config.alternativeMethods.map((method) => String(method || '').trim()).filter(Boolean).slice(0, 20)
    : ['GCash Manual', 'Bank Transfer', 'Cash', 'Other'];
  const prepaidOptions = Array.isArray(config.prepaidOptions) && config.prepaidOptions.length
    ? config.prepaidOptions.flatMap((option) => {
        const months = Number(option?.months);
        const amount = Number(option?.amount);
        const label = String(option?.label || '').trim().slice(0, 80);
        if (!Number.isInteger(months) || months < 1 || months > 24) return [];
        if (!Number.isFinite(amount) || amount <= 0) return [];
        return [{ months, amount, label: label || `${months} month${months === 1 ? '' : 's'} - ₱${amount}` }];
      }).slice(0, 10)
    : [{ months: 10, amount: 200, label: '10 months - ₱200 (₱20/month equivalent)' }];
  return {
    ganapEnabled,
    ganapMinimumAmount: 200,
    monthlyPrice: 20,
    planName: PLAN_NAME,
    alternativeMethods,
    prepaidOptions,
  };
}

async function saveConfig(patch, actor = 'admin') {
  const current = await getConfig();
  const next = normalizeConfig({ ...current, ...patch });
  await redisCommand('SET', CONFIG_KEY, JSON.stringify(next));
  await addAuditLog({ action: 'config_updated', actor, details: { patch, config: next } });
  return next;
}

async function addAuditLog(entry) {
  const record = {
    id: crypto.randomUUID(),
    at: nowIso(),
    ...entry,
  };
  await redisCommand('LPUSH', AUDIT_KEY, JSON.stringify(record));
  await redisCommand('LTRIM', AUDIT_KEY, '0', '999');
  return record;
}

async function listAuditLogs(limit = 100) {
  const rows = await redisCommand('LRANGE', AUDIT_KEY, '0', String(Math.max(0, limit - 1)));
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (typeof row !== 'string') return [];
    try { return [JSON.parse(row)]; } catch { return []; }
  });
}

async function getSubscriptionByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) return null;
  const raw = await redisCommand('HGET', SUBSCRIPTIONS_KEY, normalized);
  if (typeof raw !== 'string') return null;
  try {
    const sub = JSON.parse(raw);
    if (!sub || normalizeEmail(sub.email) !== normalized) return null;
    return sub;
  } catch { return null; }
}

async function saveSubscription(subscription) {
  const email = normalizeEmail(subscription.email);
  if (!isValidEmail(email)) throw new Error('Invalid subscription email.');
  const record = { ...subscription, email, updatedAt: nowIso() };
  await redisCommand('HSET', SUBSCRIPTIONS_KEY, email, JSON.stringify(record));
  return record;
}

async function listSubscriptions() {
  const raw = await redisCommand('HGETALL', SUBSCRIPTIONS_KEY);
  const values = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.entries(raw).flat() : [];
  const subs = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    try {
      const sub = JSON.parse(values[i + 1]);
      if (sub?.email) subs.push(sub);
    } catch { /* ignore */ }
  }
  return subs.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}

async function getUserById(userId) {
  if (!userId) return null;
  const raw = await redisCommand('HGET', USERS_KEY, String(userId));
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function getUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) return null;
  const userId = await redisCommand('HGET', USER_EMAIL_INDEX_KEY, normalized);
  if (typeof userId !== 'string' || !userId) return null;
  return getUserById(userId);
}

async function saveUser(user) {
  const email = normalizeEmail(user.email);
  if (!isValidEmail(email)) throw new Error('Invalid user email.');
  if (!user.id) throw new Error('Missing user id.');
  const record = { ...user, email, updatedAt: nowIso() };
  await redisCommand('HSET', USERS_KEY, record.id, JSON.stringify(record));
  await redisCommand('HSET', USER_EMAIL_INDEX_KEY, email, record.id);
  return record;
}

async function createOrGetUser({ email, fullName, passwordHash }) {
  const normalized = normalizeEmail(email);
  const existing = await getUserByEmail(normalized);
  if (existing) return { user: existing, created: false };
  const id = crypto.randomUUID();
  const user = {
    id,
    email: normalized,
    fullName: String(fullName || '').trim().slice(0, 120),
    passwordHash: passwordHash || null,
    emailVerifiedAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await saveUser(user);
  await addAuditLog({ action: 'user_created', actor: normalized, email: normalized, details: { userId: id } });
  return { user, created: true };
}

async function createPayment(payment) {
  const id = payment.id || crypto.randomUUID();
  const record = {
    id,
    email: normalizeEmail(payment.email),
    userId: payment.userId || null,
    amount: Number(payment.amount) || 0,
    currency: 'PHP',
    method: String(payment.method || 'Other').slice(0, 40),
    reference: String(payment.reference || '').slice(0, 120),
    status: String(payment.status || 'Pending').slice(0, 40),
    type: String(payment.type || 'subscription').slice(0, 40),
    months: Number(payment.months) || 1,
    metadata: payment.metadata || {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await redisCommand('HSET', PAYMENTS_KEY, id, JSON.stringify(record));
  await redisCommand('RPUSH', paymentIndexKey(record.email), id);
  await redisCommand('LTRIM', paymentIndexKey(record.email), '-200', '-1');
  return record;
}

async function getPaymentById(id) {
  if (!id) return null;
  const raw = await redisCommand('HGET', PAYMENTS_KEY, String(id));
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function savePayment(payment) {
  if (!payment?.id) throw new Error('Missing payment id.');
  const record = { ...payment, email: normalizeEmail(payment.email), updatedAt: nowIso() };
  await redisCommand('HSET', PAYMENTS_KEY, record.id, JSON.stringify(record));
  return record;
}

async function listPaymentsByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) return [];
  const ids = await redisCommand('LRANGE', paymentIndexKey(normalized), '0', '-1');
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = await redisCommand('HMGET', PAYMENTS_KEY, ...ids);
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (typeof row !== 'string') return [];
    try { return [JSON.parse(row)]; } catch { return []; }
  }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function listAllPayments(limit = 500) {
  const raw = await redisCommand('HGETALL', PAYMENTS_KEY);
  const values = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.entries(raw).flat() : [];
  const payments = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    try { payments.push(JSON.parse(values[i + 1])); } catch { /* ignore */ }
  }
  return payments.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, limit);
}

async function logEmailEvent(event) {
  const record = { id: crypto.randomUUID(), at: nowIso(), ...event };
  await redisCommand('LPUSH', EMAIL_LOG_KEY, JSON.stringify(record));
  await redisCommand('LTRIM', EMAIL_LOG_KEY, '0', '1999');
  return record;
}

async function listEmailLogs(limit = 200) {
  const rows = await redisCommand('LRANGE', EMAIL_LOG_KEY, '0', String(Math.max(0, limit - 1)));
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (typeof row !== 'string') return [];
    try { return [JSON.parse(row)]; } catch { return []; }
  });
}

async function getActivePremiumSubscribers(now = Date.now()) {
  const subs = await listSubscriptions();
  return subs.filter((sub) => effectiveStatus(sub, now) === 'active' && !sub.alertsPaused && isValidEmail(normalizeEmail(sub.alertEmail || sub.email)));
}

function publicSubscription(sub, user = null) {
  const status = effectiveStatus(sub);
  return {
    email: sub.email,
    alertEmail: sub.alertEmail || sub.email,
    fullName: sub.fullName || '',
    status,
    planName: PLAN_NAME,
    monthlyPrice: 20,
    startDate: sub.startDate || null,
    expirationDate: sub.expirationDate || null,
    userId: sub.userId || user?.id || null,
    hasAccount: Boolean(sub.userId || user?.id),
    emailVerified: Boolean(sub.emailVerifiedAt || user?.emailVerifiedAt),
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    alertsPaused: Boolean(sub.alertsPaused),
  };
}

module.exports = {
  PLAN_NAME,
  PLAN_MONTHLY_PRICE_CENTAVOS,
  SUBSCRIPTIONS_KEY,
  addAuditLog,
  addMonthsToDate,
  createOrGetUser,
  createPayment,
  effectiveStatus,
  endOfDayIso,
  getActivePremiumSubscribers,
  getConfig,
  getPaymentById,
  getSubscriptionByEmail,
  getUserByEmail,
  getUserById,
  hashEmail,
  isExpired,
  isValidEmail,
  listAllPayments,
  listAuditLogs,
  listEmailLogs,
  listPaymentsByEmail,
  listSubscriptions,
  logEmailEvent,
  normalizeConfig,
  normalizeEmail,
  nowIso,
  paymentIndexKey,
  publicSubscription,
  saveConfig,
  savePayment,
  saveSubscription,
  saveUser,
  toIsoDate,
  DELIVERY_PREFIX,
  DELIVERY_TTL_SECONDS,
};
