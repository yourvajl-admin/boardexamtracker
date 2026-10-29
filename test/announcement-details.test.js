const test = require('node:test');
const assert = require('node:assert/strict');
const { extractAnnouncementDetails, rephraseResultDetails } = require('../src/announcement-details');

test('extracts a results summary and source-backed key figures from a PRC notice', () => {
  const html = `<article>
    <h1>October 2026 Metallurgical Engineers Computer-Based Licensure Examination Results Released</h1>
    <p>The Professional Regulation Commission (PRC) announces that 36 of 42 passed the Metallurgical Engineers Computer-Based Licensure Examination.</p>
    <p>The examination was administered in N.C.R., Cagayan de Oro, Cebu, and Lucena.</p>
    <p>The members of the Board of Metallurgical Engineering who gave the licensure examination are Engr. Ralph A. Ante, Chairman; Engr. Juancho Pablo S. Calvez and Engr. Ludwig John H. Pascual, Members.</p>
    <p>Registration for the issuance of Professional Identification Cards and Certificates of Registration starts November 12, 2026.</p>
    <p>The date and venue for the oathtaking ceremony will be announced later.</p>
  </article>`;
  const details = extractAnnouncementDetails(html);
  assert.equal(details.summary, '36 of 42 candidates passed the Metallurgical Engineers Computer-Based licensure exam.');
  assert.equal(details.facts.length, 4);
  assert.match(details.facts[0], /Cagayan de Oro, Cebu, and Lucena/);
  assert.match(details.facts[1], /Board of Metallurgical Engineering/);
  assert.match(details.facts[2], /November 12, 2026/);
  assert.match(details.facts[3], /oathtaking ceremony/);
  assert.equal(details.paragraphs.length, 5);
});

test('creates a useful summary and facts when pass counts are unavailable', () => {
  const details = rephraseResultDetails('October 2026 Nurses Licensure Examination Results Released', 'Nursing', 'The examination was held in Manila. Results were released three working days after the exam.');
  assert.match(details.summary, /Nursing licensure examination/);
  assert.ok(details.facts.some((fact) => /Manila/.test(fact)));
  assert.ok(details.facts.some((fact) => /3 working days/.test(fact)));
});
