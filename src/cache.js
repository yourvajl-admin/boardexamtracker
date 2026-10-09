const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = null;

function getCache() {
  if (!cache) return null;
  return { ...cache, stale: Date.now() - cache.fetchedAt >= CACHE_TTL_MS };
}

function setCache(results) {
  cache = { results, fetchedAt: Date.now() };
  return cache;
}

function isFresh() {
  return Boolean(cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS);
}

module.exports = { CACHE_TTL_MS, getCache, setCache, isFresh };
