#!/usr/bin/env python3
"""
Scrape remote/global job listings from multiple EA-adjacent job boards
into a single deduplicated CSV:

  - 80,000 Hours   https://jobs.80000hours.org
  - Probably Good  https://jobs.probablygood.org
  - EA Opportunities Board  https://www.effectivealtruism.org/opportunities
  - Animal Advocacy Careers  https://animaladvocacycareers.org/job-board/

Each board is scraped by its own module in scrapers/, normalized to a
common schema, cleaned up where boards spell the same tag or organization
differently (scrapers/normalize.py), then merged and deduplicated
(scrapers/dedupe.py) since the same role is often cross-posted to more
than one board. The result is kept in data/scraped.json, then hand
corrections from overrides.toml are applied (scrapers/overrides.py), the
tags sorted into typed columns (scrapers/tag_fields.py) and the salary
text read into numbers (scrapers/salary.py).
"""

import argparse
import sys
from collections import Counter

from scrapers import (
    animal_advocacy_careers,
    ea_opportunities,
    eighty_thousand_hours,
    probably_good,
)
from scrapers.dedupe import merge_duplicates
from scrapers.normalize import normalize_jobs
from scrapers.overrides import OverridesError, finish, load_overrides, save_scraped, write_csv
from scrapers.tag_fields import classify_tags

SCRAPERS = [
    ("80,000 Hours", eighty_thousand_hours.fetch_jobs),
    ("Probably Good", probably_good.fetch_jobs),
    ("EA Opportunities Board", ea_opportunities.fetch_jobs),
    ("Animal Advocacy Careers", animal_advocacy_careers.fetch_jobs),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-o",
        "--output",
        default="jobs.csv",
        help="Output CSV path (default: %(default)s)",
    )
    parser.add_argument(
        "--overrides",
        default="overrides.toml",
        help="Hand corrections, by job id (default: %(default)s)",
    )
    parser.add_argument(
        "--scraped",
        default="data/scraped.json",
        help="Where to keep the jobs as scraped, for edits from the web app (default: %(default)s)",
    )
    args = parser.parse_args()

    all_jobs = []
    problems = []
    for name, fetch in SCRAPERS:
        print(f"Fetching from {name}...")
        try:
            jobs = fetch()
        except Exception as exc:
            print(f"  failed: {exc}", file=sys.stderr)
            problems.append(f"{name}: raised {exc!r}")
            continue
        print(f"  got {len(jobs)} jobs")
        if len(jobs) == 0:
            problems.append(f"{name}: returned 0 jobs")
        all_jobs.extend(jobs)

    all_jobs, cleaned = normalize_jobs(all_jobs)
    print(
        f"Cleaned up: {cleaned['tag_spellings_merged']} tag spellings merged "
        f"({cleaned['tags']} tags left), {cleaned['org_names_changed']} organization names"
    )
    print(f"Total before dedup: {len(all_jobs)}")
    merged = merge_duplicates(all_jobs)
    print(f"Total after dedup: {len(merged)}")
    save_scraped(args.scraped, merged)

    try:
        overrides = load_overrides(args.overrides)
    except OverridesError as exc:
        print(f"  {args.overrides} not applied: {exc}", file=sys.stderr)
        problems.append(f"{args.overrides}: {exc}")
        overrides = {}

    merged, redundant = finish(merged, overrides)
    unknown_tags = Counter()
    unread_salaries = []
    for job in merged:
        unknown_tags.update(classify_tags(job.get("tags"))[1])
        if job.get("salary_range", "").strip() and not (job["salary_min"] or job["salary_max"]):
            unread_salaries.append(job["salary_range"].strip())
    # Not failures: a new tag stays in `tags`, an unread salary in salary_range.
    # Named here so scrapers/tag_fields.py can be extended when a board adds tags.
    if unknown_tags:
        listed = ", ".join(f"{t} ({n})" for t, n in unknown_tags.most_common())
        print(f"Tags not in scrapers/tag_fields.py: {listed}")
    ids = {j["id"] for j in merged}
    applied = [i for i in overrides if i in ids]
    print(f"Overrides applied to {len(applied)} jobs")
    # Also not failures: listed so stale entries can be deleted from the file.
    stale = [i for i in overrides if i not in applied]
    if stale:
        print(f"Overrides for jobs not in this scrape: {', '.join(stale)}")
    if redundant:
        print(f"Overrides the scrape now matches: {', '.join(redundant)}")
    print(f"Salaries read: {sum(1 for j in merged if j['salary_min'] or j['salary_max'])}, "
          f"not read: {len(unread_salaries)} {sorted(set(unread_salaries))}")

    write_csv(args.output, merged)

    print(f"Wrote {len(merged)} jobs to {args.output}")

    # A board that raised or came back empty is a signal something broke (e.g. a
    # site redesign tripping up a scraper), not necessarily "no jobs today" - job
    # boards essentially never legitimately hit zero. Exiting non-zero here is what
    # makes that visible: this script runs unattended via hireme-scrape.timer, and a
    # failed exit status is what shows up in `systemctl --failed` / `systemctl status
    # hireme-scrape.service`, instead of the run silently reporting success either way.
    if problems:
        print(f"\n{len(problems)} problem(s) this run:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
