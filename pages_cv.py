#!/usr/bin/env python3
"""
Make a user's public portfolio page content from their CV, with Claude.

For each user who has turned their page on (data/pages/<id>.json, enabled) and
uploaded a CV (data/cv/<id>.pdf), the CV is read into data/page-content/<id>.json:
the name, a headline, a short summary, skills, experience, education, projects
and links the CV itself states. The web app serves that as <slug>.hireme.sk.
Content is remade only when the CV changes.

Contact details (email, phone, address, date of birth) are left out on purpose:
the schema has no field for them, and the prompt tells the model not to.

    python3 pages_cv.py --user 42               # make content for user 42 if needed
    python3 pages_cv.py --user 42 --dry-run     # say what would happen, call nothing

Needs ANTHROPIC_API_KEY (or another credential the SDK finds).
"""

import argparse
import base64
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

MODEL = "claude-haiku-5-5"
# Bumped when the schema or prompt changes, to remake every page's content.
CONTENT_VERSION = 1

SYSTEM = """You write a public portfolio page for a job seeker, from their CV.
Use only what the CV states. Do not invent, infer or embellish: if something is
not in the CV, leave the field empty or the list empty.

Never include contact details: no email addresses, phone numbers, postal
addresses, dates of birth, national IDs, photos, or references to family,
health, religion or other personal matters. Links are only ones the CV itself
gives (a personal website, GitHub, LinkedIn, a project URL); leave out
anything else.

Write the summary and bullets in the CV's own language and in plain, factual
sentences. Keep the headline to one short line, such as the current or most
recent role and the field. Keep each bullet short."""


def page_schema():
    from pydantic import BaseModel, Field

    class Link(BaseModel):
        label: str
        url: str

    class Role(BaseModel):
        title: str
        organization: str = ""
        period: str = Field("", description="As written in the CV, e.g. '2019 - 2024'")
        location: str = ""
        bullets: list[str] = Field(default_factory=list)

    class Education(BaseModel):
        school: str
        degree: str = ""
        period: str = ""

    class Project(BaseModel):
        title: str
        description: str = ""
        url: str = ""

    class Page(BaseModel):
        name: str
        headline: str = ""
        summary: str = ""
        skills: list[str] = Field(default_factory=list)
        experience: list[Role] = Field(default_factory=list)
        education: list[Education] = Field(default_factory=list)
        projects: list[Project] = Field(default_factory=list)
        links: list[Link] = Field(default_factory=list)

    return Page


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


def make_content(client, cv_pdf):
    """The page's content as a dict matching web/lib/pages.ts PageContent.content."""
    response = client.messages.parse(
        model=MODEL,
        max_tokens=4000,
        system=SYSTEM,
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": [
            {
                "type": "document",
                "source": {"type": "base64", "media_type": "application/pdf",
                           "data": base64.standard_b64encode(cv_pdf).decode("ascii")},
                "title": "CV",
            },
            {"type": "text", "text": "Write the portfolio page content for this CV."},
        ]}],
        output_format=page_schema(),
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise ValueError(f"no content ({response.stop_reason})")
    return response.parsed_output.model_dump()


def current_cv_hash(cv_path):
    """sha256 hex of the CV as it is on disk now, or None if it has been removed."""
    try:
        return hashlib.sha256(Path(cv_path).read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def make_user_page(user_id, data_dir, dry_run=False, client=None):
    """Write data/page-content/<id>.json if the user's page is on and its content
    is out of date. Returns True if content was written (or would be, on a dry run)."""
    settings = read_json(data_dir / "pages" / f"{user_id}.json", {})
    if not settings.get("enabled"):
        print(f"User {user_id}: page not turned on, skipped")
        return False
    cv_path = data_dir / "cv" / f"{user_id}.pdf"
    if not cv_path.exists():
        print(f"User {user_id}: no CV uploaded, skipped")
        return False
    cv_pdf = cv_path.read_bytes()
    cv_hash = hashlib.sha256(cv_pdf).hexdigest()
    content_path = data_dir / "page-content" / f"{user_id}.json"
    saved = read_json(content_path, {})
    if saved.get("cv") == cv_hash and saved.get("model") == MODEL and saved.get("version") == CONTENT_VERSION:
        print(f"User {user_id}: page content already up to date")
        return False
    if dry_run:
        print(f"User {user_id}: page content would be made from the CV")
        return True

    if client is None:
        import anthropic
        client = anthropic.Anthropic()
    content = make_content(client, cv_pdf)
    # The CV can be deleted or replaced while the model reads it. Write only if
    # it is still the one the content was made from; otherwise the web app has
    # already queued another run (or the content should not exist at all).
    if current_cv_hash(cv_path) != cv_hash:
        print(f"User {user_id}: CV changed or was removed while making the page; not saved")
        return False
    write_json(content_path, {
        "cv": cv_hash,
        "model": MODEL,
        "version": CONTENT_VERSION,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "content": content,
    })
    print(f"User {user_id}: page content written")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--user", type=int, required=True, help="user id whose page to make")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / "data")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        make_user_page(args.user, args.data_dir, dry_run=args.dry_run)
    except Exception as exc:  # the web app logs this; one user's failure is not a crash
        print(f"User {args.user}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
