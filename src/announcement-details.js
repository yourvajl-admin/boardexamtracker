const cheerio = require('cheerio');

function rephraseParagraph(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  text = text
    .replace(/^The Professional Regulation Commission\s*\(PRC\)\s+announces that\b/i, 'The Professional Regulation Commission (PRC) reports that')
    .replace(/\bgiven by the (Board of .+?) in\b/i, 'administered by the $1 in')
    .replace(/^The members of the (Board of .+?) who gave the licensure examination are\b/i, 'Members of the $1 who administered the licensure examination were')
    .replace(/^The results were released\b/i, 'PRC released the results')
    .replace(/\bwill be done on-line\b/i, 'will be completed online')
    .replace(/\bThose who will register are required to bring the following\b/i, 'Applicants must bring the following')
    .replace(/\bSuccessful examinees should personally register and sign in\b/i, 'Successful examinees must register in person and sign')
    .replace(/\bWILL BE ANNOUNCED LATER\b/i, 'will be announced at a later date')
    .replace(/\bPlease visit the official PRC website\b/i, 'Visit the official PRC website')
    .replace(/\band follow the instructions for registration\b/i, 'and follow its registration instructions');

  return text;
}

function extractAnnouncementDetails(html) {
  const $ = cheerio.load(html);
  const paragraphs = [];
  $('article p, main p, .field--name-body p, .node__content p').each((_, element) => {
    const text = rephraseParagraph($(element).text());
    if (text.length >= 25 && !paragraphs.includes(text)) paragraphs.push(text);
  });
  return { paragraphs: paragraphs.slice(0, 30) };
}

module.exports = { extractAnnouncementDetails, rephraseParagraph };
