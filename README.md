# hireme

Scrapes remote/global job listings from a handful of EA-adjacent job
boards into one deduplicated CSV, and serves it through a minimal Bun
web app for browsing, filtering, and triaging (like / not relevant).

Boards currently covered:

- [80,000 Hours](https://jobs.80000hours.org)
- [Probably Good](https://jobs.probablygood.org)
- [EA Opportunities Board](https://www.effectivealtruism.org/opportunities)
- [Animal Advocacy Careers](https://animaladvocacycareers.org/job-board/)

## Layout

```
scrapers/          one module per job board, each exposing fetch_jobs()
  common.py        shared helpers (FIELDNAMES schema, HTML stripping, Algolia paging)
  dedupe.py         cross-board duplicate merging + stable per-job id
scrape_jobs.py     orchestrates all scrapers, dedupes, writes jobs.csv
jobs.csv           output of the last scrape run (committed as a snapshot)
web/
  server.ts        Bun server: serves web/public/ and GET /api/jobs (reads jobs.csv)
  public/          plain HTML/CSS/JS frontend, no build step (but see the editor below)
```

## Running the scraper

Requires Python 3 with `requests` installed.

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
- **Table layout**: the Cards/Table dropdown (or a `?layout=table` link)
  shows the same filtered list as a spreadsheet grid -
  [Jspreadsheet CE](https://github.com/jspreadsheet/ce) (MIT), which
  `server.ts` serves as `/sheet.js` + `/sheet.css` and the page loads the
  first time the table is shown. Excel-style selection, copy/paste and
  keyboard editing, per-column sorting and filters, the first columns
  frozen. Only our own columns are editable: liked and not relevant, and
  (logged in) the application's status and notes, which save exactly as
  the cards do; notes on an untracked job start tracking it, and clearing
  a status untracks it unless it has notes or a letter. The scraped
  columns are read-only, since the next scrape would overwrite them, and
  formulas are never evaluated. "Download CSV" saves the rows in the
  grid's current order. If the library can't load, a plain read-only
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

## Adding another job board

1. Add `scrapers/<board_name>.py` with a `fetch_jobs()` function that
   returns a list of dicts matching `scrapers.common.FIELDNAMES` (everything
   except `id`, which `dedupe.py` fills in after merging):
   `source, title, link, publication_date, close_date, organization_name,
   organization_url, organization_description, description, salary_range, tags`.
   Look at `scrapers/eighty_thousand_hours.py` (Algolia-backed),
   `scrapers/ea_opportunities.py` (data embedded in SSR HTML), or
   `scrapers/animal_advocacy_careers.py` (WordPress REST API) as
   templates depending on how the target site is built.
2. Register it in `SCRAPERS` in `scrape_jobs.py`.
3. Run `python3 scrape_jobs.py` and check the new source shows up with
   a sane job count.

## Deduplication

Two listings are treated as the same job if either:

1. their application links match after stripping query strings/UTM
   params, scheme, and trailing slashes, or
2. they have the same normalized organization name and job title.

Duplicates are merged into one row: empty fields are filled in from
whichever source has them, tags are unioned, and `source` becomes a
`;`-joined list of every board the job was found on.
