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
than one board.
"""

import argparse
import csv
import sys

from scrapers import (
    animal_advocacy_careers,
    ea_opportunities,
    eighty_thousand_hours,
    probably_good,
)
from scrapers.common import FIELDNAMES
from scrapers.dedupe import merge_duplicates
from scrapers.normalize import normalize_jobs

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

    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        for job in merged:
            writer.writerow(job)

    print(f"Wrote {len(merged)} jobs to {args.output}")

    # A board that raised or came back empty is a signal something broke (e.g. a
    # site redesign tripping up a scraper), not necessarily "no jobs today" - job
    # boards essentially never legitimately hit zero. Exiting non-zero here is what
    # makes that visible: this script runs unattended via hireme-scrape.timer, and a
    # failed exit status is what shows up in `systemctl --failed` / `systemctl status
    # hireme-scrape.service`, instead of the run silently reporting success either way.
    if problems:
        print(f"\n{len(problems)} board(s) had problems this run:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
