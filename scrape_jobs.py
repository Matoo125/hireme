#!/usr/bin/env python3
"""
Scrape remote/global job listings from multiple EA-adjacent job boards
into a single deduplicated CSV:

  - 80,000 Hours   https://jobs.80000hours.org
  - Probably Good  https://jobs.probablygood.org
  - EA Opportunities Board  https://www.effectivealtruism.org/opportunities
  - Animal Advocacy Careers  https://animaladvocacycareers.org/job-board/

Each board is scraped by its own module in scrapers/, normalized to a
common schema, then merged and deduplicated (scrapers/dedupe.py) since
the same role is often cross-posted to more than one board.
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
    for name, fetch in SCRAPERS:
        print(f"Fetching from {name}...")
        try:
            jobs = fetch()
        except Exception as exc:
            print(f"  failed: {exc}", file=sys.stderr)
            continue
        print(f"  got {len(jobs)} jobs")
        all_jobs.extend(jobs)

    print(f"Total before dedup: {len(all_jobs)}")
    merged = merge_duplicates(all_jobs)
    print(f"Total after dedup: {len(merged)}")

    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        for job in merged:
            writer.writerow(job)

    print(f"Wrote {len(merged)} jobs to {args.output}")


if __name__ == "__main__":
    main()
