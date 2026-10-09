const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'email-subscribers.json');
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

function readSubscribers() {
  try {
    const entries = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8'));
    if (!Array.isArray(entries)) return [];
    const current = entries.filter((item) => item.confirmedAt || !item.confirmExpiresAt || item.confirmExpiresAt > Date.now());
    if (current.length !== entries.length) writeSubscribers(current);
    return current;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    console.error('Could not read email subscriber data:', error.message);
    return [];
  }
}

function writeSubscribers(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryFile = `${SUBSCRIBERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(entries, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, SUBSCRIBERS_FILE);
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function addPendingSubscriber(email) {
  const entries = readSubscribers();
  let subscriber = entries.find((item) => item.email === email);
  if (subscriber?.confirmedAt) return { status: 'subscribed' };

  const now = Date.now();
  if (!subscriber) {
    subscriber = { email, confirmedAt: null, unsubscribeToken: makeToken() };
    entries.push(subscriber);
  }
  if (subscriber.confirmEmailSentAt && now - subscriber.confirmEmailSentAt < RESEND_COOLDOWN_MS) {
    return { status: 'pending' };
  }

  subscriber.confirmToken = makeToken();
  subscriber.confirmExpiresAt = now + CONFIRMATION_TTL_MS;
  subscriber.confirmEmailSentAt = null;
  writeSubscribers(entries);
  return { status: 'confirmation-required', token: subscriber.confirmToken };
}

function markConfirmationSent(token) {
  const entries = readSubscribers();
  const subscriber = entries.find((item) => item.confirmToken === token);
  if (!subscriber) return;
  subscriber.confirmEmailSentAt = Date.now();
  writeSubscribers(entries);
}

function confirmSubscriber(token) {
  const entries = readSubscribers();
  const subscriber = entries.find((item) => item.confirmToken === token);
  if (!subscriber || !subscriber.confirmExpiresAt || subscriber.confirmExpiresAt < Date.now()) return false;
  subscriber.confirmedAt = Date.now();
  delete subscriber.confirmToken;
  delete subscriber.confirmExpiresAt;
  delete subscriber.confirmEmailSentAt;
  writeSubscribers(entries);
  return true;
}

function removeSubscriber(token) {
  const entries = readSubscribers();
  const remaining = entries.filter((item) => item.unsubscribeToken !== token);
  if (remaining.length === entries.length) return false;
  writeSubscribers(remaining);
  return true;
}

function listConfirmedSubscribers() {
  return readSubscribers().filter((item) => item.confirmedAt && item.unsubscribeToken);
}

module.exports = {
  addPendingSubscriber,
  confirmSubscriber,
  listConfirmedSubscribers,
  markConfirmationSent,
  removeSubscriber,
};
