#!/usr/bin/env python3
"""
Draft an application for one job from the user's CV, with Claude.

Reads the CV (data/cv/<id>.pdf) and the job: its listing in jobs.csv or the
user's own added jobs (data/custom-jobs/<id>.json), with the full posting when
it was read (data/postings/). Claude writes a cover letter, answers to the
questions the posting asks applicants, and the requirements the CV doesn't
show, into data/drafts/<user>/<job>.json. The user edits and sends it
themselves; nothing here applies anywhere.

Runs only when the user asks (the "Draft application" button on a tracked job).
It does nothing when the CV and the job are the same as last time, unless --force.

    python3 application_draft.py --user 42 --job 0a1b2c3d4e5f
    python3 application_draft.py --user 42 --job 0a1b2c3d4e5f --dry-run

Needs ANTHROPIC_API_KEY (or another credential the SDK finds).
"""

import argparse
import base64
import csv
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from cv_advice import read_json, write_json
from fit_scores import job_text
from scrapers import postings

MODEL = "claude-opus-5-5"
# Bumped when the schema or prompt changes, so the same CV and job get a new draft.
DRAFT_VERSION = 1
JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

SYSTEM = """You help one job seeker apply to one job. You get their CV and the
job's listing. Write a draft they will edit and send themselves:

1. A cover letter: about 250-350 words, addressed to the organization, in the
   posting's language. Open with why this role and this organization, then two
   or three specific things from the CV that match what the posting asks for,
   then a short close. Plain and direct; no clichés ("I am writing to express my
   interest", "passionate", "team player"), no flattery.
2. Answers to the questions the posting asks applicants to answer, if it asks
   any (e.g. "Why do you want to work here?", "Describe a time you..."). Quote
   each question as the posting words it. Respect any word limit it gives. If it
   asks none, return no answers.
3. Gaps: requirements the posting states that the CV doesn't show, one short
   line each, so they can address them or decide not to apply.

Be honest. Use only what the CV shows: never invent experience, skills, results,
numbers or qualifications. Where a strong answer needs something the CV doesn't
say, write a placeholder in square brackets for the person to fill in, e.g.
"[a project where you managed a budget]". Don't include contact details or a
postal address block; the person adds those."""


def draft_schema():
    from pydantic import BaseModel, Field

    class Answer(BaseModel):
        question: str = Field(description="The question as the posting asks it")
        answer: str

    class Draft(BaseModel):
        language: str = Field(description="BCP 47 tag of the language the letter is in, e.g. 'en' or 'sk'")
        letter: str = Field(description="The cover letter, paragraphs separated by blank lines")
        answers: list[Answer] = Field(default_factory=list)
        gaps: list[str] = Field(default_factory=list)

    return Draft


def find_job(user_id, job_id, jobs, data_dir):
    """The job from the listing, or from the user's own added jobs; None if neither has it."""
    for job in jobs:
        if job.get("id") == job_id:
            return job
    for job in read_json(data_dir / "custom-jobs" / f"{user_id}.json", []):
        if job.get("id") == job_id:
            return job
    return None


def make_draft(client, cv_pdf, job, posting=""):
    """The draft as a dict: {language, letter, answers, gaps}."""
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
            {"type": "text", "text": f"The job I'm applying to:\n\n{job_text(job, posting)}\n\nDraft my application."},
        ]}],
        output_format=draft_schema(),
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise ValueError(f"no draft ({response.stop_reason})")
    return response.parsed_output.model_dump()


def draft_path(data_dir, user_id, job_id):
    return data_dir / "drafts" / str(user_id) / f"{job_id}.json"


def draft_application(user_id, job_id, jobs, data_dir, dry_run=False, force=False, client=None):
    """Write data/drafts/<user>/<job>.json. Returns True if a draft was written
    (or would be, on a dry run)."""
    if not JOB_ID.match(job_id):
        raise ValueError(f"bad job id {job_id!r}")
    cv_path = data_dir / "cv" / f"{user_id}.pdf"
    if not cv_path.exists():
        print(f"User {user_id}: no CV uploaded, skipped")
        return False
    job = find_job(user_id, job_id, jobs, data_dir)
    if job is None:
        print(f"User {user_id}: job {job_id} not found")
        return False
    cv_pdf = cv_path.read_bytes()
    cv_hash = hashlib.sha256(cv_pdf).hexdigest()
    posting = postings.text_of(data_dir / "postings", job_id)
    out = draft_path(data_dir, user_id, job_id)
    saved = read_json(out, {})
    if (not force and saved.get("cv") == cv_hash and saved.get("model") == MODEL
            and saved.get("version") == DRAFT_VERSION):
        print(f"User {user_id}: draft for {job_id} already up to date")
        return False
    if dry_run:
        print(f"User {user_id}: would draft {job['title']} ({job['organization_name']}), "
              f"{'full posting' if posting else 'listing only'}")
        return True

    if client is None:
        import anthropic
        client = anthropic.Anthropic()
    draft = make_draft(client, cv_pdf, job, posting)
    # The CV may be replaced or deleted while the model runs: don't save a
    # draft made from a CV the user no longer has.
    if not cv_path.exists() or hashlib.sha256(cv_path.read_bytes()).hexdigest() != cv_hash:
        print(f"User {user_id}: CV changed during the run, draft not saved")
        return False
    write_json(out, {
        "cv": cv_hash,
        "model": MODEL,
        "version": DRAFT_VERSION,
        "job": job_id,
        "fromPosting": bool(posting),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "draft": draft,
    })
    print(f"User {user_id}: draft written for {job_id} ({len(draft['answers'])} answers, {len(draft['gaps'])} gaps)")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--user", type=int, required=True)
    parser.add_argument("--job", required=True, help="job id")
    parser.add_argument("--jobs", type=Path, default=Path(__file__).parent / "jobs.csv")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / "data")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="draft again even if nothing changed")
    args = parser.parse_args()
    try:
        with open(args.jobs, newline="", encoding="utf-8") as f:
            jobs = list(csv.DictReader(f))
        draft_application(args.user, args.job, jobs, args.data_dir, dry_run=args.dry_run, force=args.force)
    except Exception as exc:  # the web app logs this; one user's failure is not a crash
        print(f"User {args.user}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
