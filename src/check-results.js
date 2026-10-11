const { fetchResults } = require('./scraper');

async function main() {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('Missing CRON_SECRET.');

  // Fetch from the GitHub runner, then hand the official-source data to the
  // production API. This avoids depending on Vercel outbound access to PRC.
  const results = await fetchResults({ maxPage: 2 });
  const response = await fetch('https://www.boardexamtracker.com/api/cron/check-results', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'User-Agent': 'BoardExamTracker scheduled result checker',
    },
    body: JSON.stringify({ results }),
    signal: AbortSignal.timeout(60_000),
  });
  const message = await response.text();
  if (!response.ok) throw new Error(`BoardExamTracker returned HTTP ${response.status}: ${message}`);
  process.stdout.write(`${message}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
