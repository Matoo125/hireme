"""Daily snapshots of the scrape, and the date each job was first seen.

Each scrape writes data/history/<date>.json (the jobs it found: id, title,
organization, dates) and adds any new ids to data/history/first-seen.json,
which never forgets an id, so a job missing for a day (a board failing, say)
keeps its first date when it comes back. scrape_jobs.py copies that date into
each job's `first_seen` column.

If first-seen.json doesn't exist yet, it's built from the git history of
jobs.csv first (one entry per commit, back to when jobs got ids), so jobs
already listed get the date they first appeared rather than today's.

    python3 -m scrapers.history backfill   # rebuild first-seen.json from git
"""

import argparse
import csv
import io
import json
import subprocess
import sys
from pathlib import Path

SNAPSHOT_FIELDS = ["id", "title", "organization_name", "publication_date", "close_date", "source"]


def _write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=0, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def first_seen_from_git(jobs_csv="jobs.csv"):
    """{id: date} from every commit of jobs_csv, oldest first. Empty if the
    file has no git history (or git isn't there)."""
    path = Path(jobs_csv).resolve()
    try:
        log = subprocess.run(
            ["git", "log", "--reverse", "--format=%H %cs", "--", path.name],
            cwd=path.parent, capture_output=True, text=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return {}
    seen = {}
    for line in log.splitlines():
        commit, day = line.split()
        try:
            text = subprocess.run(
                ["git", "show", f"{commit}:./{path.name}"],
                cwd=path.parent, capture_output=True, text=True, check=True,
            ).stdout
        except subprocess.CalledProcessError:
            continue
        for row in csv.DictReader(io.StringIO(text)):
            if row.get("id"):
                seen.setdefault(row["id"], day)
    return seen


def load_first_seen(history_dir, jobs_csv="jobs.csv"):
    path = Path(history_dir) / "first-seen.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return first_seen_from_git(jobs_csv)


def record(jobs, day, history_dir, jobs_csv="jobs.csv"):
    """Save today's snapshot, add new ids to first-seen.json, and set each
    job's `first_seen`. Returns how many jobs weren't seen before."""
    seen = load_first_seen(history_dir, jobs_csv)
    new = 0
    for job in jobs:
        if job["id"] not in seen:
            seen[job["id"]] = day
            new += 1
        job["first_seen"] = seen[job["id"]]
    snapshot = [{f: job.get(f, "") for f in SNAPSHOT_FIELDS} for job in jobs]
    _write_json(Path(history_dir) / f"{day}.json", sorted(snapshot, key=lambda j: j["id"]))
    _write_json(Path(history_dir) / "first-seen.json", seen)
    return new


def main():
    parser = argparse.ArgumentParser(prog="python3 -m scrapers.history")
    sub = parser.add_subparsers(dest="command", required=True)
    backfill = sub.add_parser("backfill", help="rebuild first-seen.json from jobs.csv's git history")
    backfill.add_argument("--jobs", default="jobs.csv")
    backfill.add_argument("--history", default="data/history")
    args = parser.parse_args()

    seen = first_seen_from_git(args.jobs)
    if not seen:
        sys.exit(f"no git history for {args.jobs}")
    # Keep ids only the current file knows (seen since the last commit).
    path = Path(args.history) / "first-seen.json"
    if path.exists():
        for job_id, day in json.loads(path.read_text(encoding="utf-8")).items():
            seen[job_id] = min(day, seen.get(job_id, day))
    _write_json(path, seen)
    print(f"Wrote first-seen dates for {len(seen)} job ids to {path}")


if __name__ == "__main__":
    main()
