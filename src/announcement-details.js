const cheerio = require('cheerio');
const { categorize } = require('./professions');

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

function rephraseResultDetails(title, category, sourceText, { includePublicationFact = false, paragraphs: sourceParagraphs } = {}) {
  const text = (sourceText || '').replace(/\s+/g, ' ');
  const passMatch = text.match(/([\d,]+)\s+(?:out of|of)\s+([\d,]+)\s+passed the\s+(.+?)(?:\s+given by|\s+in\s+\d+\s+testing centers|\s+last\s+[A-Z]|\.|$)/i);
  const titleSubject = String(title || '')
    .replace(/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s+/i, '')
    .replace(/\s+results?\b.*$/i, '')
    .replace(/^licensure examination for\s+/i, '')
    .replace(/\s+(?:computer[- ]based\s+)?licensure examination.*$/i, '')
    .replace(/\s+examination.*$/i, '')
    .trim();
  const subject = passMatch
    ? passMatch[3].replace(/^licensure examination for\s+/i, '').replace(/\s+licensure examination$/i, '').replace(/\s+examination$/i, '').trim()
    : category !== 'PRC Examination Result' ? category : titleSubject || 'professional';
  const summary = passMatch
    ? `${passMatch[1]} of ${passMatch[2]} candidates passed the ${subject} licensure exam.`
    : `PRC published the results for the ${subject} licensure examination.`;
  const facts = [];
  const paragraphs = Array.isArray(sourceParagraphs) ? sourceParagraphs : text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const addFact = (fact) => {
    const normalized = rephraseParagraph(fact);
    if (normalized && normalized.length <= 600 && !facts.includes(normalized)) facts.push(normalized);
  };
  for (const paragraph of paragraphs) {
    if (/\b(?:administered|held|conducted)\b.{0,220}\b(?:in|at)\b/i.test(paragraph)) addFact(paragraph);
    else if (/\bmembers?\s+of\s+the\s+board\b|\bboard\s+members?\b/i.test(paragraph)) addFact(paragraph);
    else if (/\bregistration\b.{0,220}\b(?:starts?|begins?|opens?|required|register)\b/i.test(paragraph)) addFact(paragraph);
    else if (/\b(?:oath[- ]taking|oathtaking)\b/i.test(paragraph)) addFact(paragraph);
  }
  const centers = text.match(/\b(\d{1,3})\s+testing centers\b/i);
  if (centers && !facts.some((fact) => /\btesting centers\b/i.test(fact))) facts.push(`The examination was held in ${centers[1]} testing centers.`);
  const examPeriod = text.match(/\blast\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\b/i);
  if (examPeriod && !facts.some((fact) => /\bexamination\b.{0,80}\b(?:held|took place)\b/i.test(fact))) facts.push(`The examination took place in ${examPeriod[1]}.`);
  const withheld = text.match(/with respect to\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s*\((\d+)\)\s+examinees?[^.]*withheld/i);
  if (withheld) facts.push(`PRC is still reviewing the results for ${withheld[1]} examinees.`);
  const turnaround = (title + ' ' + text).match(/released\s+(?:in\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s*(?:\(\d+\)\s*)?working days?/i);
  if (turnaround) {
    const numbers = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const days = numbers[turnaround[1].toLowerCase()] || Number(turnaround[1]);
    facts.push(`The results were posted ${days} working ${days === 1 ? 'day' : 'days'} after the exam ended.`);
  }
  if (!facts.length && !passMatch && includePublicationFact) facts.push(`The announcement was published by PRC on ${String(title || '').match(/\b\d{4}\b/)?.[0] || 'the date shown above'}.`);
  return { summary, facts: facts.slice(0, 8) };
}

function extractAnnouncementDetails(html) {
  const $ = cheerio.load(html);
  const paragraphs = [];
  $('article p, main p, .field--name-body p, .node__content p').each((_, element) => {
    const text = rephraseParagraph($(element).text());
    if (text.length >= 25 && !paragraphs.includes(text)) paragraphs.push(text);
  });
  const title = $('h1, .page-title').first().text().replace(/\s+/g, ' ').trim();
  const details = rephraseResultDetails(title, categorize(title), paragraphs.join(' '), { paragraphs });
  return { ...details, paragraphs: paragraphs.slice(0, 30) };
}

module.exports = { extractAnnouncementDetails, rephraseParagraph, rephraseResultDetails };
