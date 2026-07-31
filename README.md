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
  public/          plain HTML/CSS/JS frontend, no build step
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
app works out of the box after a fresh clone. Rerun the scraper and
commit the result whenever you want fresher listings - nothing does
this automatically.

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
request, so there's no build/restart step - edit and refresh.

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
