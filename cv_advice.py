#!/usr/bin/env python3
"""
Suggest how a user could improve their CV for the jobs they're going for, with Claude.

Reads the user's CV (data/cv/<id>.pdf) next to the jobs they care about: the
ones they liked or track as applications, then their best fit scores, up to
MAX_JOBS, skipping any they hid. Claude compares them and writes concrete
suggestions (what to add, reword, move up or cut) into data/cv-advice/<id>.json.
The user edits the PDF themselves; nothing here changes the CV.

Runs only when the user asks (the web app's "Suggest improvements" button).
It does nothing when the CV and the chosen jobs are the same as last time,
unless --force.

    python3 cv_advice.py --user 42              # write advice for user 42
    python3 cv_advice.py --user 42 --dry-run    # say which jobs it would use, call nothing

Needs ANTHROPIC_API_KEY (or another credential the SDK finds).
"""

import argparse
import base64
import csv
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from fit_scores import job_text
from scrapers import postings

MODEL = "claude-opus-5-5"
# Bumped when the schema or prompt changes, so the same CV and jobs get new advice.
ADVICE_VERSION = 1
MAX_JOBS = 15
# Below this a fit score isn't a job the user is going for.
MIN_FIT = 60

SYSTEM = """You help one job seeker improve their CV for the jobs they want.
You get their CV, then the job listings they liked, are applying to, or that fit
them best. Suggest concrete changes to the CV that would make it stronger for
these jobs: what to add, reword, move up, shorten or cut.

Be honest. Never suggest claiming experience, skills, results or qualifications
the CV doesn't show. When the jobs ask for something the CV doesn't mention,
say so as a question the person can answer for themselves ("If you have led a
team, say so in..."), not as a fact to add. Point at specific parts of the CV
(a role, a bullet, the summary) and quote the current wording when you suggest
rewording it. Prefer changes that help across many of these jobs over ones
that help with only one, and say which jobs each change helps with.

Write to the job seeker as "you", in the CV's own language, plainly. Give at
most 8 suggestions, most useful first. Also list what the CV already does well
for these jobs, briefly, so they know what to keep."""


def advice_schema():
    from pydantic import BaseModel, Field

    class Suggestion(BaseModel):
        title: str = Field(description="A short imperative, e.g. 'Lead with your policy research'")
        where: str = Field("", description="The part of the CV it concerns, e.g. 'Summary' or 'Acme, 2020-2024'")
        change: str = Field(description="What to change; quote current wording when rewording it")
        why: str = Field(description="Why it helps, tied to what these jobs ask for")
        job_ids: list[str] = Field(default_factory=list, description="Ids of the jobs it helps with")

    class Advice(BaseModel):
        summary: str = Field(description="Two or three sentences: how the CV reads against these jobs overall")
        keep: list[str] = Field(default_factory=list, description="What already works, one short line each")
        suggestions: list[Suggestion] = Field(default_factory=list)

    return Advice


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


def pick_jobs(user_id, jobs, data_dir):
    """The listed jobs to compare the CV against, in order: liked, then
    tracked applications, then the best fit scores of MIN_FIT or more."""
    by_id = {job["id"]: job for job in jobs}
    prefs = read_json(data_dir / "preferences" / f"{user_id}.json", {})
    apps = read_json(data_dir / "applications" / f"{user_id}.json", {})
    scores = read_json(data_dir / "fit" / f"{user_id}.json", {}).get("scores", {})
    hidden = set(prefs.get("hidden", []))
    best = sorted((i for i, s in scores.items() if s.get("score", 0) >= MIN_FIT),
                  key=lambda i: -scores[i]["score"])
    picked = []
    for job_id in [*prefs.get("liked", []), *apps, *best]:
        if job_id in by_id and job_id not in hidden and job_id not in picked:
            picked.append(job_id)
    return [by_id[i] for i in picked[:MAX_JOBS]]


def make_advice(client, cv_pdf, jobs, postings_dir=None):
    """The advice as a dict: {summary, keep, suggestions}."""
    listings = "\n\n---\n\n".join(
        f"Job id: {job['id']}\n{job_text(job, postings.text_of(postings_dir, job['id']) if postings_dir else '')}"
        for job in jobs
    )
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        output_config={"effort": "medium"},
        messages=[{"role": "user", "content": [
            {
                "type": "document",
                "source": {"type": "base64", "media_type": "application/pdf",
                           "data": base64.standard_b64encode(cv_pdf).decode("ascii")},
                "title": "CV",
            },
            {"type": "text", "text": f"The jobs I'm going for:\n\n{listings}\n\nHow should I improve my CV for them?"},
        ]}],
        output_format=advice_schema(),
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise ValueError(f"no advice ({response.stop_reason})")
    advice = response.parsed_output.model_dump()
    # Only ids of jobs it was shown, so the page can link each one.
    shown = {job["id"] for job in jobs}
    for s in advice["suggestions"]:
        s["job_ids"] = [i for i in s["job_ids"] if i in shown]
    return advice


def advise_user(user_id, jobs, data_dir, dry_run=False, force=False, client=None):
    """Write data/cv-advice/<id>.json. Returns True if advice was written (or
    would be, on a dry run)."""
    cv_path = data_dir / "cv" / f"{user_id}.pdf"
    if not cv_path.exists():
        print(f"User {user_id}: no CV uploaded, skipped")
        return False
    picked = pick_jobs(user_id, jobs, data_dir)
    if not picked:
        print(f"User {user_id}: no liked, tracked or well-fitting jobs to compare the CV with")
        return False
    cv_pdf = cv_path.read_bytes()
    cv_hash = hashlib.sha256(cv_pdf).hexdigest()
    job_ids = [job["id"] for job in picked]
    advice_path = data_dir / "cv-advice" / f"{user_id}.json"
    saved = read_json(advice_path, {})
    if (not force and saved.get("cv") == cv_hash and saved.get("jobs") == job_ids
            and saved.get("model") == MODEL and saved.get("version") == ADVICE_VERSION):
        print(f"User {user_id}: advice already up to date")
        return False
    if dry_run:
        print(f"User {user_id}: advice would be made from the CV and {len(picked)} jobs:")
        for job in picked:
            print(f"  {job['id']}  {job['title']} ({job['organization_name']})")
        return True

    if client is None:
        import anthropic
        client = anthropic.Anthropic()
    advice = make_advice(client, cv_pdf, picked, data_dir / "postings")
    write_json(advice_path, {
        "cv": cv_hash,
        "model": MODEL,
        "version": ADVICE_VERSION,
        "jobs": job_ids,
        "jobTitles": {job["id"]: f"{job['title']} – {job['organization_name']}" for job in picked},
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "advice": advice,
    })
    print(f"User {user_id}: advice written ({len(advice['suggestions'])} suggestions, {len(picked)} jobs)")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--user", type=int, required=True, help="user id to advise")
    parser.add_argument("--jobs", type=Path, default=Path(__file__).parent / "jobs.csv")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / "data")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="advise again even if nothing changed")
    args = parser.parse_args()
    try:
        with open(args.jobs, newline="", encoding="utf-8") as f:
            jobs = list(csv.DictReader(f))
        advise_user(args.user, jobs, args.data_dir, dry_run=args.dry_run, force=args.force)
    except Exception as exc:  # the web app logs this; one user's failure is not a crash
        print(f"User {args.user}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
