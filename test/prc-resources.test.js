const test = require('node:test');
const assert = require('node:assert/strict');
const { extractResources } = require('../cloudflare/prc-resources');

const articleUrl = 'https://www.prc.gov.ph/article/may-2026-radiologic-technologists';

test('extracts and embeds the result documents from an older PRC article', () => {
  const html = `<html><body>
    <nav><a href="https://www.prc.gov.ph/sites/default/files/privacy.pdf">Privacy Notice</a></nav>
    <article>
      <h1>May 2026 Radiologic Technologists Results</h1>
      <p>Announcement details.</p>
      <a href="https://drive.google.com/file/d/radiologic-result/view?usp=sharing">Full text of the Official Result</a>
      <a href="https://drive.google.com/file/d/radiologic-schools/view">Performance of Schools</a>
    </article>
  </body></html>`;

  assert.deepEqual(extractResources(html, articleUrl), [
    { label: 'Full text of the Official Result', url: 'https://drive.google.com/file/d/radiologic-result/view?usp=sharing' },
    { label: 'Performance of Schools', url: 'https://drive.google.com/file/d/radiologic-schools/view' },
  ]);
});

test('includes linked PRC PDFs in announcement content but excludes unrelated links', () => {
  const html = `<main>
    <a href="https://www.prc.gov.ph/sites/default/files/old-result.pdf">Download</a>
    <a href="https://example.com/result.pdf">External result</a>
    <a href="https://www.prc.gov.ph/another-announcement">Another announcement</a>
  </main>`;

  assert.deepEqual(extractResources(html, articleUrl), [
    { label: 'Download', url: 'https://www.prc.gov.ph/sites/default/files/old-result.pdf' },
  ]);
});
