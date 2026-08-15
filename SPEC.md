# Hireme — Spec

Status: retrofitted from current implementation, 2026-08-15. Describes what the system *does*
today. If code and spec disagree after a change, update the spec in the same PR.

## 1. Purpose

Scrapes remote/global job listings from EA-adjacent job boards into one deduplicated CSV, served
through a minimal read-only web app for browsing, filtering, and personal triage (like / not
relevant).

**Divergence from original intent**: `instructions.txt` (repo-root notes, not implemented)
describes a richer version of this — job descriptions read and triaged automatically ("decide
whether it should be added to our database"), PostgreSQL storage, and Profesia as a covered board.
None of that exists yet. The implemented system is simpler: static scrape → CSV → manual
like/hide in the browser. Treat `instructions.txt` as backlog/intent, not spec — this file
documents what's actually running.

## 2. Components

| Component | Path | Runtime |
|---|---|---|
| Scrapers | `hireme/scrapers/*.py` | Python 3 + `requests`, one module per board |
| Orchestrator | `hireme/scrape_jobs.py` | Runs all scrapers, dedupes, writes `jobs.csv` |
| Web app | `hireme/web/server.ts` + `hireme/web/public/` | Bun server, static files + one JSON endpoint |
| Deploy | `server-config/systemd/hireme.service`, `hireme-scrape.{service,timer}` | systemd, reverse-proxied by Caddy |

Production URL: `hireme.sk` → `reverse_proxy localhost:4020` (`www.hireme.sk` redirects to it).

## 3. Data model

No database. `hireme/jobs.csv` is the entire persistence layer — a flat file, checked into git as
a point-in-time snapshot, overwritten by each scrape run. Columns (`scrapers/common.py:FIELDNAMES`):

```
id, source, title, link, publication_date, close_date,
organization_name, organization_url, organization_description,
description, salary_range, tags
```

- `id`: 12-char MD5 prefix of a stable identity key (normalized link, or normalized
  org+title if no link) — computed in `dedupe.py:stable_id`. Stable across re-scrapes as long as
  the job's link (or org+title) doesn't change; this is what lets the frontend's per-job
  like/hide state survive a re-scrape.
- `source`, `tags`: `;`-joined lists, since a job can be cross-posted and tagged from multiple
  boards.
- Currently 538 rows / 4 boards (80,000 Hours, Probably Good, EA Opportunities Board, Animal
  Advocacy Careers).

Per-user like/not-relevant state lives only in browser `localStorage` on the client — never sent
to the server, doesn't sync across devices, wiped on clearing site data.

## 4. Scraping

`scrape_jobs.py` runs each board's `fetch_jobs()` (imported from `scrapers/`), concatenates
results, then `dedupe.merge_duplicates()`:

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
  of a silently "successful" run that quietly lost a board.

Adding a board = new `scrapers/<name>.py` with `fetch_jobs()` returning `FIELDNAMES`-shaped
dicts, registered in `SCRAPERS` in `scrape_jobs.py`. Three existing implementation patterns to
copy from: Algolia-backed (`eighty_thousand_hours.py`), SSR-embedded JSON
(`ea_opportunities.py`), WordPress REST API (`animal_advocacy_careers.py`).

## 5. Web app contract

| Method | Path | Response |
|---|---|---|
| GET | `/api/jobs` | 200, full `jobs.csv` as JSON array of objects (all columns as strings); 500 `{error}` if the CSV can't be read |
| GET | `/*` | Static file from `web/public/`, `/` → `index.html`, 404 otherwise |

No auth — read-only, single tenant, no write endpoints. CSV is re-read from disk on every
`/api/jobs` request (no caching), so a fresh scrape is visible without restarting the server.

Frontend (`public/app.js`): client-side search, sort (newest/oldest/closing soon/org), filter by
tag or source board, and the like/not-relevant triage state described in §3.

## 6. Deployment

- `hireme.service` — `bun run server.ts`, `PORT=4020`, user `ubuntu`, restart on failure.
- `hireme-scrape.timer` — daily at 06:00 (±10min random delay), runs `hireme-scrape.service`
  (`python3 scrape_jobs.py -o jobs.csv`) as a oneshot.
- **Nothing commits the refreshed `jobs.csv`** — the daily timer overwrites the working tree file
  but the README explicitly says committing is manual ("Rerun the scraper and commit the result
  whenever you want fresher listings - nothing does this automatically"). On the server this
  likely means the deployed `jobs.csv` silently drifts from what's in git until someone commits it
  — worth confirming whether that's intended or a gap.
- No CI, no tests, no requirements.txt / lockfile for the Python side (relies on `requests` being
  present in the system/venv).

## 7. Known gaps

- No Python dependency pinning (`requirements.txt` absent) — `pip install requests` on a fresh
  box is undocumented.
- Server-side `jobs.csv` vs. git `jobs.csv` can drift silently (§6).
- No relevance filtering/scoring beyond the four hardcoded boards — the "is this job relevant to
  me" triage described in `instructions.txt` is entirely manual (browser like/hide), not automated.

## 8. Non-goals (current scope)

- Automated relevance triage / description reading (see §1 divergence note).
- Any board beyond the four listed in §1 — Profesia specifically is mentioned in
  `instructions.txt` but not implemented.
- Multi-user support, accounts, or server-persisted triage state.
- Real-time/on-demand scraping (only the daily timer).

## 9. Shared infra candidates (cross-project)

Cross-check against `bookmarks/SPEC.md` §11 and revisit once `lang` is spec'd.

| Candidate | What it'd replace | Confidence | Notes |
|---|---|---|---|
| systemd unit + Caddy reverse-proxy convention | `server-config/systemd/*`, `Caddyfile` | High | Same pattern as bookmarks: simple Bun service unit + a scheduled `.timer` for background work. Confirms `NEW_APP_CHECKLIST.md` should cover both service and timer/oneshot patterns, not just long-running services. |
| Standard API error shape `{error: string}` | Nothing yet | High | hireme's `/api/jobs` 500 response (`server.ts:75`) matches bookmarks' `{error}` convention independently — good sign this is a real de facto standard worth writing down once, not enforcing via shared code. |
| CSV/file-based read model with no-cache-on-read | `server.ts:loadJobs` | Low | Specific to hireme's scale (538 rows) and single-writer-daily-batch shape; bookmarks and (likely) lang are live CRUD over a real DB, so this pattern probably doesn't generalize. Noting only to rule it out. |
| Per-source fetch failure isolation (`try/except` per board, continue on error) | `scrape_jobs.py:50-54` | Medium | Generic "run N independent fetchers, don't let one failure kill the batch, but do report which ones failed" is a reusable shape if `lang`'s TTS/dictionary generation ends up doing multi-source fetching too. Currently under-built even here (§7) — worth fixing here first before extracting. |
| Bun static-file-server-plus-one-JSON-route pattern | `server.ts` | Low | Both bookmarks (Express `static` + JSON routes) and hireme (hand-rolled Bun `fetch`) solve "serve a SPA + an API from one process" but with different runtimes/frameworks — not enough overlap to unify without picking one runtime as standard first. |

No auth, DB, or CLI-client overlap with bookmarks — this app's shared-infra footprint is
entirely on the deploy/ops side, not application code.
