const SOURCE_URL = 'https://www.prc.gov.ph/articles/exam-results';
const PAGE_SIZE = 12;
const SEARCH_ALIASES = {
  cele: ['civil engineer', 'civil engineering'],
  mple: ['master plumber', 'master plumbers'],
  mele: ['mechanical engineer', 'mechanical engineering'],
  let: ['teacher', 'professional teachers'],
  cpa: ['certified public accountant', 'accountancy'],
};
const state = { results: [], professions: [], query: '', filter: 'all', profession: 'all', limit: PAGE_SIZE };
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let resultsRequestActive = false;
let lastResultsCheck = Date.now();
const grid = document.querySelector('#results-grid');
const status = document.querySelector('#result-status');
const count = document.querySelector('#result-count');
const empty = document.querySelector('#empty-state');
const loadMore = document.querySelector('#load-more');
const updated = document.querySelector('#last-updated');
const refreshCountdown = document.querySelector('#refresh-countdown');
const professionTrack = document.querySelector('#profession-cards');
const professionPrev = document.querySelector('#profession-prev');
const professionNext = document.querySelector('#profession-next');
const adSlot = document.querySelector('#results-ad-slot');
const adsenseUnit = document.querySelector('#adsense-results');
const emailAlertForm = document.querySelector('#email-alert-form');
const emailAlertStatus = document.querySelector('#email-alert-status');
const emailAlertButton = emailAlertForm.querySelector('button[type="submit"]');
let emailAlertsEnabled = false;
let adsenseConfig = null;
let adsenseScriptLoading = false;
let adsenseLibraryLoaded = false;
let adsenseUnitInitialized = false;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function formatDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}
function resultSlug(item) {
  return decodeURIComponent(new URL(item.url).pathname.split('/').filter(Boolean).pop() || 'result');
}
function filePreviewUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    if (url.hostname === 'drive.google.com') {
      const match = url.pathname.match(/\/file\/d\/([^/]+)/);
      const id = match?.[1] || url.searchParams.get('id');
      if (id) return `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`;
    }
    return url.href;
  } catch {
    return '';
  }
}
function isRecent(date, days) {
  const d = new Date(`${date}T00:00:00`);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const age = (now - d) / 86400000;
  return age >= 0 && age < days;
}
function filteredResults() {
  return state.results.filter((item) => {
    if (state.profession !== 'all' && item.category !== state.profession) return false;
    if (state.filter === 'week' && !isRecent(item.date, 7)) return false;
    if (state.filter === 'month' && !isRecent(item.date, 31)) return false;
    if (state.filter === 'latest' && !isRecent(item.date, 7)) return false;
    const searchable = `${item.title} ${item.category} ${item.description || ''}`.toLowerCase();
    const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    return terms.every((term) => {
      const aliases = SEARCH_ALIASES[term];
      return aliases ? aliases.some((alias) => searchable.includes(alias)) : searchable.includes(term);
    });
  });
}
function render() {
  const filtered = filteredResults();
  const visible = filtered.slice(0, state.limit);
  count.textContent = `${filtered.length} ${filtered.length === 1 ? 'result' : 'results'}`;
  empty.hidden = filtered.length !== 0;
  grid.hidden = filtered.length === 0;
  loadMore.hidden = visible.length >= filtered.length || filtered.length === 0;
  grid.innerHTML = visible.map((item, index) => `<article class="result-card result-card-open${index === 0 ? ' result-card-latest' : ''}" role="button" tabindex="0" aria-label="Open details for ${escapeHtml(item.title)}" data-open-result="${escapeHtml(item.url)}"><div class="card-top"><span class="category-badge">${escapeHtml(item.category || 'PRC Examination Result')}</span>${index === 0 && state.filter !== 'week' && state.filter !== 'month' ? '<span class="new-badge">Latest</span>' : ''}</div><h3>${escapeHtml(item.title)}</h3><p class="card-subtitle">BoardExamTracker result brief</p>${item.description ? `<p class="card-description">${escapeHtml(item.description)}</p>` : ''}<div class="card-meta"><span>Released: <strong>${escapeHtml(formatDate(item.date))}</strong></span><span>Source: PRC.gov.ph</span></div></article>`).join('');
  updateAdSlot();
}
function updateAdSlot() {
  const showAd = Boolean(adsenseConfig?.enabled)
    && !location.pathname.startsWith('/results/')
    && state.query === ''
    && state.profession === 'all'
    && state.filter === 'all'
    && state.results.length >= 6;
  adSlot.hidden = !showAd;
  if (!adsenseConfig?.clientId || adsenseScriptLoading || location.pathname.startsWith('/results/')) return;
  if (adsenseLibraryLoaded) {
    if (!adSlot.hidden) initializeAdUnit();
    return;
  }

  adsenseScriptLoading = true;
  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(adsenseConfig.clientId)}`;
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
function updateProfessionSlider() {
  const maxScroll = professionTrack.scrollWidth - professionTrack.clientWidth;
  professionPrev.disabled = professionTrack.scrollLeft <= 2;
  professionNext.disabled = maxScroll <= 2 || professionTrack.scrollLeft >= maxScroll - 2;
}
function scrollProfessionCards(direction, distance = 0.8) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  professionTrack.scrollBy({ left: direction * professionTrack.clientWidth * distance, behavior: reducedMotion ? 'auto' : 'smooth' });
}
function renderProfessionCards() {
  const resultCounts = state.results.reduce((counts, result) => {
    const category = result.category || 'PRC Examination Result';
    counts.set(category, (counts.get(category) || 0) + 1);
    return counts;
  }, new Map());
  const categories = state.professions.length
    ? state.professions
    : [...new Set(state.results.map((result) => result.category).filter(Boolean))].sort();
  const colorClasses = ['', 'mint', 'gold', 'lilac', 'rose', 'sky'];
  professionTrack.innerHTML = categories.map((category, index) => {
    const count = resultCounts.get(category) || 0;
    const initials = category.split(/\s+/).filter((word) => !['and', 'of', 'the'].includes(word.toLowerCase())).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
    const countLabel = count ? `<small class="profession-result-count">${count} ${count === 1 ? 'result' : 'results'} available</small>` : '';
    return `<a class="profession-card" href="#latest" data-profession-search="${escapeHtml(category)}" role="listitem" aria-label="Browse ${escapeHtml(category)} results${count ? `, ${count} available` : ''}"><span class="prof-symbol ${colorClasses[index % colorClasses.length]}">${escapeHtml(initials)}</span><b>${escapeHtml(category)}</b><small>Licensure exam results</small>${countLabel}<span class="profession-card-cta">View results <span aria-hidden="true"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg></span></span><span class="card-arrow" aria-hidden="true"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg></span></a>`;
  }).join('');
  requestAnimationFrame(updateProfessionSlider);
}
function setNotice(message, kind = '') { status.textContent = message; status.className = `status-message ${kind}`; status.hidden = !message; }
function updateRefreshCountdown() {
  if (resultsRequestActive) {
    refreshCountdown.textContent = 'Checking for new results…';
    return;
  }
  const secondsLeft = Math.max(0, Math.ceil((AUTO_REFRESH_MS - (Date.now() - lastResultsCheck)) / 1000));
  if (secondsLeft === 0) {
    refreshCountdown.textContent = 'Checking now…';
    if (!document.hidden) loadResults();
    return;
  }
  const minutes = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const seconds = String(secondsLeft % 60).padStart(2, '0');
  refreshCountdown.textContent = `Next automatic check in ${minutes}:${seconds}`;
}
async function loadResults(refresh = false) {
  if (resultsRequestActive) return;
  resultsRequestActive = true;
  updateRefreshCountdown();
  const button = document.querySelector('#refresh-button');
  button.disabled = true;
  button.querySelector('span').innerHTML = '<svg class="ui-icon refresh-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 1-2.3-5.7L20 9"/></svg>';
  grid.setAttribute('aria-busy', 'true');
  if (!state.results.length) count.textContent = 'Loading results…';
  try {
    const response = await fetch(`/api/results${refresh ? '?refresh=true' : ''}`, { headers: { Accept: 'application/json' } });
    const data = await response.json();
    state.professions = Array.isArray(data.professions) ? data.professions : state.professions;
    renderProfessionCards();
    if (!response.ok) throw new Error(data.error || 'Unable to retrieve the latest PRC results.');
    state.results = Array.isArray(data.results) ? data.results : [];
    const countsByProfession = state.results.reduce((counts, item) => {
      const category = item.category || 'PRC Examination Result';
      counts.set(category, (counts.get(category) || 0) + 1);
      return counts;
    }, new Map());
    const professions = Array.isArray(data.professions) ? [...data.professions] : [...countsByProfession.keys()].filter((name) => name !== 'PRC Examination Result').sort();
    if (countsByProfession.has('PRC Examination Result')) professions.push('PRC Examination Result');
    const select = document.querySelector('#profession-filter');
    const previous = select.value;
    select.innerHTML = '<option value="all">All professions</option>' + professions.map((name) => {
      const resultCount = countsByProfession.get(name) || 0;
      const label = resultCount ? `${name} (${resultCount})` : `${name} — no results`;
      return `<option value="${escapeHtml(name)}"${resultCount ? '' : ' disabled'}>${escapeHtml(label)}</option>`;
    }).join('');
    if (countsByProfession.has(previous)) select.value = previous;
    updated.textContent = `Last updated: ${new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.lastUpdated))}`;
    setNotice(data.stale ? 'Showing the latest cached results.' : data.warning || '');
    renderProfessionCards();
    render();
    if (location.pathname.startsWith('/results/')) renderDetail();
  } catch (error) {
    renderProfessionCards();
    setNotice("We're having trouble connecting to the official PRC website. Please try again later. Visit PRC.gov.ph for current announcements.", 'error');
    if (state.results.length) render(); else { count.textContent = 'Results unavailable'; grid.innerHTML = `<div class="unavailable"><strong>Unable to retrieve the latest PRC results.</strong><br><a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">Visit PRC.gov.ph <svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg></a></div>`; }
  } finally {
    button.disabled = false;
    grid.setAttribute('aria-busy', 'false');
    lastResultsCheck = Date.now();
    resultsRequestActive = false;
    updateRefreshCountdown();
  }
}

document.querySelector('#search-input').addEventListener('input', (event) => { state.query = event.target.value.trim(); state.limit = PAGE_SIZE; render(); });
document.querySelector('#search').addEventListener('submit', (event) => { event.preventDefault(); document.querySelector('#latest').scrollIntoView({ behavior: 'smooth' }); });
document.querySelector('#filters').addEventListener('click', (event) => { const button = event.target.closest('[data-filter]'); if (!button) return; document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button)); state.filter = button.dataset.filter; state.limit = PAGE_SIZE; render(); });
document.querySelector('#profession-filter').addEventListener('change', (event) => { state.profession = event.target.value; state.limit = PAGE_SIZE; render(); });
document.querySelector('#refresh-button').addEventListener('click', () => loadResults(true));
grid.addEventListener('click', async (event) => {
  const card = event.target.closest('.result-card-open[data-open-result]');
  if (!card) return;
  const item = state.results.find((result) => result.url === card.dataset.openResult);
  if (!item) return;
  const dialog = document.querySelector('#result-dialog');
  const excerpts = document.querySelector('#dialog-excerpts');
  const resources = document.querySelector('#dialog-resources');
  document.querySelector('#dialog-category').textContent = item.category || 'PRC Examination Result';
  document.querySelector('#dialog-title').textContent = item.title;
  document.querySelector('#dialog-date').textContent = `Posted on ${formatDate(item.date)}`;
  const summary = document.querySelector('#dialog-summary');
  summary.textContent = item.description || 'This entry indexes a public examination result notice. Open the files below to check the information released with it.';
  excerpts.innerHTML = '<li class="dialog-loading">Preparing result facts…</li>';
  resources.innerHTML = '<p class="dialog-loading">Loading files attached to this result…</p>';
  dialog.showModal();
  try {
    const response = await fetch(`/api/announcement-links?url=${encodeURIComponent(item.url)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load announcement details.');
    summary.textContent = data.details?.summary || item.description || 'This entry indexes a public examination result notice. Open the files below to check the information released with it.';
    excerpts.innerHTML = data.details?.facts?.length
      ? data.details.facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join('')
      : '';
    resources.innerHTML = data.resources?.length
      ? data.resources.map((resource, index) => {
        const preview = filePreviewUrl(resource.url);
        return `<section class="embedded-document"><h3>${escapeHtml(resource.label)}</h3>${preview ? `<iframe src="${escapeHtml(preview)}" title="${escapeHtml(resource.label)} preview" loading="${index === 0 ? 'eager' : 'lazy'}" referrerpolicy="no-referrer" allow="fullscreen"></iframe>` : '<p class="preview-unavailable">Preview is unavailable for this file.</p>'}<a class="open-file-link" href="${escapeHtml(resource.url)}" target="_blank" rel="noopener noreferrer">Open file in a new tab <svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg></a></section>`;
      }).join('')
      : '<p class="dialog-empty">No separate files were linked from this notice when we checked. Check the source announcement for any later additions.</p>';
  } catch {
    excerpts.innerHTML = '<li>More result details are temporarily unavailable.</li>';
    resources.innerHTML = '<p class="dialog-empty">The attached result links could not be loaded. Please try again later.</p>';
  }
});
grid.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const card = event.target.closest('.result-card-open[data-open-result]');
  if (!card) return;
  event.preventDefault();
  card.click();
});
document.querySelector('#dialog-close').addEventListener('click', () => document.querySelector('#result-dialog').close());
document.querySelector('#result-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
const disclaimerDialog = document.querySelector('#disclaimer-dialog');
document.querySelector('#open-disclaimer').addEventListener('click', () => disclaimerDialog.showModal());
document.querySelector('#disclaimer-close').addEventListener('click', () => disclaimerDialog.close());
disclaimerDialog.addEventListener('click', (event) => { if (event.target === disclaimerDialog) disclaimerDialog.close(); });
async function renderDetail() {
  const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const item = state.results.find((result) => resultSlug(result) === slug);
  const detail = document.querySelector('#detail-view');
  document.querySelectorAll('#main > *').forEach((section) => { section.hidden = section !== detail; });
  detail.hidden = false;
  if (!item) {
    detail.innerHTML = '<a class="detail-back" href="/"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H5m6-6-6 6 6 6"/></svg> Back to latest results</a><h1>Result not found</h1><p>This announcement may no longer be listed in the latest PRC results feed.</p>';
    return;
  }
  document.title = `${item.title} | BoardExamTracker`;
  detail.innerHTML = `<a class="detail-back" href="/"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H5m6-6-6 6 6 6"/></svg> Back to latest results</a><div class="detail-shell"><div class="eyebrow blue-eyebrow">BOARD EXAM RESULT</div><span class="detail-category">${escapeHtml(item.category || 'PRC Examination Result')}</span><h1>${escapeHtml(item.title)}</h1><p class="detail-date">Released ${escapeHtml(formatDate(item.date))}</p><p class="detail-summary">This page brings the result files associated with this notice together in one place. Use the document previews below to review the information, then confirm names and other important details in the source files.</p><div class="detail-source-note"><span><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg></span><p>Titles, release dates, and document links are indexed from public PRC notices. BoardExamTracker's summaries and navigation are independently written. The files are provided by their original source.</p></div><section class="detail-documents"><div class="eyebrow">FILES LINKED IN THE NOTICE</div><div id="detail-resources" class="detail-resources" aria-live="polite"><p class="dialog-loading">Loading links published with the announcement…</p></div></section></div>`;
  const resources = document.querySelector('#detail-resources');
  try {
    const response = await fetch(`/api/announcement-links?url=${encodeURIComponent(item.url)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load announcement links.');
    resources.innerHTML = data.resources.length
      ? data.resources.map((resource) => `<a class="resource-link" href="${escapeHtml(resource.url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(resource.label)}</span><b aria-hidden="true"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg></b></a>`).join('')
      : '<p class="dialog-empty">This announcement has no separate result document links. Check back later for updates.</p>';
  } catch {
    resources.innerHTML = '<p class="dialog-empty">Result document links could not be loaded. Return to the results list and try again later.</p>';
  }
}
loadMore.addEventListener('click', () => { state.limit += PAGE_SIZE; render(); });
document.querySelector('#clear-search').addEventListener('click', () => { state.query = ''; state.filter = 'all'; state.profession = 'all'; state.limit = PAGE_SIZE; document.querySelector('#search-input').value = ''; document.querySelector('#profession-filter').value = 'all'; document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item.dataset.filter === 'all')); render(); });
document.querySelectorAll('[data-search]').forEach((link) => link.addEventListener('click', () => { const term = link.dataset.search; document.querySelector('#search-input').value = term; state.query = term; state.limit = PAGE_SIZE; render(); }));
professionTrack.addEventListener('click', (event) => {
  const link = event.target.closest('[data-profession-search]');
  if (!link) return;
  event.preventDefault();
  state.query = link.dataset.professionSearch;
  state.profession = 'all';
  state.filter = 'all';
  state.limit = PAGE_SIZE;
  document.querySelector('#search-input').value = state.query;
  document.querySelector('#profession-filter').value = 'all';
  document.querySelectorAll('.filter').forEach((button) => button.classList.toggle('active', button.dataset.filter === 'all'));
  render();
  document.querySelector('#latest').scrollIntoView({ behavior: 'smooth' });
});
professionPrev.addEventListener('click', () => scrollProfessionCards(-1));
professionNext.addEventListener('click', () => scrollProfessionCards(1));
professionTrack.addEventListener('scroll', updateProfessionSlider, { passive: true });
professionTrack.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    scrollProfessionCards(event.key === 'ArrowRight' ? 1 : -1, 0.7);
  }
});
window.addEventListener('resize', updateProfessionSlider);
const menuToggle = document.querySelector('.menu-toggle');
menuToggle.addEventListener('click', () => { const open = menuToggle.getAttribute('aria-expanded') !== 'true'; menuToggle.setAttribute('aria-expanded', String(open)); menuToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation'); document.querySelector('#primary-nav').classList.toggle('open', open); });
document.querySelectorAll('#primary-nav a').forEach((link) => link.addEventListener('click', () => { menuToggle.setAttribute('aria-expanded', 'false'); document.querySelector('#primary-nav').classList.remove('open'); }));
if (location.pathname.startsWith('/results/')) {
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest('a[href^="#"]');
    if (!anchor) return;
    event.preventDefault();
    location.href = `/${anchor.getAttribute('href')}`;
  });
}
document.querySelector('#year').textContent = new Date().getFullYear();
fetch('/api/notifications/status', { headers: { Accept: 'application/json' } })
  .then((response) => response.json())
  .then((data) => {
    emailAlertsEnabled = Boolean(data.available);
    emailAlertButton.disabled = !emailAlertsEnabled;
    emailAlertStatus.textContent = data.available
      ? 'You’ll receive a confirmation email before alerts begin. Unsubscribe from any alert email.'
      : data.reason === 'storage'
        ? 'Email alerts are temporarily unavailable while secure subscriber storage is being configured.'
        : 'Email alerts are not configured on this server yet.';
  })
  .catch(() => {
    emailAlertsEnabled = false;
    emailAlertButton.disabled = true;
    emailAlertStatus.textContent = 'Email alert availability could not be checked. Please try again later.';
  });
fetch('/api/adsense-config', { headers: { Accept: 'application/json' } })
  .then((response) => response.json())
  .then((config) => {
    adsenseConfig = config;
    updateAdSlot();
  })
  .catch(() => { adsenseConfig = { enabled: false }; });
emailAlertForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const buttonText = emailAlertButton.innerHTML;
  emailAlertButton.disabled = true;
  emailAlertButton.textContent = 'Sending confirmation…';
  emailAlertStatus.textContent = '';
  try {
    const response = await fetch('/api/notifications/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: document.querySelector('#alert-email').value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not request email alerts.');
    emailAlertStatus.textContent = data.message;
    emailAlertForm.reset();
  } catch (error) {
    emailAlertStatus.textContent = error.message;
  } finally {
    emailAlertButton.innerHTML = buttonText;
    emailAlertButton.disabled = !emailAlertsEnabled;
  }
});
loadResults();
setInterval(updateRefreshCountdown, 1000);
document.addEventListener('visibilitychange', () => {
  updateRefreshCountdown();
});
