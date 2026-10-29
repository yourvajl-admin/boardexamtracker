const resultContent = document.querySelector('#result-content');
const resultSlug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
const passerCelebration = document.querySelector('#passer-celebration');
let celebrationShown = false;

function showPasserCelebration() {
  if (celebrationShown) return;
  celebrationShown = true;
  const confetti = passerCelebration.querySelector('.celebration-confetti');
  const colors = ['#0875f9', '#ffc857', '#ef476f', '#06d6a0', '#9b5de5'];
  confetti.innerHTML = Array.from({ length: 48 }, (_, index) => {
    const left = (index * 37) % 100;
    const delay = (index % 12) * 0.035;
    const duration = 2.2 + (index % 6) * 0.18;
    const color = colors[index % colors.length];
    const rotation = (index * 47) % 360;
    return `<span style="--confetti-left:${left}%;--confetti-delay:${delay}s;--confetti-duration:${duration}s;--confetti-color:${color};--confetti-rotation:${rotation}deg"></span>`;
  }).join('');
  passerCelebration.showModal();
}

passerCelebration.querySelector('.celebration-close').addEventListener('click', () => passerCelebration.close());
passerCelebration.querySelector('.celebration-continue').addEventListener('click', () => passerCelebration.close());
passerCelebration.addEventListener('click', (event) => {
  if (event.target === passerCelebration) passerCelebration.close();
});

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

function resultSlugFromUrl(value) {
  try { return decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean).pop() || ''); }
  catch { return ''; }
}

function canonicalAnnouncementUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['www.prc.gov.ph', 'prc.gov.ph'].includes(url.hostname)) return '';
    url.pathname = url.pathname.replace(/^\/index\.php(?=\/article\/)/, '');
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

async function fetchAnnouncementLinks(articleUrl) {
  const response = await fetch(`/api/announcement-links?version=3&url=${encodeURIComponent(articleUrl)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load the files linked by this announcement.');
  return data;
}

function previewUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    if (url.hostname === 'drive.google.com') {
      const id = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || url.searchParams.get('id');
      if (id) return `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`;
    }
    return url.href;
  } catch { return ''; }
}

function setMeta(item, description, canonical) {
  document.title = `${item.title} | BoardExamTracker`;
  document.querySelector('meta[name="description"]')?.setAttribute('content', description);
  document.querySelector('link[rel="canonical"]')?.setAttribute('href', canonical);
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', `${item.title} | BoardExamTracker`);
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', description);
  document.querySelector('meta[property="og:url"]')?.setAttribute('content', canonical);
  document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', `${item.title} | BoardExamTracker`);
  document.querySelector('meta[name="twitter:description"]')?.setAttribute('content', description);
}

function renderResource(resource, index) {
  const safeUrl = escapeHtml(resource.url);
  const preview = previewUrl(resource.url);
  return `<section class="file-card"><div class="file-head"><span class="file-icon"><i class="ph ph-file-text" aria-hidden="true"></i></span><h3>${escapeHtml(resource.label)}</h3><a class="btn btn-outline btn-sm open-file-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">Open file <i class="ph ph-arrow-square-out" aria-hidden="true"></i></a></div>${preview ? `<iframe src="${escapeHtml(preview)}" title="${escapeHtml(resource.label)} preview" loading="${index === 0 ? 'eager' : 'lazy'}" referrerpolicy="no-referrer" allow="fullscreen"></iframe>` : '<p class="detail-empty">Preview is unavailable for this file.</p>'}</section>`;
}
function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function renderHighlights(details, { loading = false } = {}) {
  const summary = details?.summary;
  const facts = Array.isArray(details?.facts) ? details.facts : [];
  const fallbackSummary = loading ? 'Loading the source-verified summary…' : 'A verified summary is not available. Please check the official PRC announcement.';
  document.querySelector('#result-paragraphs').innerHTML = `<p>${escapeHtml(summary || fallbackSummary)}</p>`;
  const fallbackFact = loading ? 'Checking the official PRC announcement for key figures…' : 'Key figures are not shown because they could not be verified against the PRC announcement.';
  const visibleFacts = facts.length ? facts : [fallbackFact];
  document.querySelector('#result-facts').innerHTML = `<h3 class="facts-title">Key figures</h3><ul class="key-facts">${visibleFacts.map((fact) => `<li><i class="ph ph-check-circle" aria-hidden="true"></i>${escapeHtml(fact)}</li>`).join('')}</ul>`;
}

async function loadResult() {
  try {
    let response = await fetch('/api/results', { headers: { Accept: 'application/json' } });
    let data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load board exam results.');
    let item = data.results?.find((result) => resultSlugFromUrl(result.url) === resultSlug);

    if (!item) {
      response = await fetch('/api/results?archive=true', { headers: { Accept: 'application/json' } });
      data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load the older result archive.');
      item = data.results?.find((result) => resultSlugFromUrl(result.url) === resultSlug);
    }
    if (!item) throw new Error('This result could not be found in the available PRC results archive.');

    showPasserCelebration();
    const canonical = `https://www.boardexamtracker.com/results/${encodeURIComponent(resultSlug)}`;
    const description = (item.description || `View the ${item.category || 'professional licensure'} result documents linked to this announcement.`).slice(0, 300);
    setMeta(item, description, canonical);
    const announcementUrl = canonicalAnnouncementUrl(item.url);
    const category = item.category || 'PRC Examination Result';
    setText('#result-title', item.title);
    setText('#result-category', category);
    setText('#crumb-category', category);
    setText('#aside-category', category);
    setText('#result-date', formatDate(item.date));
    setText('#aside-date', formatDate(item.date));
    document.querySelector('#result-source').href = announcementUrl || item.url;
    renderHighlights(null, { loading: true });

    const resources = document.querySelector('#detail-resources');
    try {
      if (!announcementUrl) throw new Error('The PRC announcement link is invalid.');
      const linksData = await fetchAnnouncementLinks(announcementUrl);
      const verifiedDetails = linksData.details?.source === 'prc' && linksData.details.version === 2 ? linksData.details : null;
      renderHighlights(verifiedDetails);
      resources.innerHTML = linksData.resources?.length
        ? `<div class="file-list">${linksData.resources.map(renderResource).join('')}</div>`
        : '<p class="detail-empty">No separate files were linked in this notice when we checked. Visit the original announcement for any later additions.</p>';
    } catch {
      renderHighlights(null);
      resources.innerHTML = `<p class="detail-empty">We could not load the linked files or verify the result details just now. <a href="${escapeHtml(announcementUrl || item.url)}" target="_blank" rel="noopener noreferrer">Open the official PRC announcement</a>, or <button type="button" id="retry-result-files">retry loading the files</button>.</p>`;
      document.querySelector('#retry-result-files')?.addEventListener('click', () => loadResult());
    }
  } catch (error) {
    setText('#result-title', 'Result unavailable');
    resultContent.innerHTML = `<section class="detail-card"><p>${escapeHtml(error.message || 'This result could not be loaded right now.')}</p><a class="btn btn-primary" href="/latest-results">Back to latest results</a></section>`;
  }
}

document.querySelector('#back-button').addEventListener('click', () => {
  if (history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) history.back();
  else location.assign('/');
});

loadResult();
