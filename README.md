# BoardExamTracker

BoardExamTracker is an independent, responsive tracker for Philippine professional licensure examination results. Its authoritative source is the [PRC Exam Results page](https://www.prc.gov.ph/articles/exam-results). It is not affiliated with, endorsed by, or operated by the Professional Regulation Commission.

## Features

- Fetches public result announcements across the paginated PRC results archive and presents files linked in each PRC announcement.
- Extracts titles and release dates, then creates short rephrased summaries; classifies titles against the complete list of 46 PRC professional regulatory board categories.
- Writes concise summaries from selected facts such as pass counts, exam timing, testing centers, and release turnaround; it does not reproduce announcement paragraphs as site copy.
- Removes duplicate announcement URLs and sorts newest first.
- Caches the PRC response for five minutes, supports an explicit refresh, and serves stale cached results when PRC is unavailable.
- Refreshes the PRC archive in the background every five minutes; open pages show a live countdown and check for updated results automatically.
- Responsive results cards, instant search (including CELE, MPLE, and MELE acronym matching), date and profession filters, and progressive loading.
- Persistent light/dark appearance toggle in the header, with color-aware logos and browser theme color.
- Horizontal, touch-friendly carousel for all 46 PRC profession categories, with counts derived from the fetched results.
- Opt-in email alerts with email confirmation and an unsubscribe link; alerts are sent when the five-minute PRC check discovers new announcements. Subscriber records use Upstash Redis in production and a private local JSON file for development.
- Private `/admin` page with a searchable subscriber email list, manual unsubscribe controls, and an active-viewer count refreshed every 15 seconds.
- One optional, manually placed responsive AdSense unit on the homepage, below the results and load-more control; no auto ads, sticky ads, pop-ups, ads in result cards, or ads in detail panels.
- Privacy policy at `/privacy.html`; `/ads.txt` is generated from the AdSense publisher ID when configured.
- Semantic page structure, keyboard focus states, metadata, Open Graph/Twitter tags, JSON-LD, robots.txt and sitemap.xml.
- Original BoardExamTracker logo lockup with a square document-check mark, closely aligned name, SVG originals, and transparent 1400 × 280 PNG exports for light and dark backgrounds.

## Requirements

Node.js 18 or newer and npm.

## Installation

```sh
npm install
```

## Development

```sh
npm run dev
```

Open <http://localhost:3000>. The development server watches the backend source.

## Production

```sh
npm start
```

Set `PORT` to change the default port (3000). Email alerts use Resend and require all of these variables in `.env` or the hosting environment:

- `RESEND_API_KEY`: Resend API key.
- `EMAIL_FROM`: sender address on a domain verified with Resend, for example `BoardExamTracker <alerts@example.com>`.
- `PUBLIC_BASE_URL`: public HTTPS site URL used in confirmation and unsubscribe links (for local development, `http://localhost:3000` is accepted).

Copy `.env.example` to `.env`, fill in those values, then restart the server. Without them, the signup form reports that email alerts are unavailable and does not accept subscriptions. The first full archive load establishes the baseline and does not send a large batch of old results; alerts are sent for announcements discovered on later five-minute checks. Subscriber addresses and confirmation tokens are stored in the ignored `data/email-subscribers.json` file, so keep that directory on persistent private storage and include it in protected backups. The user confirms subscription by email, and each alert contains an unsubscribe link.

## Private admin page

Visit `/admin` to sign in to the private email-alert dashboard. It is not linked from public navigation. The dashboard provides a searchable subscriber email list, a manual unsubscribe action, and an active-viewer count refreshed every 15 seconds. Configure `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_SESSION_SECRET` in the server environment; the session secret must be at least 32 characters (`openssl rand -hex 32` generates one). Admin sessions use an HTTP-only, same-site cookie and expire after eight hours. Sign-in attempts are rate-limited. On Vercel, enter the credentials under Project Settings → Environment Variables and redeploy. Do not commit real credentials or send them in chat.

In production, configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from an Upstash Redis database. The same private store holds subscriber records and hashed, random active-viewer session IDs. A visitor is counted while a visible page sends a heartbeat and for up to 90 seconds after its last heartbeat. Without these variables, production email signups and manual subscriber management are disabled, and the admin page explains that a reliable cross-instance viewer count is unavailable. Local development falls back to the ignored `data/email-subscribers.json` file and a per-process viewer count. Existing local file records are not automatically copied into Redis.

## API

`GET /api/results` returns `{ results, lastUpdated, cached, stale, source }`. Add `?refresh=true` to bypass the five-minute fresh-cache window. A cache refresh request is shared with any concurrent refresh. If PRC is unavailable, stale results are returned when present; without a cache, the endpoint returns HTTP 503 and an empty result list.

The server reads the full PRC archive on startup. It then checks the three newest listing pages every five minutes and merges new announcements into the cached archive, avoiding repeated requests for older pages. Open browser tabs check for fresh results every five minutes while visible, so updates appear without manually pressing the refresh button.

## AdSense setup

AdSense is off unless it is explicitly enabled in production. After Google approves the site and you create one responsive display ad unit, set `ADSENSE_CLIENT_ID=ca-pub-...`, `ADSENSE_SLOT_ID_RESULTS=<the unit's numeric slot ID>`, and `ADSENSE_ENABLED=true` in the production environment. The client ID can load the AdSense library for site verification before monetization is enabled; an ad is only requested when the site is in production, the enable flag is true, and the visitor is viewing the unfiltered homepage results list. `/ads.txt` is served from that publisher ID in Google's expected format. Never use another publisher's ID. Do not enable Auto ads if you want to keep the one-slot layout.

The single ad placement is clearly labeled, in normal document flow, and separated from result cards and controls. It is hidden on search/filter views and result detail pages. Keep a current privacy policy; configure a Google-certified consent management platform for personalized ads in the EEA, UK, or Switzerland before enabling ads for those regions. Google reviews the actual deployed site and makes its own approval decision. Its guidance emphasizes original, useful content and disallows ads on scraped or copyrighted content; this site must offer enough original value beyond the PRC result feed to qualify.

`GET /api/announcement-links?url=<PRC article URL>` extracts selected result facts and document links (such as the official result, performance of schools, and successful examinees list) from that announcement. The endpoint only fetches validated PRC article and legacy node URLs and caches extracted details for five minutes. Selecting a result card opens a floating BoardExamTracker details panel with a short factual summary and embedded previews of files linked from the notice. The panel does not reproduce the complete announcement body. Documents remain hosted at the destinations PRC published.

`GET /api/notifications/status` reports whether mail delivery is configured. `POST /api/notifications/subscribe` accepts `{ "email": "person@example.com" }` and sends a confirmation message. Confirmed addresses receive a digest when a refresh detects new PRC announcements. Confirmation and unsubscribe links require a button click, so automated email link previews do not activate or remove a subscription.

## Scraper maintenance

All extraction logic lives in `src/scraper.js`. It fetches `https://www.prc.gov.ph/articles/exam-results` and follows the numbered pages advertised by the official listing, pausing between page requests. It accepts HTTPS links on the `prc.gov.ph` host, finds linked titles with a dated result listing ancestor, and extracts the listing excerpt. It rejects undated items and non-result titles, deduplicates by normalized announcement URL and sorts by ISO date descending. No PRCBoard content is used.

If PRC changes its page markup, inspect the public results listing and update the pagination selector in `getLastPage()` or listing ancestor/date/excerpt selection in `extractResults()`. Keep URL host validation, date validation, deduplication, and sorting in place. A change that prevents reliable date extraction should not be worked around by inventing release dates. The category taxonomy and classifier are in `PROFESSION_CATEGORIES` and `categorize()` in `src/scraper.js`; the taxonomy follows PRC's [Professional Regulatory Boards directory](https://www.prc.gov.ph/professional-regulatory-boards). Unrecognized titles use the generic “PRC Examination Result” category.

## Source and disclaimer

BoardExamTracker's interface, navigation, search tools, explanations, and concise summaries are independently written. Result titles, release dates, reported figures, and document labels are taken from public PRC notices for identification and accuracy. The full announcement text and attached documents belong to their respective source publishers; they are not presented as BoardExamTracker-authored material. Embedded files are served from the destinations linked by PRC. Verify names, outcomes, conditions, and later updates against the source files at [PRC.gov.ph](https://www.prc.gov.ph/).

These content practices do not guarantee a particular copyright outcome or approval by an advertising service. The site should continue to provide useful original explanations and tools, with clear attribution for source data and documents.
