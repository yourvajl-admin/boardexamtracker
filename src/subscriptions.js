const crypto = require('node:crypto');

const SUBSCRIBERS_KEY = 'boardexamtracker:subscribers';
const SUBSCRIBER_MIGRATION_KEY = 'boardexamtracker:migrations:legacy-subscribers:v1';
const SUBSCRIBER_MIGRATION_LOCK_KEY = `${SUBSCRIBER_MIGRATION_KEY}:lock`;
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
let subscriberMigrationPromise;

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return { url: url.replace(/\/+$/, ''), token, configured: Boolean(url && token) };
}

function legacyRedisConfig() {
  const url = process.env.KV_REST_API_URL || '';
  const token = process.env.KV_REST_API_TOKEN || '';
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

async function redisPipeline(url, token, commands, label) {
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (!response.ok || !Array.isArray(data) || data.some((item) => item.error)) {
    throw new Error(`${label} returned ${response.status}.`);
  }
  return data.map((item) => item.result);
}

function flattenedHash(value) {
  return Array.isArray(value) ? value : value && typeof value === 'object' ? Object.entries(value).flat() : [];
}

function parseMigrationStatus(value) {
  if (typeof value !== 'string') return null;
  try {
    const status = JSON.parse(value);
    return status && status.completedAt ? { ...status, alreadyComplete: true } : null;
  } catch { return null; }
}

async function performLegacySubscriberMigration() {
  const destination = redisConfig();
  const source = legacyRedisConfig();
  if (!destination.configured) throw new Error('Upstash Redis REST storage is not configured.');
  if (!source.configured || source.url === destination.url) {
    return { skipped: true, imported: 0, alreadyPresent: 0, invalidSkipped: 0 };
  }

  const priorStatus = parseMigrationStatus(await redisCommand('GET', SUBSCRIBER_MIGRATION_KEY));
  if (priorStatus) return priorStatus;

  const lockToken = crypto.randomUUID();
  const acquired = await redisCommand('SET', SUBSCRIBER_MIGRATION_LOCK_KEY, lockToken, 'NX', 'EX', 300);
  if (acquired !== 'OK') {
    const completed = parseMigrationStatus(await redisCommand('GET', SUBSCRIBER_MIGRATION_KEY));
    if (completed) return completed;
    throw new Error('Subscriber migration is already running. Please retry shortly.');
  }

  try {
    const sourceResponse = await fetch(source.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${source.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['HGETALL', SUBSCRIBERS_KEY]),
      signal: AbortSignal.timeout(15_000),
    });
    const sourceBody = await sourceResponse.json();
    if (!sourceResponse.ok || sourceBody.error) throw new Error(`Legacy subscriber storage returned ${sourceResponse.status}.`);

    const sourceEntries = flattenedHash(sourceBody.result);
    const commands = [];
    let invalidSkipped = 0;
    for (let index = 0; index + 1 < sourceEntries.length; index += 2) {
      const email = sourceEntries[index];
      const rawSubscriber = sourceEntries[index + 1];
      try {
        const subscriber = JSON.parse(rawSubscriber);
        if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || subscriber?.email !== email || !subscriber.unsubscribeToken) {
          invalidSkipped += 1;
          continue;
        }
        // HSETNX makes retries safe and never overwrites a subscriber already present in the new database.
        commands.push(['HSETNX', SUBSCRIBERS_KEY, email, rawSubscriber]);
      } catch { invalidSkipped += 1; }
    }

    let imported = 0;
    let alreadyPresent = 0;
    for (let offset = 0; offset < commands.length; offset += 100) {
      const outcomes = await redisPipeline(destination.url, destination.token, commands.slice(offset, offset + 100), 'Upstash subscriber migration');
      for (const outcome of outcomes) {
        if (Number(outcome) === 1) imported += 1;
        else if (Number(outcome) === 0) alreadyPresent += 1;
        else throw new Error('Upstash subscriber migration returned an unexpected write result.');
      }
    }

    const status = { completedAt: new Date().toISOString(), imported, alreadyPresent, invalidSkipped };
    await redisCommand('SET', SUBSCRIBER_MIGRATION_KEY, JSON.stringify(status));
    return status;
  } finally {
    if (await redisCommand('GET', SUBSCRIBER_MIGRATION_LOCK_KEY) === lockToken) {
      await redisCommand('DEL', SUBSCRIBER_MIGRATION_LOCK_KEY);
    }
  }
}

function migrateLegacySubscribers() {
  if (!subscriberMigrationPromise) {
    subscriberMigrationPromise = performLegacySubscriberMigration().finally(() => { subscriberMigrationPromise = null; });
  }
  return subscriberMigrationPromise;
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function allSubscribers() {
  await migrateLegacySubscribers();
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
  const value = await redisCommand('HGET', SUBSCRIBERS_KEY, email);
  if (typeof value !== 'string') return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

async function findSubscriberByToken(token) {
  return (await allSubscribers()).find((item) => item.confirmToken === token || item.unsubscribeToken === token);
}

async function saveSubscriber(subscriber) {
  await redisCommand('HSET', SUBSCRIBERS_KEY, subscriber.email, JSON.stringify(subscriber));
}

async function deleteSubscriber(email) {
  return Number(await redisCommand('HDEL', SUBSCRIBERS_KEY, email)) > 0;
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
  migrateLegacySubscribers,
  removeSubscriber,
  removeSubscriberByEmail,
  redisCommand,
};
