# Hireme — Spec

Status: retrofitted from current implementation, 2026-08-15. Describes what the system *does*
today. If code and spec disagree after a change, update the spec in the same PR.

## 1. Purpose

Scrapes remote/global job listings from EA-adjacent job boards into one deduplicated CSV, served
through a minimal read-only web app for browsing, filtering, and personal triage (like / not
relevant).

**Divergence from original intent**: the original intent notes (never part of this repo, not implemented)
describes a richer version of this — job descriptions read and triaged automatically ("decide
whether it should be added to our database"), PostgreSQL storage, and Profesia as a covered board.
Automatic reading of postings (§4) has since been added, and a Profesia scraper written but not
run (§4); the rest doesn't exist yet. The implemented system is simpler: static scrape → CSV → manual
like/hide in the browser. Treat those notes as backlog/intent, not spec — this file
documents what's actually running.

## 2. Components

| Component | Path | Runtime |
|---|---|---|
| Scrapers | `scrapers/*.py` | Python 3 + `requests`, one module per board |
| Orchestrator | `scrape_jobs.py` | Runs all scrapers, dedupes, writes `jobs.csv` |
| Web app | `web/server.ts` + `web/public/` | Bun server, static files + one JSON endpoint |
| Deploy | `hireme.service`, `hireme-scrape.{service,timer}` (systemd units on the VPS) | systemd, reverse-proxied by Caddy |

Production URL: `hireme.sk` → `reverse_proxy localhost:4020` (`www.hireme.sk` redirects to it).

## 3. Data model

No database. `jobs.csv` is the entire persistence layer — a flat file, checked into git as
a point-in-time snapshot, overwritten by each scrape run. Columns (`scrapers/common.py:FIELDNAMES`):

```
id, source, title, link, publication_date, close_date, first_seen,
organization_name, organization_url, organization_description,
description, salary_range, tags, salary_min, salary_max, salary_currency,
salary_period, job_type, experience, education, location, cause_area,
skills, other_tags, europe, europe_reason, corrected
```

- `id`: 12-char MD5 prefix of a stable identity key (normalized link, or normalized
  org+title if no link) — computed in `dedupe.py:stable_id`. Stable across re-scrapes as long as
  the job's link (or org+title) doesn't change; this is what lets the frontend's per-job
  like/hide state survive a re-scrape.
- `first_seen`: the date hireme's scrape first found the id (`scrapers/history.py`), from
  `data/history/first-seen.json`, which never drops an id; daily snapshots of each scrape are in
  `data/history/<date>.json`. Bootstrapped from the git history of `jobs.csv`, so the earliest
  value is 2026-07-31 (when ids were introduced). Exposed in `/api/v1` with a `new_since` filter.
- `source`, `tags`: `;`-joined lists, since a job can be cross-posted and tagged from multiple
  boards.
- `europe`, `europe_reason`: whether someone living in Europe (EU citizenship, no other work
  authorization) can be hired for and do the job — `yes` / `no` / `unclear` plus a reason of
  about 15 words quoting the deciding requirement — read by `claude-haiku-5-5` (low effort,
  structured output) from the full posting (`scrapers/europe.py`, §4), or from `description`
  when the posting couldn't be read. Empty until read. Correctable in `overrides.toml` like any
  column. Exposed in `/api/v1` as `europe: {verdict, reason}` with a `europe` filter. The
  frontend leaves `no` jobs out of All jobs / New unless "Show N not open to Europe" is on
  (remembered per browser); liked, hidden and tracked views always show them.
- About 525 rows / 4 boards (80,000 Hours, Probably Good, EA Opportunities Board, Animal
  Advocacy Careers).

Per-user like/not-relevant state lives only in browser `localStorage` on the client — never sent
to the server, doesn't sync across devices, wiped on clearing site data.

Logged-in users (auth via `api.altfresh.sk`, a bearer JWT verified against its JWKS — see §5) get
server-persisted per-user data under `data/`, one JSON file per user id, created on first
write: `cv/<id>.json`+`.pdf` (uploaded CV), `preferences/<id>.json` (liked/hidden and visit days, synced up from
`localStorage`), `applications/<id>.json` (tracked jobs: status, notes, motivation letter), and
`custom-jobs/<id>.json` (jobs added by link — see below), `fit/<id>.json` (fit scores, below), `pages/<id>.json` (portfolio page settings), `feeds/<id>.json` (job feed token, below), `digests/<id>.json` (email digest, below), `page-content/<id>.json` (the page's text, made from the CV, below) and `cv-advice/<id>.json` (suggestions for the CV, below). None of this is checked into git or
touched by the scrape; it's entirely separate from `jobs.csv`.

**CV suggestions** (on request): `cv_advice.py` (run by the server for one user at a time) gives `claude-opus-5-5` the CV and up to 15 jobs — liked, then tracked, then fit scores ≥ 60, never hidden ones, each read in full when its posting was fetched — and writes `cv-advice/<id>.json`: `{cv, model, version, jobs, jobTitles, generatedAt, advice: {summary, keep[], suggestions[{title, where, change, why, job_ids}]}}`. The prompt forbids suggesting claims the CV doesn't support. It skips the call when the CV hash, the job list, model and version are unchanged. Advice from an older CV is served as `stale` until asked again; deleting the CV deletes it.

**Portfolio pages** (opt-in): a logged-in user can publish a page at `<slug>.hireme.sk`, built from their CV. `pages_cv.py` (run by the server for one user at a time, the way `scrapers.overrides` is) reads the CV with `claude-haiku-5-5` into `page-content/<id>.json`: name, headline, summary, skills, experience, education, projects, and the links the CV itself gives. Its schema has no contact fields and its prompt forbids them. Content is remade only when the CV's hash changes. A CV upload while the page is on regenerates it; deleting the CV deletes the content. Turning the page off keeps the address and content, so turning it back on needs no new run. Addresses are 3–40 letters, digits and hyphens, not reserved (`web/lib/pages.ts`), and held by one user at a time, including while their page is off. The page is HTML with inline styles only: values are escaped, and only http(s) links are kept.

**Job feed** (opt-in): a logged-in user can turn on a private RSS 2.0 feed at `/feed/<token>.xml` (`web/lib/feed.ts`). The token (32 hex characters, random) is the only secret: the feed needs no login. It lists jobs whose `first_seen` is within the last 30 days, whose fit score (`fit/<id>.json`) is at least `minFit` (60, stored per feed for a later setting) and whose `europe` isn't `no`: newest first, then best fit, at most 50. Each item's title is `[score] title — organization`, its link the posting (http(s) only, else the site), its guid `hireme-<id>`, and its description the fit reason, Europe status, salary and close date. Turning the feed off deletes the file and a new link replaces the token, so the old link returns 404. Users without fit scores can turn it on but get no items. 

**Email digest** (opt-in, `web/lib/digest.ts`): a logged-in user enters an address, since the login token carries none. The server emails a confirmation link through Resend, at most one a minute and five a day per user. Nothing else goes to an address until it is confirmed. After each scrape, `web/digest.ts` (run by `scrape_and_sync.sh` after fit scoring, when `RESEND_API_KEY` is set) emails each confirmed user the feed's selection, limited to jobs first seen on or after the day they confirmed and never emailed before. The ids sent are kept, the last 2,000. A user with nothing new gets no email. A failed send keeps those jobs for the next run and makes the run exit non-zero. Every digest carries an unsubscribe link and `List-Unsubscribe` / `List-Unsubscribe-Post` headers (RFC 8058). The confirm and unsubscribe links (`/digest/{confirm,unsubscribe}/<token>`) show a page with a button on GET and act on POST, so link-following mail scanners change nothing. A one-click POST unsubscribes directly. Changing the address starts a new unconfirmed digest with new tokens, keeping the ids already sent. Logs name users by id, never by address.

**Custom (user-added) jobs**: a logged-in user can paste a job link and the server fetches it
(via `web/lib/fetch-page.ts`, SSRF-guarded) to fill in a title from `og:title`/`<title>`,
falling back to the link's hostname if the fetch fails or the title can't be found. Stored as a
`CustomJob` (same shape as a CSV row) with `id: "custom-" + Bun.hash(normalizedLink)`,
`source: "custom"`, keyed by the same link-normalization rule as §4's dedup so re-adding a link
(with a different tracking suffix) returns the existing entry instead of duplicating it. The
frontend merges these into the in-memory `jobs` array client-side — they sort/filter/like/track
like any scraped job, plus a "Remove" action (`DELETE /api/custom-jobs/:id`) scraped jobs don't
have.

**Fit scores**: `fit_scores.py` scores each job in `jobs.csv` against the CV of every user in
`FIT_USER_IDS` (0-100 + one-sentence reason, `claude-haiku-5-5` at low effort, structured output,
the CV PDF sent first with a cache breakpoint) into `data/fit/<id>.json`, keyed by CV hash and
model so a new CV rescores everything. Run by `scrape_and_sync.sh` after each scrape (jobs lock
released first); failures leave jobs unscored for the next run and make the run exit non-zero.
The frontend shows score + reason on cards, a Fit column in the table, and a "Best fit for you"
sort for scored users only. That sort is their default until they pick another; in it, cards
scoring under 40 (that aren't liked or tracked) fold into a collapsed "Probably not for you"
group at the end.

**New since your last visit**: the frontend keeps `{last, previous}` visit days (UTC) in
`localStorage` and, logged in, in `preferences/<id>.json` as `visits` (merged across devices:
the latest earlier-day visit wins). A job with `first_seen` after `previous` gets a "New" badge
and appears in the "New since your last visit" view, offered from the second day of visits.

## 4. Scraping

`scrape_jobs.py` runs each board's `fetch_jobs()` (imported from `scrapers/`), concatenates
results, then `dedupe.merge_duplicates()`:

- Profesia (`scrapers/profesia.py`, **not in `SCRAPERS`**: its AWS firewall started challenging
  the server, HTTP 202 with an empty body, partway through the first daily run) has no API: it reads the list pages of offers marked work
  from home only (`/praca/?remote_work=1`, until a page has no new offers, at most 50) and each
  offer's page (4 at a time) for the date posted, the og:description summary, the contract type
  (mapped to job types Full-time / Part-time / Contractor / Temporary / Internship) and the
  employer's description. An offer page that fails to load keeps its list entry. Salary labels
  are rewritten to English for `scrapers/salary.py`; `location` is always Remote.
- Two listings are the same job if their links match after stripping query strings/UTM
  params/scheme/trailing slash, **or** their normalized org name + title match (catches
  boards that wrap links in their own tracking redirect).
- On merge: empty fields filled in first-seen-wins from duplicates, tags unioned, `source`
  becomes every board the job was found on.
- A scraper module raising, or returning zero jobs, is caught and logged per-board — one board
  failing doesn't abort the run, but is treated as a problem: `scrape_jobs.py` still writes
  `jobs.csv` from whichever boards succeeded, then exits non-zero if any board raised or came
  back empty (job boards essentially never legitimately hit zero, so an empty result is treated
  as a signal something broke, e.g. a site redesign). Since this runs unattended via
  `hireme-scrape.timer`, a non-zero exit is what makes a degraded run visible —
  `systemctl status hireme-scrape.service` / `systemctl --failed` will show it as failed instead
  of a silently "successful" run that quietly lost a board. With `HEALTHCHECK_URL` set,
  `scrape_and_sync.sh` also pings Healthchecks.io (start, then exit status + log), which alerts on
  a failed, hung or missing run (§6).

**Postings and the Europe check**: after history, `scrapers/postings.py` fetches each job's
original posting not fetched yet into `data/postings/<id>.json` (`{link, fetched_at, status,
text}`): the page's readable text, or its schema.org JobPosting description when longer;
public Google Docs via their plain-text export. Public addresses only (checked on every
redirect, since the links come from third-party boards and this runs on the web server); 3 MB
and 20 s per page; postings shorter than 500 characters count as unread and are fetched again
after 7 days. About 72% of postings are read (Google Forms, Airtable and logins aren't). Then
`scrapers/europe.py` reads every job whose text changed since its last reading into
`data/europe.json` (keyed by id, text hash and model; unlisted ids dropped; a prompt change
applies to new readings only) and sets `europe`,
`europe_reason`. Without `ANTHROPIC_API_KEY` nothing new is read. Fetch or read failures are
problems (non-zero exit) but `jobs.csv` is still written. `fit_scores.py` reads the same full
postings.

Adding a board = new `scrapers/<name>.py` with `fetch_jobs()` returning `FIELDNAMES`-shaped
dicts, registered in `SCRAPERS` in `scrape_jobs.py`. Three existing implementation patterns to
copy from: Algolia-backed (`eighty_thousand_hours.py`), SSR-embedded JSON
(`ea_opportunities.py`), WordPress REST API (`animal_advocacy_careers.py`).

## 5. Web app contract

| Method | Path | Response |
|---|---|---|
| GET | `/api/jobs` | 200, full `jobs.csv` as JSON array of objects (all columns as strings); 500 `{error}` if the CSV can't be read |
| GET/POST/DELETE | `/api/cv`, `/api/cv/file` | CV upload/download/delete (PDF, 10 MB max). Auth required. |
| GET/POST | `/api/cv/advice` | GET → `{status, error, generatedAt, jobTitles, advice}`; `status` is `no-cv`, `none`, `generating`, `ready` or `stale` (made from an earlier CV); `error` explains the last failed run (or that there were no jobs to compare with). POST starts a run (400 without a CV) and returns the same. Auth required. |
| GET/PUT | `/api/preferences` | Liked/hidden id sets, plus `visits: {last, previous}` (dates; dropped if malformed). Auth required. |
| GET, PUT/DELETE `/:jobId` | `/api/applications` | Tracked-application status/notes/letter per job. Auth required. |
| GET | `/api/fit` | 200 `{model, scores: {jobId: {score, reason, scored_at}}}` for this user, 404 if they aren't scored. Auth required. |
| GET/PUT | `/api/page` | GET → `{enabled, slug, url, status, generatedAt}`; `status` is `off`, `no-cv`, `generating`, `ready` or `pending` (content not yet made from the current CV). PUT `{enabled, slug?}` turns the page on or off and sets its address: 400 on a bad address or body, 409 if another user holds it. Auth required. |
| GET/PUT | `/api/feed` | GET → `{enabled, url, minFit, scored}`. PUT `{enabled, rotate?}` turns the feed on (keeping its link, or a new one with `rotate: true`) or off (deleting the link); 400 on a bad body. Auth required. |
| GET/PUT/DELETE | `/api/digest` | GET → `{email, status, minFit, scored, available}`, `status` `off`, `pending` (not confirmed) or `on`; `available` false without `RESEND_API_KEY`. PUT `{email}` sends a confirmation email for a new or still unconfirmed address (an already confirmed one: no email). 400 bad address, 429 over the confirmation limit, 502 if Resend fails, 503 without a key. DELETE stops the digest. Auth required. |
| GET/POST | `/digest/confirm/<token>`, `/digest/unsubscribe/<token>` | Public, the token is the secret. GET: a page with a button; POST: confirm or unsubscribe. An unknown confirm token → 404 page; an unknown unsubscribe token → 200 ("not subscribed"). |
| GET | `/feed/<token>.xml` | Public, no login: the token is the secret. RSS of that user's new, well-fitting jobs (§3); 404 for an unknown token. `Cache-Control: private, max-age=300`. |
| any | `<slug>.hireme.sk/` | Not the API: Host routing. The published page for that slug; 404 if it's off, has no content yet, or the path isn't `/`. Other paths on that host are never the job board. |
| GET | `/api/custom-jobs` | 200, this user's custom jobs as a JSON array. Auth required. |
| POST | `/api/custom-jobs` | Body `{link, title?, organization_name?}` → fetches the link for a title if omitted, 201 with the created `CustomJob` (or 200 with the existing one if the normalized link was already added); 400 on an invalid/non-http(s) URL. Auth required. |
| DELETE | `/api/custom-jobs/:id` | Removes one custom job. Auth required. |
| GET | `/api/v1/jobs` | Public. Filtered (`q`, `source`, typed tag columns, `organization`, `currency`, `period`, `salary_min`, `posted_since`, `new_since`, `closes_after`), sorted (`newest`/`oldest`/`closing`/`organization`), paged (`limit` ≤ 200, `offset`) jobs as typed JSON `{data, page, meta}`; descriptions only with `fields=full`; 400 `{error:{code,message}}` on an unknown or invalid param |
| GET | `/api/v1/jobs/:id` | Public. One job with descriptions; 404 if unknown |
| GET | `/api/v1/facets`, `/api/v1/meta` | Public. Values of each filterable field with counts; last scrape time (`data/scraped.json` mtime), totals, attribution |
| GET | `/api/v1/openapi.json`, `/api` | Public. The v1 contract (`web/public/openapi.json`) and its docs page |
| GET | `/*` | Static file from `web/public/`, `/` → `index.html`, 404 otherwise |

`/api/jobs`, `/api/v1/*` and static files are unauthenticated and read-only. `/api/v1/*` is the
public contract (only additive changes within v1): CORS `*`, weak ETag + `Cache-Control: public,
max-age=300`, 60 requests/minute per IP (`API_RATE_LIMIT`), 405 on anything but GET/OPTIONS. Every other endpoint requires a
bearer JWT (`Authorization: Bearer <jwt>`), minted by `api.altfresh.sk` and verified against its
JWKS (`verifyToken` in `server.ts`) — this spec's older "no auth, single tenant" framing predates
that and is stale; §8 is corrected to match. `jobs.csv` is parsed once and re-parsed when its mtime or size
changes, so a fresh scrape or hand correction is visible without restarting the server.

Frontend (`public/app.js`): client-side search, sort (newest/oldest/closing soon/org), filter by
tag or source board, and the like/not-relevant triage state described in §3.

## 6. Deployment

- `hireme.service` — `bun run server.ts`, `PORT=4020`, user `ubuntu`, restart on failure.
- `hireme-scrape.timer` — daily at 06:00 (±10min random delay), runs `hireme-scrape.service`
  (`python3 scrape_jobs.py -o jobs.csv`) as a oneshot.
- **`jobs.csv` is auto-committed and pushed after each scrape** (`scrape_and_sync.sh`
  runs the git commit/rebase/push itself), so the deployed `jobs.csv` stays in sync with
  git — the repo deliberately no longer waits on a manual commit. The "sync jobs"
  commit is rebased on top of `origin/main` (via `git pull --rebase --autostash`) before
  pushing; if that hits a conflict the script aborts the rebase and exits non-zero so it
  shows up in `systemctl --failed`.
- **Failure alerts**: with `HEALTHCHECK_URL` in the environment or the repo's `.env`,
  `scrape_and_sync.sh` pings Healthchecks.io at `/start` and at `/<exit status>` with the last
  100 kB of the log; the check (cron `0 6 * * *`, 1 h grace) emails on a failed, hung or missing
  run. Ping failures are logged and never fail the run. Unset = no pings.
- **Portfolio pages** need a wildcard DNS record `*.hireme.sk` pointing at the server and a wildcard
  certificate. Caddy only issues wildcard certificates through a DNS challenge, so the site block
  is `*.hireme.sk { tls { dns <provider> } reverse_proxy localhost:4020 }`, with that provider's
  Caddy plugin. Without it a page subdomain gets a certificate error. `pages_cv.py` needs
  `ANTHROPIC_API_KEY` in the server's environment, as `fit_scores.py` does for the timer.
  `PAGES_DOMAIN` (default `hireme.sk`) and `DATA_DIR` (default `data/`) override the defaults.
- CI: GitHub Actions (`.github/workflows/ci.yml`) runs the Python unit tests, the API tests and
  the browser tests on pushes to `main` and on PRs, skipping pushes that only touch `jobs.csv` or
  Markdown. Python dependencies are in `requirements.txt` (only `requests`).

## 7. Known gaps

- Server-side `jobs.csv` vs. git `jobs.csv` can drift silently (§6) — mitigated 2026-09-08 by
  auto-committing/pushing after each scrape; any residual drift is confined to scrape/push
  failures that surface in `systemctl --failed`.
- Relevance triage is only partly automated: fit scores (§3) rank jobs against a CV for the users
  in `FIT_USER_IDS`; hiding is still manual, and whether the scores catch what a user would hide
  is measured with `fit_scores.py --evaluate`, not yet acted on.

## 8. Non-goals (current scope)

- Hiding jobs automatically by fit: fit scores rank and explain, the user still decides. (Jobs
  not open to Europe are left out by default, but one click shows them.)
- Any board beyond the four in §3. Profesia stays off until it allows the server; even then only
  its remote-only offers, not its ~13,500 on-site or partly remote ones (mostly retail,
  manufacturing and logistics).
- Real-time/on-demand scraping (only the daily timer).
- Automated metadata beyond a best-effort title fetch for custom jobs — no description/org/salary
  scraping or Europe check for user-added links, unlike the board scrapers in §4.
- Salary figures from the full postings: a 60-posting trial (2026-10-26) found the boards
  already carry nearly every salary the postings state.
