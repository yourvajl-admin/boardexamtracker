const resultContent = document.querySelector('#result-content');
const resultSlug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');

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

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchAnnouncementLinks(articleUrl) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`/api/announcement-links?url=${encodeURIComponent(articleUrl)}`, { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load the files linked by this announcement.');
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(1500 * (attempt + 1));
    }
  }
  throw lastError || new Error('Could not load the files linked by this announcement.');
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
  return `<section class="embedded-document"><h3>${escapeHtml(resource.label)}</h3>${preview ? `<iframe src="${escapeHtml(preview)}" title="${escapeHtml(resource.label)} preview" loading="${index === 0 ? 'eager' : 'lazy'}" referrerpolicy="no-referrer" allow="fullscreen"></iframe>` : '<p class="preview-unavailable">Preview is unavailable for this file.</p>'}<a class="open-file-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">Open file in a new tab <span aria-hidden="true">↗</span></a></section>`;
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

    const canonical = `https://www.boardexamtracker.com/results/${encodeURIComponent(resultSlug)}`;
    const description = (item.description || `View the ${item.category || 'professional licensure'} result documents linked to this announcement.`).slice(0, 300);
    setMeta(item, description, canonical);
    const announcementUrl = canonicalAnnouncementUrl(item.url);
    resultContent.innerHTML = `<div class="eyebrow blue-eyebrow">BOARD EXAM RESULT</div><span class="detail-category">${escapeHtml(item.category || 'PRC Examination Result')}</span><h1>${escapeHtml(item.title)}</h1><p class="detail-date">Released ${escapeHtml(formatDate(item.date))}</p><div id="result-paragraphs" class="detail-announcement"><p class="detail-summary">${escapeHtml(item.description || 'This page gathers the result files connected to the announcement. Review the available documents below and confirm important details in the source files.')}</p></div><div class="detail-source-note"><span aria-hidden="true">✓</span><p>BoardExamTracker is an independent information platform. The attached files are served by the original source. <a href="${escapeHtml(announcementUrl || item.url)}" target="_blank" rel="noopener noreferrer">View original PRC announcement</a>.</p></div><section class="detail-documents"><div class="eyebrow">FILES LINKED IN THE NOTICE</div><div id="result-facts" class="result-facts"></div><div id="detail-resources" class="detail-resources" aria-live="polite"><p class="dialog-loading">Loading files linked by the announcement…</p></div></section>`;

    const resources = document.querySelector('#detail-resources');
    try {
      if (!announcementUrl) throw new Error('The PRC announcement link is invalid.');
      const linksData = await fetchAnnouncementLinks(announcementUrl);
      if (linksData.details?.paragraphs?.length) {
        document.querySelector('#result-paragraphs').innerHTML = linksData.details.paragraphs.map((paragraph) => `<p class="detail-summary">${escapeHtml(paragraph)}</p>`).join('');
      } else if (linksData.details?.summary) {
        document.querySelector('#result-paragraphs').innerHTML = `<p class="detail-summary">${escapeHtml(linksData.details.summary)}</p>`;
      }
      document.querySelector('#result-facts').innerHTML = linksData.details?.facts?.length
        ? `<ul>${linksData.details.facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join('')}</ul>`
        : '';
      resources.innerHTML = linksData.resources?.length
        ? `<div class="result-file-previews">${linksData.resources.map(renderResource).join('')}</div>`
        : '<p class="dialog-empty">No separate files were linked in this notice when we checked. Visit the original announcement for any later additions.</p>';
    } catch {
      resources.innerHTML = `<p class="dialog-empty">The result details are shown above. We could not load the attached files just now. <a href="${escapeHtml(announcementUrl || item.url)}" target="_blank" rel="noopener noreferrer">Open the official PRC announcement</a>, or <button type="button" id="retry-result-files">retry loading the files</button>.</p>`;
      document.querySelector('#retry-result-files')?.addEventListener('click', () => loadResult());
    }
  } catch (error) {
    resultContent.innerHTML = `<h1>Result unavailable</h1><p class="detail-summary">${escapeHtml(error.message || 'This result could not be loaded right now.')}</p><a class="result-home-link" href="/">Back to latest results</a>`;
  }
}

document.querySelector('#back-button').addEventListener('click', () => {
  if (history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) history.back();
  else location.assign('/');
});

loadResult();
