const crypto = require('node:crypto');

const COOKIE_NAME = 'bet_premium_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function secret() {
  return process.env.SUBSCRIBER_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET || '';
}

function isConfigured() {
  return secret().length >= 32;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, salt, expected] = stored.split('$');
  if (!salt || !expected) return false;
  const derived = crypto.scryptSync(String(password), salt, 64);
  const expectedBuf = Buffer.from(expected, 'hex');
  if (expectedBuf.length !== derived.length) return false;
  return crypto.timingSafeEqual(expectedBuf, derived);
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function createSession(userId, email) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: userId, email, iat: now, exp: now + SESSION_TTL_SECONDS, nonce: crypto.randomBytes(16).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifySession(token) {
  if (!isConfigured() || typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  if (!safeEqual(sign(payload), signature)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (data.sub && data.email && Number.isInteger(data.exp) && data.exp > now && data.iat <= now + 60) return data;
  } catch { /* ignore */ }
  return null;
}

function cookieOptions(req) {
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  return { httpOnly: true, sameSite: 'lax', secure: req.secure || forwardedProto === 'https', path: '/', maxAge: SESSION_TTL_SECONDS * 1000 };
}

function setSessionCookie(res, req, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
}

function clearSessionCookie(res, req) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(req), maxAge: undefined });
}

function getSession(req) {
  const token = String(req.headers.cookie || '').split(';').map((p) => p.trim()).find((p) => p.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  return verifySession(token);
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  COOKIE_NAME,
  clearSessionCookie,
  createSession,
  getSession,
  hashPassword,
  isConfigured,
  makeToken,
  setSessionCookie,
  verifyPassword,
  verifySession,
};
