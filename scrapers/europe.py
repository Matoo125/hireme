"""Whether someone living in Europe can take each job, read by Claude.

For every job, Claude reads the full posting (scrapers/postings.py), or the
board's summary when the posting couldn't be read, and answers yes, no or
unclear with a short reason quoting the deciding requirement ("only
considering applicants based in North America"). The scrape puts both into
jobs.csv as `europe` and `europe_reason`; the web app hides "no" jobs by
default.

Readings are kept in data/europe.json, keyed by job id with a hash of the
text read, so a job is read again only when that text changes (its posting
fetched at last, say) or the model does. Jobs no longer listed are dropped.
Without ANTHROPIC_API_KEY nothing new is read and jobs keep earlier readings.

    python3 -m scrapers.europe          # read what's missing for jobs.csv
"""

import argparse
import csv
import hashlib
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from scrapers import postings

MODEL = "claude-haiku-5-5"
VERDICTS = ("yes", "no", "unclear")
SAVE_EVERY = 20

SYSTEM = """You read one job posting for a job board used by candidates who live in Europe.

Decide whether a candidate living in Europe, with EU citizenship and no other work
authorization, could be hired for this role and do it:
- "yes": remote work open to Europe (or worldwide), or based at a location in Europe,
  or the employer says it sponsors visas / helps relocate.
- "no": it requires living or being authorized to work outside Europe (e.g. US work
  authorization, US-based only, on-site in a non-European city with no sponsorship),
  or working hours that rule out European time zones.
- "unclear": the posting doesn't say enough to tell.

Give a reason of at most 15 words, quoting the deciding requirement when there is one."""


def reading_schema():
    from typing import Literal

    from pydantic import BaseModel

    class Reading(BaseModel):
        europe: Literal["yes", "no", "unclear"]
        reason: str

    return Reading


def job_input(job, postings_dir):
    """What Claude reads for job: the full posting if it was read, else the summary."""
    lines = [f"Title: {job.get('title', '')}", f"Organization: {job.get('organization_name', '')}"]
    if job.get("location", "").strip():
        lines.append(f"Board location tags: {job['location'].strip()}")
    posting = postings.text_of(postings_dir, job["id"])
    if posting:
        lines.append(f"\nPosting:\n{posting}")
    else:
        lines.append(f"\nPosting summary (the full posting couldn't be read):\n{job.get('description', '')}")
    return "\n".join(lines)


def _hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def read_one(client, text):
    """{europe, reason} for one posting, or None if the model declined."""
    response = client.messages.parse(
        model=MODEL,
        max_tokens=2000,
        system=SYSTEM,
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": text}],
        output_format=reading_schema(),
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        return None
    return {"europe": response.parsed_output.europe, "reason": response.parsed_output.reason.strip()}


def annotate(jobs, data_dir, today, client=None, workers=6):
    """Set each job's `europe` and `europe_reason`, reading the jobs not read
    yet. Returns (read, failed, skipped); skipped are left unread for lack
    of an API key."""
    data_dir = Path(data_dir)
    store_path = data_dir / "europe.json"
    try:
        store = json.loads(store_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        store = {}
    inputs = {job["id"]: job_input(job, data_dir / "postings") for job in jobs}
    store = {i: r for i, r in store.items()
             if i in inputs and r.get("input") == _hash(inputs[i]) and r.get("model") == MODEL}
    todo = [job for job in jobs if job["id"] not in store]

    read = failed = skipped = 0
    if todo and client is None and not os.environ.get("ANTHROPIC_API_KEY"):
        skipped = len(todo)
        todo = []
    if todo:
        import anthropic
        client = client or anthropic.Anthropic()

        def run(job):
            try:
                return job, read_one(client, inputs[job["id"]])
            # ValueError: output that doesn't parse.
            except (anthropic.APIError, ValueError) as exc:
                print(f"  {job['id']}: {exc}", file=sys.stderr)
                return job, None

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for job, result in pool.map(run, todo):
                if result is None:
                    failed += 1
                    continue
                store[job["id"]] = {**result, "input": _hash(inputs[job["id"]]), "model": MODEL, "read_at": today}
                read += 1
                if read % SAVE_EVERY == 0:
                    _write_json(store_path, store)
    _write_json(store_path, store)

    for job in jobs:
        reading = store.get(job["id"], {})
        job["europe"] = reading.get("europe", "")
        job["europe_reason"] = reading.get("reason", "")
    return read, failed, skipped


def main():
    parser = argparse.ArgumentParser(prog="python3 -m scrapers.europe", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--jobs", default="jobs.csv")
    parser.add_argument("--data", default="data")
    args = parser.parse_args()
    with open(args.jobs, newline="", encoding="utf-8") as f:
        jobs = list(csv.DictReader(f))
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    read, failed, skipped = annotate(jobs, args.data, today)
    counts = {v: sum(1 for j in jobs if j["europe"] == v) for v in VERDICTS}
    print(f"Read {read}, failed {failed}, skipped {skipped} (no ANTHROPIC_API_KEY); {counts}")
    print("Readings go into jobs.csv with the next scrape.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
