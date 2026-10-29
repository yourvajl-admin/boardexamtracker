const test = require('node:test');
const assert = require('node:assert/strict');
const { extractAnnouncementDetails, extractResultDetails } = require('../src/announcement-details');

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
  assert.equal(details.summary, 'The Professional Regulation Commission (PRC) announces that 36 of 42 passed the Metallurgical Engineers Computer-Based Licensure Examination.');
  assert.equal(details.source, 'prc');
  assert.equal(details.version, 2);
  assert.equal(details.facts.length, 4);
  assert.equal(details.facts[0], 'The examination was administered in N.C.R., Cagayan de Oro, Cebu, and Lucena.');
  assert.match(details.facts[1], /^The members of the Board of Metallurgical Engineering/);
  assert.match(details.facts[2], /^Registration for the issuance/);
  assert.match(details.facts[3], /^The date and venue for the oathtaking ceremony/);
  assert.equal(details.paragraphs.length, 5);
});

test('preserves multiple exam results and source paragraphs without inventing figures', () => {
  const details = extractResultDetails('', {
    paragraphs: [
      '914 of 1,197 passed the Chemists Computer-Based Licensure Examination and 3,250 out of 3,742 passed the Chemical Technicians Licensure Examination.',
      'The examinations were administered in N.C.R., Baguio, and Cebu.',
    ],
  });
  assert.equal(details.summary, '914 of 1,197 passed the Chemists Computer-Based Licensure Examination and 3,250 out of 3,742 passed the Chemical Technicians Licensure Examination.');
  assert.deepEqual(details.facts, ['The examinations were administered in N.C.R., Baguio, and Cebu.']);
});

test('does not invent a summary or key figures when the source has no announcement paragraphs', () => {
  assert.deepEqual(extractResultDetails('', { paragraphs: [] }), { summary: '', facts: [] });
});
