const cheerio = require('cheerio');

function extractResultDetails(sourceText, { paragraphs: sourceParagraphs } = {}) {
  const paragraphs = (Array.isArray(sourceParagraphs) ? sourceParagraphs : String(sourceText || '').split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((paragraph) => String(paragraph || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const summaryIndex = paragraphs.findIndex((paragraph) => /\bpassed\b/i.test(paragraph) && /\d/.test(paragraph));
  const selectedSummaryIndex = summaryIndex >= 0 ? summaryIndex : paragraphs.length ? 0 : -1;
  return {
    summary: selectedSummaryIndex >= 0 ? paragraphs[selectedSummaryIndex] : '',
    facts: paragraphs.filter((_, index) => index !== selectedSummaryIndex).slice(0, 12),
  };
}

function extractAnnouncementDetails(html) {
  const $ = cheerio.load(html);
  const paragraphs = [];
  $('article p, main p, .field--name-body p, .node__content p').each((_, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    if (text.length >= 25 && !paragraphs.includes(text)) paragraphs.push(text);
  });
  const details = extractResultDetails(paragraphs.join(' '), { paragraphs });
  return { ...details, paragraphs: paragraphs.slice(0, 30), source: 'prc', version: 2 };
}

module.exports = { extractAnnouncementDetails, extractResultDetails };
