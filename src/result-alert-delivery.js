const { createHash, randomUUID } = require('node:crypto');

const DELIVERY_KEY_PREFIX = 'boardexamtracker:result-alert:sent:v1:';
const DELIVERY_LOCK_PREFIX = 'boardexamtracker:result-alert:lock:v1:';
const DELIVERY_TTL_SECONDS = 60 * 60 * 24 * 365;

function deliveryId(email, url) {
  return createHash('sha256').update(`${String(email).trim().toLowerCase()}\n${url}`).digest('hex');
}

async function sendUndeliveredResultAlert(subscriber, results, { redisCommand, send, logger = console } = {}) {
  const uniqueResults = [...new Map(results.filter((result) => result?.url).map((result) => [result.url, result])).values()];
  if (!uniqueResults.length) return { sent: false, alreadySent: true };
  const batchId = createHash('sha256').update(uniqueResults.map((result) => result.url).sort().join('\n')).digest('hex');
  const keyId = deliveryId(subscriber.email, batchId);
  const deliveredKey = `${DELIVERY_KEY_PREFIX}${keyId}`;
  if (await redisCommand('GET', deliveredKey) === 'sent') return { sent: false, alreadySent: true };
  const lockKey = `${DELIVERY_LOCK_PREFIX}${keyId}`;
  const lockToken = randomUUID();
  const lock = await redisCommand('SET', lockKey, lockToken, 'NX', 'EX', 300);
  if (lock !== 'OK') return { sent: false, inProgress: true };
  const idempotencyKey = `bet-${createHash('sha256').update(`${subscriber.email}\n${batchId}`).digest('hex')}`;

  try {
    await send(subscriber, uniqueResults, { idempotencyKey });
    await redisCommand('SET', deliveredKey, 'sent', 'EX', DELIVERY_TTL_SECONDS);
    return { sent: true, count: uniqueResults.length };
  } catch (error) {
    logger.error?.(`New-result alert failed for ${subscriber.email}: ${error.message}`);
    throw error;
  } finally {
    try {
      const current = await redisCommand('GET', lockKey);
      if (current === lockToken) await redisCommand('DEL', lockKey);
    } catch (error) {
      logger.warn?.(`Could not clear result-alert delivery lock: ${error.message}`);
    }
  }
}

module.exports = { DELIVERY_KEY_PREFIX, DELIVERY_LOCK_PREFIX, deliveryId, sendUndeliveredResultAlert };
