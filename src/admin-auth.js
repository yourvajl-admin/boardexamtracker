const crypto = require('node:crypto');

const COOKIE_NAME = 'bet_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function adminConfig() {
  const username = process.env.ADMIN_USERNAME || '';
  const password = process.env.ADMIN_PASSWORD || '';
  const secret = process.env.ADMIN_SESSION_SECRET || '';
  return { username, password, secret, configured: Boolean(username && password && secret.length >= 32) };
}

function safeEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createSession(username, secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: username, iat: now, exp: now + SESSION_TTL_SECONDS, nonce: crypto.randomBytes(16).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function verifySession(token) {
  const { username, secret, configured } = adminConfig();
  if (!configured || typeof token !== 'string') return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;
  if (!safeEqual(sign(payload, secret), signature)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    return data.sub === username && Number.isInteger(data.exp) && data.exp > now && data.iat <= now + 60;
  } catch {
    return false;
  }
}

function cookieOptions(req) {
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  return { httpOnly: true, sameSite: 'strict', secure: req.secure || forwardedProto === 'https', path: '/', maxAge: SESSION_TTL_SECONDS * 1000 };
}

function setSessionCookie(res, req, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
}

function clearSessionCookie(res, req) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(req), maxAge: undefined });
}

function isAuthenticated(req) {
  const token = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  return verifySession(token);
}

function authenticate(username, password) {
  const config = adminConfig();
  return config.configured && safeEqual(username, config.username) && safeEqual(password, config.password);
}

module.exports = { adminConfig, authenticate, clearSessionCookie, createSession, isAuthenticated, setSessionCookie };
