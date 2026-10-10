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
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: item.title,
      description,
      datePublished: item.date,
      author: { '@type': 'Organization', name: 'BoardExamTracker' },
      publisher: { '@type': 'Organization', name: 'BoardExamTracker' },
      mainEntityOfPage: canonical,
      citation: item.url,
    };
    const structuredData = document.createElement('script');
    structuredData.type = 'application/ld+json';
    structuredData.textContent = JSON.stringify(schema);
    document.head.append(structuredData);

    resultContent.innerHTML = `<div class="eyebrow blue-eyebrow">BOARD EXAM RESULT</div><span class="detail-category">${escapeHtml(item.category || 'PRC Examination Result')}</span><h1>${escapeHtml(item.title)}</h1><p class="detail-date">Released ${escapeHtml(formatDate(item.date))}</p><p id="result-summary" class="detail-summary">${escapeHtml(item.description || 'This page gathers the result files connected to the announcement. Review the available documents below and confirm important details in the source files.')}</p><div class="detail-source-note"><span aria-hidden="true">✓</span><p>BoardExamTracker is an independent information platform. The attached files are served by the original source. <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">View original PRC announcement</a>.</p></div><section class="detail-documents"><div class="eyebrow">FILES LINKED IN THE NOTICE</div><div id="result-facts" class="result-facts"></div><div id="detail-resources" class="detail-resources" aria-live="polite"><p class="dialog-loading">Loading files linked by the announcement…</p></div></section>`;

    const linksResponse = await fetch(`/api/announcement-links?url=${encodeURIComponent(item.url)}`, { headers: { Accept: 'application/json' } });
    const linksData = await linksResponse.json();
    const resources = document.querySelector('#detail-resources');
    if (!linksResponse.ok) throw new Error(linksData.error || 'Could not load the files linked by this announcement.');
    if (linksData.details?.summary) document.querySelector('#result-summary').textContent = linksData.details.summary;
    document.querySelector('#result-facts').innerHTML = linksData.details?.facts?.length
      ? `<ul>${linksData.details.facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join('')}</ul>`
      : '';
    resources.innerHTML = linksData.resources?.length
      ? linksData.resources.map(renderResource).join('')
      : '<p class="dialog-empty">No separate files were linked in this notice when we checked. Visit the original announcement for any later additions.</p>';
  } catch (error) {
    resultContent.innerHTML = `<h1>Result unavailable</h1><p class="detail-summary">${escapeHtml(error.message || 'This result could not be loaded right now.')}</p><a class="result-home-link" href="/">Back to latest results</a>`;
  }
}

document.querySelector('#back-button').addEventListener('click', () => {
  if (history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) history.back();
  else location.assign('/');
});

loadResult();
