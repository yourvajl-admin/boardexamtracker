const crypto = require('node:crypto');

const VIEWERS_KEY = 'boardexamtracker:active-viewers';
const VIEWER_TTL_MS = 90_000;
const localViewers = new Map();

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
  return { url: url.replace(/\/+$/, ''), token, configured: Boolean(url && token) };
}

function hasSharedViewerStorage() {
  return redisConfig().configured;
}

function validateVisitorId(value) {
  return typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
}

function localCount(now = Date.now()) {
  for (const [id, seenAt] of localViewers) if (now - seenAt > VIEWER_TTL_MS) localViewers.delete(id);
  return localViewers.size;
}

async function redisPipeline(commands) {
  const { url, token } = redisConfig();
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  const data = await response.json();
  if (!response.ok || data.some((item) => item.error)) throw new Error('Shared viewer storage request failed.');
  return data.map((item) => item.result);
}

function sharedCommands(now, id) {
  const cutoff = now - VIEWER_TTL_MS;
  const commands = [['ZREMRANGEBYSCORE', VIEWERS_KEY, '-inf', cutoff]];
  if (id) commands.push(['ZADD', VIEWERS_KEY, now, id]);
  commands.push(['EXPIRE', VIEWERS_KEY, 120], ['ZCARD', VIEWERS_KEY]);
  return commands;
}

async function recordViewerHeartbeat(visitorId) {
  if (!validateVisitorId(visitorId)) throw new Error('Invalid viewer session.');
  const now = Date.now();
  if (!hasSharedViewerStorage()) {
    localViewers.set(crypto.createHash('sha256').update(visitorId).digest('hex'), now);
    return { count: localCount(now), shared: false };
  }
  const hashedId = crypto.createHash('sha256').update(visitorId).digest('hex');
  const results = await redisPipeline(sharedCommands(now, hashedId));
  return { count: Number(results.at(-1)) || 0, shared: true };
}

async function getActiveViewerCount() {
  const now = Date.now();
  if (!hasSharedViewerStorage()) return { count: localCount(now), shared: false };
  const results = await redisPipeline(sharedCommands(now));
  return { count: Number(results.at(-1)) || 0, shared: true };
}

module.exports = { getActiveViewerCount, hasSharedViewerStorage, recordViewerHeartbeat };
