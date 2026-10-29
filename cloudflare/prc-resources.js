const cheerio = require('cheerio');

const RESOURCE_TERMS = /(full text of (?:the )?official result|official result|performance of (?:the )?schools|successful examinees|list of (?:the )?examinees|list of successful|top\s*10|highest places|result document|examinees list)/i;
const RESOURCE_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'prc.gov.ph', 'www.prc.gov.ph']);

function extractResources(html, articleUrl) {
  const $ = cheerio.load(html);
  const content = $('.field--name-body, .node__content').first();
  const article = $('article').first();
  const main = $('main, [role="main"]').first();
  const links = content.length
    ? content.find('a[href]')
    : article.length ? article.find('a[href]') : main.find('a[href]');
  const resources = [];

  links.each((_, element) => {
    const label = $(element).text().replace(/\s+/g, ' ').trim();
    const href = $(element).attr('href');
    if (!href) return;
    try {
      const url = new URL(href, articleUrl);
      if (url.protocol !== 'https:' || !RESOURCE_HOSTS.has(url.hostname)) return;
      const isDriveFile = url.hostname === 'drive.google.com' || url.hostname === 'docs.google.com';
      const isDocument = /\.pdf(?:$|[?#])/i.test(decodeURIComponent(url.pathname));
      if (!RESOURCE_TERMS.test(label) && !isDriveFile && !isDocument) return;
      resources.push({ label: label || 'Official result document', url: url.href });
    } catch {
      // Skip malformed attachment URLs.
    }
  });

  return [...new Map(resources.map((resource) => [resource.url, resource])).values()];
}

module.exports = { extractResources };
