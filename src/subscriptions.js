const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'email-subscribers.json');
const SUBSCRIBERS_KEY = 'boardexamtracker:subscribers';
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return { url: url.replace(/\/+$/, ''), token, configured: Boolean(url && token) };
}

function isPersistentStorageConfigured() {
  return redisConfig().configured;
}

async function redisCommand(...command) {
  const { url, token, configured } = redisConfig();
  if (!configured) throw new Error('Persistent storage is not configured.');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `Subscriber storage returned ${response.status}.`);
  return data.result;
}

function readLocalSubscribers() {
  try {
    const entries = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8'));
    if (!Array.isArray(entries)) return [];
    const current = entries.filter((item) => item.confirmedAt || !item.confirmExpiresAt || item.confirmExpiresAt > Date.now());
    if (current.length !== entries.length) writeLocalSubscribers(current);
    return current;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    console.error('Could not read subscriber data:', error.message);
    return [];
  }
}

function writeLocalSubscribers(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryFile = `${SUBSCRIBERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(entries, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, SUBSCRIBERS_FILE);
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function allSubscribers() {
  if (!isPersistentStorageConfigured()) return readLocalSubscribers();
  const values = await redisCommand('HGETALL', SUBSCRIBERS_KEY);
  const flattenedValues = Array.isArray(values) ? values : values && typeof values === 'object' ? Object.entries(values).flat() : [];
  const entries = [];
  const expired = [];
  for (let index = 0; index < flattenedValues.length; index += 2) {
    try {
      const subscriber = JSON.parse(flattenedValues[index + 1]);
      if (!subscriber || typeof subscriber.email !== 'string') continue;
      if (!subscriber.confirmedAt && subscriber.confirmExpiresAt && subscriber.confirmExpiresAt <= Date.now()) expired.push(flattenedValues[index]);
      else entries.push(subscriber);
    } catch {
      expired.push(flattenedValues[index]);
    }
  }
  if (expired.length) await redisCommand('HDEL', SUBSCRIBERS_KEY, ...expired);
  return entries;
}

async function findSubscriberByEmail(email) {
  if (!isPersistentStorageConfigured()) return readLocalSubscribers().find((item) => item.email === email);
  const value = await redisCommand('HGET', SUBSCRIBERS_KEY, email);
  if (typeof value !== 'string') return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

async function findSubscriberByToken(token) {
  return (await allSubscribers()).find((item) => item.confirmToken === token || item.unsubscribeToken === token);
}

async function saveSubscriber(subscriber) {
  if (isPersistentStorageConfigured()) {
    await redisCommand('HSET', SUBSCRIBERS_KEY, subscriber.email, JSON.stringify(subscriber));
    return;
  }
  const entries = readLocalSubscribers();
  const index = entries.findIndex((item) => item.email === subscriber.email);
  if (index < 0) entries.push(subscriber);
  else entries[index] = subscriber;
  writeLocalSubscribers(entries);
}

async function deleteSubscriber(email) {
  if (isPersistentStorageConfigured()) return Number(await redisCommand('HDEL', SUBSCRIBERS_KEY, email)) > 0;
  const entries = readLocalSubscribers();
  const remaining = entries.filter((item) => item.email !== email);
  if (remaining.length === entries.length) return false;
  writeLocalSubscribers(remaining);
  return true;
}

async function addPendingSubscriber(email) {
  let subscriber = await findSubscriberByEmail(email);
  if (subscriber?.confirmedAt) return { status: 'subscribed' };

  const now = Date.now();
  if (!subscriber) subscriber = { email, createdAt: now, confirmedAt: null, unsubscribeToken: makeToken() };
  if (subscriber.confirmEmailSentAt && now - subscriber.confirmEmailSentAt < RESEND_COOLDOWN_MS) return { status: 'pending' };

  subscriber.confirmToken = makeToken();
  subscriber.confirmExpiresAt = now + CONFIRMATION_TTL_MS;
  subscriber.confirmEmailSentAt = null;
  await saveSubscriber(subscriber);
  return { status: 'confirmation-required', token: subscriber.confirmToken };
}

async function markConfirmationSent(token) {
  const subscriber = await findSubscriberByToken(token);
  if (!subscriber) return;
  subscriber.confirmEmailSentAt = Date.now();
  await saveSubscriber(subscriber);
}

async function confirmSubscriber(token) {
  const subscriber = await findSubscriberByToken(token);
  if (!subscriber || subscriber.confirmToken !== token || !subscriber.confirmExpiresAt || subscriber.confirmExpiresAt < Date.now()) return false;
  subscriber.confirmedAt = Date.now();
  delete subscriber.confirmToken;
  delete subscriber.confirmExpiresAt;
  delete subscriber.confirmEmailSentAt;
  await saveSubscriber(subscriber);
  return true;
}

async function removeSubscriber(token) {
  const subscriber = await findSubscriberByToken(token);
  if (!subscriber || subscriber.unsubscribeToken !== token) return false;
  return deleteSubscriber(subscriber.email);
}

async function removeSubscriberByEmail(email) {
  return deleteSubscriber(email);
}

async function listConfirmedSubscribers() {
  return (await allSubscribers()).filter((item) => item.confirmedAt && item.unsubscribeToken);
}

async function listSubscribersForAdmin() {
  return (await allSubscribers())
    .filter((item) => item.unsubscribeToken)
    .map((item) => ({ email: item.email, status: item.confirmedAt ? 'Confirmed' : 'Pending confirmation' }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

async function getSubscriberCounts() {
  const entries = await allSubscribers();
  return {
    confirmed: entries.filter((item) => item.confirmedAt && item.unsubscribeToken).length,
    pending: entries.filter((item) => !item.confirmedAt && item.confirmToken).length,
  };
}

module.exports = {
  addPendingSubscriber,
  confirmSubscriber,
  getSubscriberCounts,
  isPersistentStorageConfigured,
  listConfirmedSubscribers,
  listSubscribersForAdmin,
  markConfirmationSent,
  removeSubscriber,
  removeSubscriberByEmail,
};
