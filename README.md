# hireme

Scrapes remote/global job listings from a handful of EA-adjacent job
boards, plus the remote-only offers of the Slovak board Profesia, into one
deduplicated CSV, and serves it through a minimal Bun
web app for browsing, filtering, and triaging (like / not relevant).

Boards currently covered:

- [80,000 Hours](https://jobs.80000hours.org)
- [Probably Good](https://jobs.probablygood.org)
- [EA Opportunities Board](https://www.effectivealtruism.org/opportunities)
- [Animal Advocacy Careers](https://animaladvocacycareers.org/job-board/)
- [Profesia](https://www.profesia.sk): only offers it marks as work from
  home only ("Práca iba z domu", a few hundred of its ~14,000). It has no
  API, so `scrapers/profesia.py` reads its list pages and each offer's page.

## Layout

```
scrapers/          one module per job board, each exposing fetch_jobs()
  common.py        shared helpers (FIELDNAMES schema, HTML stripping, Algolia paging)
  dedupe.py         cross-board duplicate merging + stable per-job id
  postings.py      fetches each job's full original posting into data/postings/
  europe.py        Claude reads each posting: can someone living in Europe take it?
scrape_jobs.py     orchestrates all scrapers, dedupes, writes jobs.csv
jobs.csv           output of the last scrape run (committed as a snapshot)
web/
  server.ts        Bun server: serves web/public/, GET /api/jobs and the public /api/v1 (reads jobs.csv)
  lib/api-v1.ts    the public API: typed jobs, filters, paging, facets
  public/          plain HTML/CSS/JS frontend, no build step (but see the editor below)
```

## Running the scraper

Requires Python 3.11+ and `pip install -r requirements.txt` (`requests`, and `anthropic` for fit scores).

```bash
python3 scrape_jobs.py                  # writes jobs.csv
python3 scrape_jobs.py -o other.csv     # custom output path
```

This hits each board fresh, merges duplicate postings (same job
cross-posted to multiple boards), and prints a summary like:

```
Fetching from 80,000 Hours...
  got 167 jobs
...
Total before dedup: 677
Total after dedup: 509
Wrote 509 jobs to jobs.csv
```

`jobs.csv` is checked into git as a point-in-time snapshot so the web
app works out of the box after a fresh clone. On this server
`scrape_and_sync.sh` now commits and pushes the refreshed `jobs.csv`
automatically after each daily scrape - no manual step needed.

### Failure alerts

`scrape_and_sync.sh` reports each run to [Healthchecks.io](https://healthchecks.io)
when `HEALTHCHECK_URL` is set: a `/start` ping when it begins, then the exit
status with the last 100 kB of the run's log. You get an email (or push, Slack,
...) when a board raised or returned 0 jobs, `overrides.toml` is broken, the
git pull/push failed, or the run hung or never happened. Setup:

1. Create a free check at healthchecks.io with schedule type Cron, `0 6 * * *`,
   the server's timezone, and a grace time of 1 hour (the timer adds up to 10
   minutes of random delay, plus the scrape itself).
2. Put its ping URL in the repo's `.env` on the server (gitignored):
   `HEALTHCHECK_URL=https://hc-ping.com/<uuid>`. An environment variable
   of the same name, e.g. `Environment=` in `hireme-scrape.service`, wins.
3. Run `./scrape_and_sync.sh` once by hand and check the ping shows up.

Without `HEALTHCHECK_URL` the script behaves as before. A ping that can't get
through is logged and never fails the run.

## Running the web app

Requires [Bun](https://bun.sh).

```bash
cd web
bun run server.ts
```

Serves on `http://localhost:4020` by default. Override with:

- `PORT=xxxx` - change the port
- `JOBS_CSV=/path/to/file.csv` - point at a different CSV (defaults to `../jobs.csv`)

The server re-reads `jobs.csv` and the static files from disk on every
request, so there's no build/restart step - edit and refresh. The one
exception is the notes and motivation-letter editor (`@research/editor`,
the shared package from `github.com/Matoo125/editor`, also used by bookmarks and lang): the server
bundles it once at startup and serves it at `/editor.js` and `/editor.css`,
so a change to the editor needs a restart. If the bundle fails, the fields
are plain textareas.

### Frontend features

- Search, sort (newest/oldest/closing soon/org), and filter by tag or
  source board.
- **Like / Not relevant**: each card has a like button and a "not
  relevant" button. A view dropdown lets you switch between All jobs /
  Liked / Not relevant. This state lives only in the browser's
  `localStorage` (no backend) - it won't sync across browsers/devices
  and is wiped if you clear site data. It survives re-scrapes because
  each job gets a stable `id` (hashed from its normalized link, or
  org+title as a fallback) computed in `scrapers/dedupe.py`.
- **New since your last visit**: jobs the scrape first found (`first_seen`)
  after the last day you visited before today get a "New" badge, and the
  view dropdown gets a "New since your last visit" view. Visit days are kept
  in `localStorage` and, when logged in, with your preferences on the server.
- **Table layout**: the Cards/Table dropdown (or a `?layout=table` link)
  shows the same filtered list as a spreadsheet grid -
  [Jspreadsheet CE](https://github.com/jspreadsheet/ce) (MIT), which
  `server.ts` serves as `/sheet.js` + `/sheet.css` and the page loads the
  first time the table is shown. Excel-style selection, copy/paste and
  keyboard editing, per-column sorting, the first columns frozen. Tags
  show as their typed columns (Type, Experience, Location, Cause area,
  Skills, Education, Other tags) and pay as the board's text plus Min,
  Max, Currency and Period (see below); sorting puts empty cells last
  either way and compares amounts as numbers. The
  filter row under the headers is ours, not Jspreadsheet's (which filters
  one column at a time, on whole cell values): each column offers its
  single values with counts (one board, one tag), a job passes a column
  when it has any picked value, and filters on several columns combine.
  They apply with the page's other filters, so the count and the CSV
  agree with the grid; "Clear column filters" resets them. Only our own columns are editable: liked and not relevant, and
  (logged in) the application's status and notes, which save exactly as
  the cards do; notes on an untracked job start tracking it, and clearing
  a status untracks it unless it has notes or a letter. The scraped
  columns are read-only, since the next scrape would overwrite them, and
  formulas are never evaluated. "Download CSV" saves what the grid
  shows, in its current order. If the library can't load, a plain read-only
  table (click a header to sort) shows instead. It replaced the public
  Airtable view (and its sync) as the way to see everything at once. The
  choice of layout is remembered in `localStorage`.
- **Add a job by link** (logged in only): paste a URL and the server
  fetches it to fill in a title (`og:title`/`<title>`, falling back to
  the hostname if fetching fails), then stores it per-user in
  `data/custom-jobs/<userId>.json` - separate from `jobs.csv`, so it
  isn't wiped by the next scrape. Merged into the job list client-side
  with `source: "custom"`, so it likes/tracks/filters like any other
  listing, plus a "Remove" action scraped jobs don't have.

## Public API

`/api/v1` is a read-only, public JSON API over the same jobs, for scripts,
bots and other sites. It's documented for consumers at
[hireme.sk/api](https://hireme.sk/api) (`web/public/api.html`), and the
contract is `web/public/openapi.json`, served at `/api/v1/openapi.json`.

```bash
curl 'localhost:4020/api/v1/jobs?location=Remote&sort=closing&limit=5'
```

- `GET /api/v1/jobs` (filters: `q`, `source`, the typed tag columns,
  `organization`, `currency`, `period`, `salary_min`, `posted_since`,
  `new_since`, `closes_after`; `sort`, `fields=full`, `limit`/`offset`),
  `GET /api/v1/jobs/:id`, `GET /api/v1/facets`, `GET /api/v1/meta`.
- Values are typed: lists are arrays (not `;`-joined), salary amounts are
  numbers, missing values are `null`. Descriptions only with `fields=full`
  or on a single job. Unknown parameters are a 400.
- No auth, CORS open to any origin, weak `ETag` (304 on `If-None-Match`) and
  `Cache-Control: public, max-age=300`, 60 requests a minute per IP
  (`API_RATE_LIMIT` to change; keyed on Caddy's `X-Forwarded-For`).
- `meta.scraped_at` is the mtime of `data/scraped.json`, which only a scrape
  writes.
- Within v1, fields are only added; a rename or removal means `/api/v2`.
  `/api/jobs` (untyped, every row) stays as the web app's own endpoint.

The server now parses `jobs.csv` once and re-reads it only when its mtime or
size changes, for both `/api/jobs` and `/api/v1`.

## Adding another job board

1. Add `scrapers/<board_name>.py` with a `fetch_jobs()` function that
   returns a list of dicts matching `scrapers.common.FIELDNAMES` (everything
   except `id`, which `dedupe.py` fills in after merging):
   `source, title, link, publication_date, close_date, organization_name,
   organization_url, organization_description, description, salary_range, tags`.
   The columns after `tags` are derived from `tags` and `salary_range`
   by `scrape_jobs.py`; a scraper doesn't fill them in.
   Look at `scrapers/eighty_thousand_hours.py` (Algolia-backed),
   `scrapers/ea_opportunities.py` (data embedded in SSR HTML),
   `scrapers/animal_advocacy_careers.py` (WordPress REST API), or
   `scrapers/profesia.py` (plain HTML pages, no API) as
   templates depending on how the target site is built.
2. Register it in `SCRAPERS` in `scrape_jobs.py`.
3. Run `python3 scrape_jobs.py` and check the new source shows up with
   a sane job count.

## Clean-up and deduplication

Before merging, `scrapers/normalize.py` evens out what the boards spell
differently:

- **Tags** that differ only in case or punctuation ("Full-time",
  "Full-Time", "Full Time") become one spelling, in sentence case.
- **Organization names** lose a trailing acronym in brackets ("Centre for
  Effective Altruism (CEA)"), and names that differ only in case or
  punctuation ("FAR AI", "FAR.AI") become one (`ORG_ALIASES` picks the
  spelling where the automatic choice is wrong).

The scrape log prints how many spellings it merged.

Two listings are then treated as the same job if either:

1. their application links match after stripping query strings/UTM
   params, scheme, and trailing slashes, or
2. they come from **different** boards and have the same normalized
   organization name and job title (each board often links its own copy:
   an ATS page, the org's careers page, a tracking redirect). Two listings
   with the same title on the same board stay separate, since the board
   lists them as distinct jobs (e.g. two locations at two salaries).

Matches chain (A~B and B~C make one job). Duplicates are merged into one
row: empty fields are filled in from whichever source has them, tags are
unioned, `source` becomes a `;`-joined list of every board the job was
found on, and the row keeps the first-seen listing's `id`, so likes and
tracked applications stay attached.

## Typed columns and salary numbers

After deduplication, each job gets columns derived from its tags and
salary text (the originals stay in `tags` and `salary_range`):

- `scrapers/tag_fields.py` sorts tags into `job_type`, `experience`,
  `education`, `location`, `cause_area` and `skills` (`;`-joined values),
  merging each board's wording of the same thing ("Mid (5-9 years
  experience)" and "Mid-senior level" are both "Mid (5–9y)"). Tags in no
  typed column go to `other_tags`. A tag that is in neither the table nor
  `UNTYPED` is named in the scrape log ("unknown tags: ..."), which is the
  cue to add it.
- `scrapers/salary.py` reads `salary_range` into `salary_min`,
  `salary_max`, `salary_currency` and `salary_period` (hour, day, week,
  month, year, total, unpaid). The first currency mentioned wins; a
  period that isn't stated is taken as a year for amounts of 10,000 or
  more in USD/GBP/EUR/CAD/AUD/CHF, else left empty. Profesia's Slovak
  labels are rewritten to English by its scraper first ("Od 2 250
  EUR/mesiac" is "From 2,250 EUR per month"). "Competitive" and
  the like leave all four empty. The scrape log prints how many salaries
  were read and how many weren't.

## History and first-seen dates

Each scrape saves a snapshot of the jobs it found (id, title, organization,
dates, boards) as `data/history/<date>.json`, and the date each job id was
first seen in `data/history/first-seen.json` (`scrapers/history.py`). An id
is never forgotten, so a job that drops out for a day (its board failed) keeps
its date when it comes back. The date goes into `jobs.csv` as `first_seen`
(also kept in `data/scraped.json`, so rebuilds after corrections keep it) and
into the API as `first_seen`, with `new_since=<date>` to ask for only the jobs
that are new since then.

The first scrape without `first-seen.json` builds it from the git history of
`jobs.csv` (each commit's ids, back to 2026-07-31 when jobs got ids), so jobs
already listed get the date they first appeared, not the day this shipped;
jobs listed before 2026-07-31 show that date. To rebuild it by hand:
`python3 -m scrapers.history backfill`. Like the rest of `data/`, history
lives only on the server, at roughly 100 kB a day.

## Full postings and the Europe check

The boards give a summary of each job; the posting behind its link has the
rest. Each scrape fetches the posting of every new job into
`data/postings/<id>.json` (`scrapers/postings.py`): the page's text, or the
schema.org JobPosting description it embeds when that's longer (how Ashby
pages are read), and public Google Docs as plain text. Only public addresses
are fetched. Postings that can't be read (Google Forms, Airtable, logins) are
tried again after a week; about 72% are read.

Then Claude (`claude-haiku-5-5`, `scrapers/europe.py`) reads each new or
changed posting, or the board's summary when it couldn't be read, and decides
whether someone living in Europe with EU citizenship can take the job:
`yes`, `no` or `unclear`, with a short reason ("Posting states: only
considering applicants based in North America"). These go into `jobs.csv` as
`europe` and `europe_reason`, into the API as `europe` (filter with
`europe=yes`), and into the site: jobs marked `no` are left out unless you
click "Show N not open to Europe", the table has a Europe column, and admins
can correct a verdict there (it goes to `overrides.toml`). Readings are kept
in `data/europe.json`, so a job is read once; the first run over ~530 jobs
costs about $0.20, a normal day well under a cent. Without
`ANTHROPIC_API_KEY` the scrape keeps earlier readings and reads nothing new.

By hand: `python3 -m scrapers.postings` fetches what's missing for
`jobs.csv`, `python3 -m scrapers.europe` reads it (the next scrape puts the
readings into `jobs.csv`).

## Fit scores

`fit_scores.py` scores how well each job fits a user's CV with Claude
(`claude-haiku-5-5`, low effort): 0-100 plus one sentence, kept in
`data/fit/<userId>.json`. Signed-in users with scores get the score and reason
on each card, a Fit column in the table, and a "Best fit for you" sort
(`GET /api/fit`), which is their default. Sorted by fit, jobs scoring under 40
fold into "Probably not for you" at the end, unless you've liked or tracked
them. Everyone else sees no change.

- What it reads: the job's full posting when it could be fetched (above),
  else the board's summary.
- Who gets scored: the user ids in `FIT_USER_IDS` (comma-separated) who have
  uploaded a CV. Your id is the `sub` of your altfresh login.
- `scrape_and_sync.sh` runs it after each scrape when `FIT_USER_IDS` is set,
  with `ANTHROPIC_API_KEY`; both can go in the repo's `.env` on the server:

  ```
  FIT_USER_IDS=7
  ANTHROPIC_API_KEY=sk-ant-...
  ```

- Only jobs without a score are scored (the new ones each day); uploading a new
  CV rescores everything, and scores of jobs no longer listed are dropped. The
  CV goes first in each request, cached, so it's paid in full once per run.
  Scoring all ~535 jobs costs a few cents; a normal day well under one.
- A job the model declines or that fails is left unscored and tried again on
  the next run; the run exits non-zero, so it shows in the healthcheck.
- `python3 fit_scores.py --dry-run` says what would be scored without calling
  anything; `--evaluate` compares the scores with your liked and hidden jobs
  (the roadmap's bar: at least half of what you'd hide scored below 40).

## Hand corrections

When a board gets a job wrong (a stale close date, a salary in the wrong
field), the right value goes in `overrides.toml`, by job id, instead of
`jobs.csv`, which the next scrape rewrites. Admins (account ids in the
server's `ADMIN_USER_IDS`) just edit the cell in the table layout; anyone
can also edit the file:

```toml
["693b22fe938f"]  # Human Resources Associate, Centre for Effective Altruism
close_date = 2026-11-30
salary_range = "$79,200 - $90,000 per year"
```

- Find the id: `python3 -m scrapers.overrides find human resources`.
- Any column but `id` can be set. Corrections are applied after
  deduplication and before the typed columns and salary numbers are
  derived, so fixing `tags` or `salary_range` fixes those too; setting a
  derived column (`salary_period`, `location`, ...) directly wins.
- `jobs.csv` gains a `corrected` column naming the columns set, and the
  grid marks those cells with a corner triangle.
- Edited by hand: `python3 -m scrapers.overrides rebuild` applies the file
  to `jobs.csv` without scraping again (it rebuilds from
  `data/scraped.json`); then commit both.
- Edited in the grid: `PUT /api/overrides/<id>` runs `python3 -m
  scrapers.overrides set`, which edits the file in place (keeping its
  comments), rebuilds `jobs.csv` from `data/scraped.json` (the last
  scrape's jobs before corrections) without scraping again, and, with
  `OVERRIDES_COMMIT=1`, commits and pushes both files so the checkout
  stays clean for deploys. Paste works too, a cell at a time. Typing the
  board's own value back, or right-click "Undo hand correction", removes
  a correction. Jobs added by link can't be corrected (they're not
  scraped). Edits and scrapes take turns on `data/.jobs.lock`.
- The scrape log names entries whose job wasn't scraped this time (closed,
  or its link and so its id changed) and values the boards now give by
  themselves, so either can be deleted. A broken file is reported as a
  problem (the unit fails) and the scrape carries on without it.

## Tests

- `python3 -m unittest` (in `tests/`): the scrapers' clean-up,
  deduplication, typed columns, salary parsing and overrides.
- `cd web && bun test`: the public API (`lib/api-v1.ts`, and the server's
  CORS, ETag and rate limiting), on the browser tests' fixture below. Needs
  `python3` with `requests`, like the browser tests.
- `cd web && bun run test:browser` (or `bun tests/browser/run.ts grid
  corrections` for some): the web app in headless Chromium, set
  `CHROMIUM` if it isn't on the PATH as `chromium`. The runner starts the
  server on `tests/browser/fixture/scraped.json` (98 jobs sampled from a
  real scrape, covering every board and kind of salary), a stand-in for
  altfresh's sign-in with an admin and a plain user, and the browser;
  each `tests/browser/*.js` is one test run in the page, with the helpers
  listed at the top of `run.ts`. Nothing outside a temp dir is touched.

GitHub Actions (`.github/workflows/ci.yml`) runs all three on every push
to `main` and every pull request, except pushes that only change `jobs.csv`
or Markdown (the daily scrape commit). It installs the web dependencies
without `@research/editor`, a private repo, so the browser tests run
against the plain-textarea fallback.
