#!/usr/bin/env python3
"""
Score how well each job in jobs.csv fits a user's CV, with Claude.

For each user id in FIT_USER_IDS (comma-separated, or --users) who has
uploaded a CV (data/cv/<id>.pdf), every job without a score gets one: 0-100
and a one-sentence reason, kept in data/fit/<id>.json and served to that user
by the web app (GET /api/fit). Only new jobs are scored on a normal day; a new
CV rescores everything. Scores of jobs no longer listed are dropped. Each job
is read in full: its original posting (scrapers/postings.py) when it could be
fetched, else the board's summary.

The CV goes first in each request with a cache breakpoint, so after the first
job it's read from the prompt cache at a tenth of the price.

    python3 fit_scores.py                 # score what's missing
    python3 fit_scores.py --dry-run       # say what would be scored, call nothing
    python3 fit_scores.py --evaluate      # scores of liked vs hidden jobs

Needs ANTHROPIC_API_KEY (or another credential the SDK finds).
"""

import argparse
import base64
import csv
import hashlib
import json
import os
import statistics
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from scrapers import postings

MODEL = "claude-haiku-5-5"
# Bumped when what the model reads about a job changes, to rescore everything:
# 2 = the full posting instead of the board's summary.
INPUT_VERSION = 2
SAVE_EVERY = 20

SYSTEM = """You help one job seeker decide which job listings are worth their time.
You get their CV, then one job listing. Judge how well the job fits this person:
whether their experience, skills and education qualify them, whether the role's
level matches their career stage, and whether its cause area and kind of work fit
what their CV shows they care about. Location limits matter only when the listing
states them and the CV makes them a clear problem.

Score from 0 to 100:
- 80-100: a strong match; they should apply
- 60-79: a reasonable match worth a look
- 40-59: a partial match; a stretch or a sidestep
- 0-39: a poor match

Give the score and one sentence (at most 25 words) with the main reason, written
to the job seeker as "you"."""


def score_schema():
    from pydantic import BaseModel, Field

    class Fit(BaseModel):
        score: int = Field(ge=0, le=100)
        reason: str

    return Fit


def job_text(job, posting=""):
    """The listing as the model reads it; `posting` is the full posting's
    text (scrapers/postings.py), used instead of the board's summary."""
    lines = [f"Title: {job['title']}", f"Organization: {job['organization_name']}"]
    for label, field in [
        ("About the organization", "organization_description"),
        ("Type", "job_type"), ("Experience", "experience"), ("Education", "education"),
        ("Location", "location"), ("Cause area", "cause_area"), ("Skills", "skills"),
        ("Salary", "salary_range"), ("Closes", "close_date"),
    ] + ([] if posting else [("Description", "description")]):
        if job.get(field, "").strip():
            lines.append(f"{label}: {job[field].strip()}")
    if posting:
        lines.append(f"Full posting:\n{posting}")
    return "\n".join(lines)


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


class Scorer:
    def __init__(self, client, cv_pdf, postings_dir=None):
        self.client = client
        self.postings_dir = postings_dir
        self.cv_block = {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf",
                       "data": base64.standard_b64encode(cv_pdf).decode("ascii")},
            "title": "CV",
            "cache_control": {"type": "ephemeral"},
        }
        self.fit = score_schema()
        self.usage = {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0}

    def posting(self, job):
        return postings.text_of(self.postings_dir, job["id"]) if self.postings_dir else ""

    def score(self, job):
        """{score, reason} for one job, or None if the model declined."""
        response = self.client.messages.parse(
            model=MODEL,
            max_tokens=4000,
            system=SYSTEM,
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": [
                self.cv_block,
                {"type": "text", "text": f"Job listing:\n\n{job_text(job, self.posting(job))}"},
            ]}],
            output_format=self.fit,
        )
        u = response.usage
        self.usage["input"] += u.input_tokens
        self.usage["cache_read"] += u.cache_read_input_tokens or 0
        self.usage["cache_write"] += u.cache_creation_input_tokens or 0
        self.usage["output"] += u.output_tokens
        if response.stop_reason != "end_turn" or response.parsed_output is None:
            print(f"  {job['id']}: no score ({response.stop_reason})", file=sys.stderr)
            return None
        return {"score": response.parsed_output.score, "reason": response.parsed_output.reason.strip()}


def score_user(user_id, jobs, data_dir, dry_run=False, workers=4, client=None):
    """Score user_id's missing jobs. Returns (scored, failed); (0, 0) for a
    user without a CV. `client` is for tests; by default an Anthropic client."""
    cv_path = data_dir / "cv" / f"{user_id}.pdf"
    if not cv_path.exists():
        print(f"User {user_id}: no CV uploaded, skipped")
        return 0, 0
    cv_pdf = cv_path.read_bytes()
    cv_hash = hashlib.sha256(cv_pdf).hexdigest()
    fit_path = data_dir / "fit" / f"{user_id}.json"
    saved = read_json(fit_path, {})
    current = saved.get("cv") == cv_hash and saved.get("model") == MODEL and saved.get("input") == INPUT_VERSION
    scores = saved.get("scores", {}) if current else {}
    listed = {job["id"] for job in jobs}
    scores = {i: s for i, s in scores.items() if i in listed}
    todo = [job for job in jobs if job["id"] not in scores]
    print(f"User {user_id}: {len(scores)} jobs scored already, {len(todo)} to score"
          + (" (new CV)" if saved and saved.get("cv") != cv_hash else ""))
    if dry_run or not todo:
        if not dry_run:
            write_json(fit_path, {"cv": cv_hash, "model": MODEL, "input": INPUT_VERSION, "scores": scores})
        return 0, 0

    import anthropic
    scorer = Scorer(client or anthropic.Anthropic(), cv_pdf, data_dir / "postings")
    failed = 0
    done = 0

    def save():
        write_json(fit_path, {"cv": cv_hash, "model": MODEL, "input": INPUT_VERSION, "scores": scores})

    def run(job):
        try:
            return job, scorer.score(job)
        # ValueError: output that doesn't parse (cut off by max_tokens, say).
        except (anthropic.APIError, ValueError) as exc:
            print(f"  {job['id']}: {exc}", file=sys.stderr)
            return job, None

    # The first request alone writes the CV to the prompt cache; the rest
    # read it from there.
    first, rest = todo[:1], todo[1:]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for batch in (first, rest):
            for job, result in pool.map(run, batch):
                if result is None:
                    failed += 1
                    continue
                scores[job["id"]] = {**result, "scored_at": datetime.now(timezone.utc).strftime("%Y-%m-%d")}
                done += 1
                if done % SAVE_EVERY == 0:
                    save()
    save()
    u = scorer.usage
    print(f"  scored {done}, failed {failed}; tokens: {u['input']} input, {u['cache_read']} cache read, "
          f"{u['cache_write']} cache write, {u['output']} output")
    return done, failed


def evaluate(user_id, data_dir):
    """How the scores line up with what the user liked and hid."""
    scores = read_json(data_dir / "fit" / f"{user_id}.json", {}).get("scores", {})
    prefs = read_json(data_dir / "preferences" / f"{user_id}.json", {})
    groups = {"liked": prefs.get("liked", []), "hidden": prefs.get("hidden", [])}
    print(f"User {user_id}: {len(scores)} jobs scored")
    for name, ids in groups.items():
        values = sorted(scores[i]["score"] for i in ids if i in scores)
        if values:
            print(f"  {name}: {len(values)} scored, median {statistics.median(values)}, "
                  f"below 40: {sum(v < 40 for v in values)}, 60 and up: {sum(v >= 60 for v in values)}")
        else:
            print(f"  {name}: none scored")
    hidden = [scores[i]["score"] for i in groups["hidden"] if i in scores]
    if hidden:
        # The roadmap's bar: the "For you" view should let you skip at least
        # half of what you'd hide, i.e. score it below 40.
        print(f"  hidden jobs scored below 40: {sum(v < 40 for v in hidden) / len(hidden):.0%} (goal: 50% or more)")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--jobs", default="jobs.csv")
    parser.add_argument("--data", default="data")
    parser.add_argument("--users", default=os.environ.get("FIT_USER_IDS", ""),
                        help="comma-separated user ids (default: $FIT_USER_IDS)")
    parser.add_argument("--dry-run", action="store_true", help="say what would be scored; call nothing")
    parser.add_argument("--evaluate", action="store_true", help="compare scores with liked and hidden jobs")
    args = parser.parse_args()

    users = [u.strip() for u in args.users.split(",") if u.strip()]
    if not users:
        print("No users to score (set FIT_USER_IDS or pass --users)")
        return
    data_dir = Path(args.data)
    if args.evaluate:
        for user in users:
            evaluate(user, data_dir)
        return

    with open(args.jobs, newline="", encoding="utf-8") as f:
        jobs = list(csv.DictReader(f))
    failed = 0
    for user in users:
        failed += score_user(user, jobs, data_dir, dry_run=args.dry_run)[1]
    # A few failures are retried tomorrow (unscored jobs stay on the list);
    # exiting non-zero makes them visible in the scrape's healthcheck.
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
