const test = require('node:test');
const assert = require('node:assert/strict');
const { announcementKey, attachAnnouncementDocuments, canonicalArticleUrl, loadPublishedAnnouncements, upsertAnnouncement, validateAnnouncement } = require('../src/announcement-store');

function redisMock() {
  const values = new Map();
  const indexes = new Map();
  return {
    values,
    async command(...args) {
      const [operation, key, value, option] = args;
      if (operation === 'GET') return values.get(key) ?? null;
      if (operation === 'SET') {
        if (option === 'NX' && values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      }
      if (operation === 'ZADD') {
        if (!indexes.has(key)) indexes.set(key, new Map());
        indexes.get(key).set(args[3], Number(value));
        return 1;
      }
      if (operation === 'ZREVRANGE') return [...(indexes.get(key) || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(Number(value), Number(args[3]) + 1).map(([member]) => member);
      if (operation === 'MGET') return args.slice(1).map((recordKey) => values.get(recordKey) ?? null);
      throw new Error(`Unexpected Redis operation: ${operation}`);
    },
  };
}

const item = {
  title: 'October 2026 Civil Engineers Licensure Examination Results Released',
  category: 'Civil Engineering',
  date: '2026-10-25',
  description: 'The PRC published the official result.',
  url: 'https://prc.gov.ph/index.php/article/october-civil-results?source=listing',
};

test('validates canonical PRC announcement fields and rejects ambiguous or unsafe records', () => {
  const result = validateAnnouncement(item);
  assert.equal(result.valid, true);
  assert.equal(result.announcement.url, 'https://www.prc.gov.ph/article/october-civil-results');
  assert.equal(validateAnnouncement({ ...item, date: '2026-02-31' }).valid, false);
  assert.equal(validateAnnouncement({ ...item, title: 'October 2026 Exam Schedule' }).valid, false);
  assert.equal(canonicalArticleUrl('https://evil.example/article/x'), null);
});

test('uses a stable unique record key and preserves first-detected time and attached documents', async () => {
  const redis = redisMock();
  const first = await upsertAnnouncement(item, redis.command, Date.parse('2026-10-25T00:00:00Z'));
  assert.equal(first.isNew, true);
  assert.equal(first.record.publicationStatus, 'published');
  const docs = [{ label: 'Full official result', url: 'https://prc.gov.ph/files/result.pdf' }];
  assert.equal(await attachAnnouncementDocuments(item.url, docs, redis.command), true);
  const second = await upsertAnnouncement(item, redis.command, Date.parse('2026-10-26T00:00:00Z'));
  assert.equal(second.isNew, false);
  assert.equal(second.record.firstDetectedAt, '2026-10-25T00:00:00.000Z');
  assert.equal(second.record.documentUrls.length, 1);
  assert.equal(second.record.lastVerifiedAt, '2026-10-26T00:00:00.000Z');
  assert.equal(redis.values.size, 1);
  assert.ok(redis.values.has(announcementKey(item.url)));
  assert.deepEqual(await loadPublishedAnnouncements(redis.command), [{ title: item.title, date: item.date, url: 'https://www.prc.gov.ph/article/october-civil-results', category: item.category, description: item.description }]);
});

test('does not persist invalid notices or unsafe document links', async () => {
  const redis = redisMock();
  const invalid = await upsertAnnouncement({ ...item, date: null }, redis.command);
  assert.equal(invalid.status, 'pending');
  assert.equal(invalid.record.publicationStatus, 'pending');
  assert.equal(invalid.record.errorDetails, 'The official publication date is missing or invalid.');
  assert.equal(redis.values.size, 1);
  assert.equal(await attachAnnouncementDocuments(item.url, [{ label: 'Unsafe', url: 'https://evil.example/file.pdf' }], redis.command), true);
  assert.deepEqual(JSON.parse(redis.values.get(announcementKey(item.url))).documentUrls, []);
});
