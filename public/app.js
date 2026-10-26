const SOURCE_URL = 'https://www.prc.gov.ph/articles/exam-results';
const PAGE_SIZE = 12;
const HOME_CARDS = 4;
const SEARCH_ALIASES = {
  cele: ['civil engineer', 'civil engineering'],
  mple: ['master plumber', 'master plumbers'],
  mele: ['mechanical engineer', 'mechanical engineering'],
  let: ['teacher', 'professional teachers'],
  cpa: ['certified public accountant', 'accountancy'],
  nle: ['nurse', 'nursing'],
};
const RESULTS_STORAGE_KEY = 'boardexamtracker:latest-results:v1';
function readSavedResults() {
  try {
    const saved = JSON.parse(localStorage.getItem(RESULTS_STORAGE_KEY) || 'null');
    if (!Array.isArray(saved?.results)) return [];
    return mergeUniqueResults(saved.results).slice(0, PAGE_SIZE);
  } catch { return []; }
}
const params = new URLSearchParams(location.search);
const state = {
  results: readSavedResults(),
  professions: [],
  query: params.get('q')?.trim() || '',
  filter: 'all',
  profession: params.get('profession')?.trim() || 'all',
  year: /^\d{4}$/.test(params.get('year') || '') ? params.get('year') : 'all',
  sort: 'newest',
  limit: PAGE_SIZE,
  archiveLoaded: false,
};
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let resultsRequestActive = false;
let archiveRequest = null;
let lastResultsCheck = Date.now();
const isResultsPage = document.body.dataset.page === 'results';
const homeGrid = document.querySelector('#latest-grid');
const homeStatus = document.querySelector('#latest-status');
const grid = document.querySelector('#results-grid');
const status = document.querySelector('#result-status');
const count = document.querySelector('#result-count');
const empty = document.querySelector('#empty-state');
const loadMore = document.querySelector('#load-more');
const updated = document.querySelector('#last-updated');
const refreshCountdown = document.querySelector('#refresh-countdown');
const refreshButton = document.querySelector('#refresh-button');
const searchInput = document.querySelector('#search-input');
const professionFilter = document.querySelector('#profession-filter');
const yearFilter = document.querySelector('#year-filter');
const sortOrder = document.querySelector('#sort-order');
const adSlot = document.querySelector('#results-ad-slot');
const adsenseUnit = document.querySelector('#adsense-results');
const emailAlertForm = document.querySelector('#email-alert-form');
const emailAlertStatus = document.querySelector('#email-alert-status');
const emailAlertStatusMessage = document.querySelector('#email-alert-status-message');
const emailAlertAvailability = document.querySelector('#email-alert-availability');
const emailAlertButton = emailAlertForm?.querySelector('button[type="submit"]');
if (isResultsPage) searchInput.value = state.query;
let emailAlertsEnabled = false;
let adsenseConfig = null;
let adsenseScriptElement = document.querySelector('script[src^="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]');
let adsenseScriptLoading = Boolean(adsenseScriptElement && !window.adsbygoogle);
let adsenseLibraryLoaded = Boolean(window.adsbygoogle);
let adsenseUnitInitialized = false;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function parseDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}
function formatDate(value, options = { year: 'numeric', month: 'long', day: 'numeric' }) {
  const date = parseDate(value);
  return date ? new Intl.DateTimeFormat('en-PH', options).format(date) : 'Date unavailable';
}
function resultSlug(item) {
  return decodeURIComponent(new URL(item.url).pathname.split('/').filter(Boolean).pop() || 'result');
}
function resultHref(item) {
  return `/results/${encodeURIComponent(resultSlug(item))}`;
}
function resultKind(item) {
  return /\bresults?\b/i.test(item.title) ? '<span class="badge badge-success">Results</span>' : '<span class="badge badge-new">Announcement</span>';
}
function mergeUniqueResults(...lists) {
  const merged = new Map();
  for (const item of lists.flat()) {
    try {
      const url = new URL(item.url);
      if (!['www.prc.gov.ph', 'prc.gov.ph'].includes(url.hostname)) continue;
      url.hostname = 'www.prc.gov.ph';
      url.pathname = url.pathname.replace(/^\/index\.php(?=\/article\/)/, '');
      if (url.pathname.startsWith('/article/')) url.pathname = url.pathname.replace(/\/+$/, '');
      url.search = '';
      url.hash = '';
      merged.set(url.href, { ...item, url: url.href });
    } catch { /* Ignore malformed source links. */ }
  }
  return [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
}
function isRecent(date, days) {
  const d = new Date(`${date}T00:00:00`);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const age = (now - d) / 86400000;
  return age >= 0 && age < days;
}
function filtersActive() {
  return state.query !== '' || state.profession !== 'all' || state.year !== 'all' || state.filter !== 'all';
}
function filteredResults() {
  const matches = state.results.filter((item) => {
    if (state.profession !== 'all' && (item.category || 'PRC Examination Result') !== state.profession) return false;
    if (state.year !== 'all' && !item.date.startsWith(`${state.year}-`)) return false;
    if (state.filter === 'week' && !isRecent(item.date, 7)) return false;
    if (state.filter === 'month' && !isRecent(item.date, 31)) return false;
    const searchable = `${item.title} ${item.category} ${item.description || ''}`.toLowerCase();
    const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    return terms.every((term) => {
      const aliases = SEARCH_ALIASES[term];
      return aliases ? aliases.some((alias) => searchable.includes(alias)) : searchable.includes(term);
    });
  });
  return state.sort === 'oldest' ? matches.reverse() : matches;
}
function syncUrl() {
  const next = new URLSearchParams();
  if (state.query) next.set('q', state.query);
  if (state.profession !== 'all') next.set('profession', state.profession);
  if (state.year !== 'all') next.set('year', state.year);
  const search = next.toString();
  history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
}
function renderHome() {
  if (!homeGrid) return;
  const latest = state.results.slice(0, HOME_CARDS);
  if (!latest.length) return;
  homeGrid.innerHTML = latest.map((item) => `<article class="result-card"><div class="card-head"><span class="card-cat">${escapeHtml(item.category || 'PRC Examination Result')}</span>${resultKind(item)}</div><h3><a href="${resultHref(item)}">${escapeHtml(item.title)}</a></h3>${item.description ? `<p class="card-desc">${escapeHtml(item.description)}</p>` : ''}<p class="card-meta"><i class="ph ph-calendar-blank" aria-hidden="true"></i>Released <time datetime="${escapeHtml(item.date)}">${escapeHtml(formatDate(item.date, { year: 'numeric', month: 'short', day: 'numeric' }))}</time></p><div class="card-foot"><a class="text-link" href="${resultHref(item)}" aria-label="View results: ${escapeHtml(item.title)}">View results <i class="ph ph-arrow-right" aria-hidden="true"></i></a><span class="card-source">Source: prc.gov.ph</span></div></article>`).join('');
}
function render() {
  if (!isResultsPage) { renderHome(); return; }
  renderYearFilter();
  const filtered = filteredResults();
  const visible = filtered.slice(0, state.limit);
  count.textContent = `(${filtered.length})`;
  empty.hidden = filtered.length !== 0;
  grid.hidden = filtered.length === 0;
  loadMore.hidden = (visible.length >= filtered.length && state.archiveLoaded) || state.results.length === 0;
  document.querySelector('#load-more-label').textContent = state.archiveLoaded
    ? 'Load more results'
    : state.query && filtered.length === 0 ? 'Search all results' : 'Browse older results';
  const newest = state.results[0]?.url;
  grid.innerHTML = visible.map((item) => {
    const date = parseDate(item.date);
    const dateBlock = date
      ? `<time class="date-block" datetime="${escapeHtml(item.date)}"><span class="m">${new Intl.DateTimeFormat('en-PH', { month: 'short' }).format(date)}</span><span class="d">${date.getDate()}</span><span class="y">${date.getFullYear()}</span></time>`
      : '<span class="date-block"><span class="m">Date</span><span class="y">n/a</span></span>';
    return `<article class="result-row">${dateBlock}<div class="row-body"><div class="row-badges row-meta"><span class="card-cat">${escapeHtml(item.category || 'PRC Examination Result')}</span>${resultKind(item)}${item.url === newest && state.sort === 'newest' ? '<span class="badge badge-new">Latest</span>' : ''}</div><h3><a href="${resultHref(item)}">${escapeHtml(item.title)}</a></h3>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}<p class="card-meta row-date"><i class="ph ph-calendar-blank" aria-hidden="true"></i>Released <time datetime="${escapeHtml(item.date)}">${escapeHtml(formatDate(item.date, { year: 'numeric', month: 'short', day: 'numeric' }))}</time></p></div><div class="row-actions"><a class="btn btn-primary btn-sm" href="${resultHref(item)}" aria-label="View details: ${escapeHtml(item.title)}">View details <i class="ph ph-arrow-right" aria-hidden="true"></i></a><span class="card-source">Source: prc.gov.ph</span></div></article>`;
  }).join('');
  updateAdSlot();
}
function renderYearFilter() {
  if (!state.archiveLoaded) {
    yearFilter.disabled = true;
    yearFilter.innerHTML = '<option value="all">All years</option>';
    return;
  }
  const years = [...new Set(state.results.map((item) => item.date.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  if (state.year !== 'all' && !years.includes(state.year)) state.year = 'all';
  yearFilter.disabled = false;
  yearFilter.innerHTML = `<option value="all">All years</option>${years.map((year) => `<option value="${year}">${year} (${state.results.filter((item) => item.date.startsWith(`${year}-`)).length})</option>`).join('')}`;
  yearFilter.value = state.year;
}
function updateAdSlot() {
  if (!adSlot) return;
  const showAd = Boolean(adsenseConfig?.enabled)
    && !filtersActive()
    && state.results.length >= 6;
  adSlot.hidden = !showAd;
  if (!adsenseConfig?.clientId) return;
  if (adsenseLibraryLoaded) {
    if (!adSlot.hidden) initializeAdUnit();
    return;
  }

  if (adsenseScriptElement) {
    if (!adsenseScriptLoading) adsenseScriptLoading = true;
    if (!adsenseScriptElement.dataset.boardExamTrackerListeners) {
      adsenseScriptElement.dataset.boardExamTrackerListeners = 'true';
      adsenseScriptElement.addEventListener('load', () => {
        adsenseLibraryLoaded = true;
        adsenseScriptLoading = false;
        updateAdSlot();
      }, { once: true });
      adsenseScriptElement.addEventListener('error', () => {
        adsenseScriptLoading = false;
        adSlot.hidden = true;
      }, { once: true });
    }
    return;
  }

  adsenseScriptLoading = true;
  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(adsenseConfig.clientId)}`;
  adsenseScriptElement = script;
  script.onload = () => {
    adsenseLibraryLoaded = true;
    adsenseScriptLoading = false;
    if (!adSlot.hidden) initializeAdUnit();
  };
  script.onerror = () => {
    adsenseScriptLoading = false;
    adSlot.hidden = true;
  };
  document.head.append(script);
}
function initializeAdUnit() {
  if (adsenseUnitInitialized || !adsenseConfig?.enabled || !adsenseConfig.resultsSlot) return;
  adsenseUnit.dataset.adClient = adsenseConfig.clientId;
  adsenseUnit.dataset.adSlot = adsenseConfig.resultsSlot;
  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
    adsenseUnitInitialized = true;
  } catch {
    adSlot.hidden = true;
  }
}
function renderProfessionFilter(professions) {
  if (!professionFilter) return;
  const countsByProfession = state.results.reduce((counts, item) => {
    const category = item.category || 'PRC Examination Result';
    counts.set(category, (counts.get(category) || 0) + 1);
    return counts;
  }, new Map());
  const names = Array.isArray(professions) && professions.length ? [...professions] : [...countsByProfession.keys()].filter((name) => name !== 'PRC Examination Result').sort();
  if (countsByProfession.has('PRC Examination Result')) names.push('PRC Examination Result');
  professionFilter.innerHTML = '<option value="all">All professions</option>' + names.map((name) => {
    const resultCount = countsByProfession.get(name) || 0;
    const label = state.archiveLoaded
      ? resultCount ? `${name} (${resultCount})` : `${name} — no results`
      : name;
    return `<option value="${escapeHtml(name)}"${state.archiveLoaded && !resultCount && name !== state.profession ? ' disabled' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  professionFilter.value = names.includes(state.profession) ? state.profession : 'all';
}
function setNotice(message, kind = '') {
  const target = isResultsPage ? status : homeStatus;
  if (!target) return;
  target.textContent = message;
  target.className = `status-message ${kind}`;
  target.hidden = !message;
}
function updateRefreshCountdown() {
  const secondsLeft = Math.max(0, Math.ceil((AUTO_REFRESH_MS - (Date.now() - lastResultsCheck)) / 1000));
  if (!resultsRequestActive && secondsLeft === 0 && !document.hidden) loadResults();
  if (!refreshCountdown) return;
  if (resultsRequestActive || secondsLeft === 0) {
    refreshCountdown.textContent = 'Checking for new results…';
    return;
  }
  const minutes = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const seconds = String(secondsLeft % 60).padStart(2, '0');
  refreshCountdown.textContent = `Next automatic check in ${minutes}:${seconds}`;
}
function setLastUpdated(prefix, value) {
  if (updated && value) updated.textContent = `${prefix}: ${new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))}`;
}
async function loadResults(refresh = false) {
  if (resultsRequestActive) return;
  resultsRequestActive = true;
  updateRefreshCountdown();
  if (refreshButton) refreshButton.disabled = true;
  (grid || homeGrid)?.setAttribute('aria-busy', 'true');
  if (!state.results.length && count) count.textContent = '(loading…)';
  try {
    const response = await fetch(`/api/results${refresh ? '?refresh=true' : ''}`, { headers: { Accept: 'application/json' } });
    const data = await response.json();
    state.professions = Array.isArray(data.professions) ? data.professions : state.professions;
    if (!response.ok) throw new Error(data.error || 'Unable to retrieve the latest PRC results.');
    const incoming = Array.isArray(data.results) ? data.results : [];
    if (state.archiveLoaded || data.archiveLoaded) {
      state.results = mergeUniqueResults(state.results, incoming);
      state.archiveLoaded = true;
    } else {
      state.results = mergeUniqueResults(incoming);
    }
    try { localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify({ results: state.results.slice(0, PAGE_SIZE) })); } catch { /* Storage is optional. */ }
    renderProfessionFilter(data.professions);
    setLastUpdated('Last checked', data.lastUpdated);
    setNotice(data.stale ? 'Showing the latest cached results.' : data.warning || '');
    render();
  } catch (error) {
    setNotice("We're having trouble connecting to the official PRC website. Please try again later. Visit PRC.gov.ph for current announcements.", 'error');
    const target = grid || homeGrid;
    if (state.results.length) render();
    else if (target) {
      if (count) count.textContent = '(unavailable)';
      target.innerHTML = `<div class="unavailable"><strong>Unable to retrieve the latest PRC results.</strong><br><a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">Visit PRC.gov.ph <i class="ph ph-arrow-square-out" aria-hidden="true"></i></a></div>`;
    }
  } finally {
    if (refreshButton) refreshButton.disabled = false;
    (grid || homeGrid)?.setAttribute('aria-busy', 'false');
    lastResultsCheck = Date.now();
    resultsRequestActive = false;
    updateRefreshCountdown();
  }
}

async function loadArchiveResults() {
  if (state.archiveLoaded) return state.results;
  if (archiveRequest) return archiveRequest;
  archiveRequest = (async () => {
    grid?.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/results?archive=true', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || !data.archiveLoaded) throw new Error(data.error || data.warning || 'Older results could not be loaded. Please try again.');
      state.results = mergeUniqueResults(state.results, Array.isArray(data.results) ? data.results : []);
      state.archiveLoaded = true;
      if (Array.isArray(data.professions)) state.professions = data.professions;
      renderProfessionFilter(state.professions);
      setLastUpdated('Last updated', data.lastUpdated);
      render();
      return state.results;
    } finally {
      grid?.setAttribute('aria-busy', 'false');
      archiveRequest = null;
    }
  })();
  return archiveRequest;
}
async function ensureArchive(message) {
  try {
    await loadArchiveResults();
    if (message) setNotice(message);
  } catch (error) {
    setNotice(error.message, 'error');
  }
}
function setQuickFilter(value) {
  state.filter = value;
  document.querySelectorAll('.filter').forEach((item) => {
    const active = item.dataset.filter === value;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
}
function resetFilters() {
  state.query = '';
  state.profession = 'all';
  state.year = 'all';
  state.limit = PAGE_SIZE;
  setQuickFilter('all');
  searchInput.value = '';
  professionFilter.value = 'all';
  yearFilter.value = 'all';
  syncUrl();
  render();
}

if (isResultsPage) {
  searchInput.addEventListener('input', (event) => { state.query = event.target.value.trim(); state.limit = PAGE_SIZE; syncUrl(); render(); });
  document.querySelector('#search').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.query && !state.archiveLoaded) ensureArchive();
    document.querySelector('.results-main').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
  document.querySelector('#filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    setQuickFilter(button.dataset.filter);
    state.limit = PAGE_SIZE;
    render();
  });
  professionFilter.addEventListener('change', (event) => {
    state.profession = event.target.value;
    state.limit = PAGE_SIZE;
    syncUrl();
    render();
    if (state.profession !== 'all' && !state.archiveLoaded) ensureArchive();
  });
  yearFilter.addEventListener('change', (event) => { state.year = event.target.value; state.limit = PAGE_SIZE; setQuickFilter('all'); syncUrl(); render(); });
  sortOrder.addEventListener('change', async (event) => {
    state.sort = event.target.value;
    state.limit = PAGE_SIZE;
    render();
    if (state.sort === 'oldest' && !state.archiveLoaded) await ensureArchive('The complete available PRC results archive is loaded.');
  });
  refreshButton.addEventListener('click', () => loadResults(true));
  document.querySelector('#clear-search').addEventListener('click', resetFilters);
  document.querySelector('#clear-filters').addEventListener('click', resetFilters);
  loadMore.addEventListener('click', async () => {
    if (!state.archiveLoaded) {
      loadMore.disabled = true;
      document.querySelector('#load-more-label').textContent = 'Loading older results…';
      try {
        await loadArchiveResults();
        state.limit += PAGE_SIZE;
        setNotice('Older results are now available.');
      } catch (error) {
        setNotice(error.message, 'error');
      } finally {
        loadMore.disabled = false;
      }
    } else {
      state.limit += PAGE_SIZE;
    }
    render();
  });
  renderProfessionFilter(state.professions);
}

if (emailAlertForm) {
  fetch('/api/notifications/status', { headers: { Accept: 'application/json' } })
    .then((response) => response.json())
    .then((data) => {
      emailAlertsEnabled = Boolean(data.available);
      emailAlertButton.disabled = !emailAlertsEnabled;
      emailAlertAvailability.textContent = data.available
        ? 'You’ll receive a confirmation email before alerts begin. Unsubscribe from any alert email.'
        : data.reason === 'storage'
          ? 'Email alerts are temporarily unavailable while secure subscriber storage is being configured.'
          : 'Email alerts are not configured on this server yet.';
    })
    .catch(() => {
      emailAlertsEnabled = false;
      emailAlertButton.disabled = true;
      emailAlertAvailability.textContent = 'Email alert availability could not be checked. Please try again later.';
    });
  emailAlertForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const buttonText = emailAlertButton.innerHTML;
    emailAlertButton.disabled = true;
    emailAlertButton.textContent = 'Sending confirmation…';
    emailAlertStatus.hidden = true;
    emailAlertStatusMessage.textContent = '';
    emailAlertAvailability.textContent = '';
    const email = document.querySelector('#alert-email').value.trim();
    try {
      const response = await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not request email alerts.');
      emailAlertStatusMessage.textContent = /already subscribed/i.test(data.message || '')
        ? `${email} is already subscribed to result alerts.`
        : `We sent a confirmation email to ${email}. Open it and click “Confirm subscription” to start receiving alerts.`;
      emailAlertStatus.hidden = false;
      emailAlertForm.reset();
    } catch (error) {
      emailAlertAvailability.textContent = error.message;
    } finally {
      emailAlertButton.innerHTML = buttonText;
      emailAlertButton.disabled = !emailAlertsEnabled;
    }
  });
  document.querySelector('#email-alert-status-close').addEventListener('click', () => {
    emailAlertStatus.hidden = true;
  });
}

if (adSlot) {
  async function refreshAdSenseConfig() {
    try {
      const response = await fetch('/api/adsense-config', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error('Ad setting unavailable.');
      adsenseConfig = await response.json();
    } catch {
      adsenseConfig = { enabled: false };
    }
    updateAdSlot();
  }
  refreshAdSenseConfig();
  window.setInterval(() => { if (!document.hidden) refreshAdSenseConfig(); }, 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAdSenseConfig(); });
}

if (state.results.length) {
  if (updated) updated.textContent = 'Showing saved latest results while checking for updates…';
  render();
}
loadResults().then(() => {
  // Profession, year and older searches need the full archive; load it straight away for shared links.
  if (isResultsPage && (state.profession !== 'all' || state.year !== 'all' || state.query)) ensureArchive();
});
setInterval(updateRefreshCountdown, 1000);
document.addEventListener('visibilitychange', () => {
  updateRefreshCountdown();
});
