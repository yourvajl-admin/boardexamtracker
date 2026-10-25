const PRC_URL = 'https://www.prc.gov.ph/articles/exam-results';
const PRC_HOSTS = new Set(['www.prc.gov.ph', 'prc.gov.ph']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const DIAGNOSTIC_HEADERS = [
  'cache-control', 'cf-cache-status', 'cf-ray', 'content-type', 'date', 'etag',
  'last-modified', 'retry-after', 'server', 'via', 'x-cache',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedHeaders(headers) {
  const selected = {};
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = headers?.get?.(name);
    if (value) selected[name] = value.slice(0, 300);
  }
  return selected;
}

function retryAfterMs(value, now) {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function logDiagnostic(logger, fields) {
  logger(JSON.stringify({ event: fields.event || 'prc_http_attempt', timestamp: new Date().toISOString(), ...fields }));
}

async function fetchPrcPage(page, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleepImpl || sleep;
  const logger = options.logger || console.log;
  const now = options.now || Date.now;
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts || 3));
  const baseDelayMs = Math.max(250, options.baseDelayMs ?? 1000);
  const maxBackoffMs = Math.max(baseDelayMs, options.maxBackoffMs ?? 8000);
  const maxRetryAfterMs = Math.max(0, options.maxRetryAfterMs ?? 30000);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 12000);
  const url = new URL(PRC_URL);
  if (Number.isInteger(page) && page > 0) url.searchParams.set('page', String(page));

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let current = new URL(url.href);
    let response;
    const started = now();
    try {
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        response = await fetchImpl(current.href, {
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; BoardExamTracker/1.0; +https://www.boardexamtracker.com)',
            Accept: 'text/html,application/xhtml+xml',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const headers = selectedHeaders(response.headers);
        if (REDIRECT_STATUSES.has(response.status)) {
          logDiagnostic(logger, {
            requestUrl: current.href,
            status: response.status,
            elapsedMs: Math.max(0, now() - started),
            attempt,
            responseHeaders: headers,
          });
          const location = response.headers.get('location');
          const redirected = location ? new URL(location, current) : null;
          if (!redirected || redirected.protocol !== 'https:' || !PRC_HOSTS.has(redirected.hostname)) {
            throw new Error('PRC redirected outside the approved official source hosts.');
          }
          current = redirected;
          continue;
        }

        if (!response.ok) {
          const retryAfter = retryAfterMs(response.headers.get('retry-after'), now());
          logDiagnostic(logger, {
            requestUrl: current.href,
            status: response.status,
            elapsedMs: Math.max(0, now() - started),
            attempt,
            responseHeaders: headers,
          });
          const error = new Error(`PRC returned HTTP ${response.status} for ${current.href}.`);
          error.retryable = RETRYABLE_STATUSES.has(response.status);
          error.retryAfterMs = retryAfter;
          throw error;
        }

        const html = await response.text();
        const elapsedMs = Math.max(0, now() - started);
        logDiagnostic(logger, {
          requestUrl: current.href,
          status: response.status,
          elapsedMs,
          attempt,
          responseHeaders: headers,
          responseBytes: new TextEncoder().encode(html).byteLength,
        });
        if (html.length > 4 * 1024 * 1024) throw new Error('PRC listing response exceeded the 4 MB limit.');
        return { html, url: current.href };
      }
      throw new Error('PRC exceeded the redirect limit.');
    } catch (error) {
      lastError = error;
      if (!response || error.name === 'TimeoutError' || error.name === 'AbortError') {
        logDiagnostic(logger, {
          requestUrl: current.href,
          status: response?.status ?? null,
          elapsedMs: Math.max(0, now() - started),
          attempt,
          responseHeaders: selectedHeaders(response?.headers),
          error: `${error.name || 'Error'}: ${String(error.message || 'Request failed').slice(0, 200)}`,
        });
      }
      const retryable = error.retryable || (!response && ['TypeError', 'TimeoutError', 'AbortError'].includes(error.name));
      if (!retryable || attempt >= maxAttempts) break;

      const exponentialDelay = Math.min(maxBackoffMs, baseDelayMs * (2 ** (attempt - 1)));
      const requestedDelay = error.retryAfterMs;
      if (requestedDelay !== null && requestedDelay !== undefined && requestedDelay > maxRetryAfterMs) {
        logDiagnostic(logger, {
          event: 'prc_retry_deferred',
          requestUrl: url.href,
          status: response?.status ?? null,
          elapsedMs: Math.max(0, now() - started),
          attempt,
          retryDeferred: true,
          retryAfterMs: requestedDelay,
        });
        break;
      }
      const delay = Math.max(exponentialDelay, requestedDelay || 0);
      logDiagnostic(logger, {
        event: 'prc_retry_scheduled',
        requestUrl: url.href,
        status: response?.status ?? null,
        elapsedMs: Math.max(0, now() - started),
        attempt,
        retryInMs: delay,
      });
      await sleepImpl(delay);
    }
  }
  throw new Error(`PRC request failed after bounded retries: ${lastError?.message || 'unknown network error'}`);
}

module.exports = { PRC_URL, fetchPrcPage, retryAfterMs };
