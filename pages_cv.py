#!/usr/bin/env python3
"""
Make a user's public portfolio page content from their CV, with Claude.

For each user who has turned their page on (data/pages/<id>.json, enabled) and
uploaded a CV (data/cv/<id>.pdf), the CV is read into data/page-content/<id>.json:
the name, a headline, a short summary, skills, experience, education, projects
and links the CV itself states. The web app serves that as <slug>.hireme.sk.
Content is remade only when the CV changes, and never over the user's own
edits (the web app's page editor) unless --force (its "Remake from CV" button).

Contact details (email, phone, address, date of birth) are left out on purpose:
the schema has no field for them, the prompt tells the model not to, and any
email address or phone number that slips into the text anyway is cut out.

    python3 pages_cv.py --user 42               # make content for user 42 if needed
    python3 pages_cv.py --user 42 --force       # remake it, replacing the user's edits
    python3 pages_cv.py --user 42 --dry-run     # say what would happen, call nothing

Needs ANTHROPIC_API_KEY (or another credential the SDK finds).
"""

import argparse
import base64
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

MODEL = "claude-haiku-5-5"
# Bumped when the schema or prompt changes, to remake every page's content.
CONTENT_VERSION = 2

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
        language: str = Field("", description="The CV's language as a BCP 47 code, e.g. 'sk', 'cs' or 'en'")
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


# What the prompt forbids, caught again in case the model writes it anyway.
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# International (+421 905 123 456, 00421...) and Slovak/Czech-style local
# numbers (0905 123 456). Years and periods ("2019 - 2024") don't match.
PHONE = re.compile(r"(?:\+|\b00)\d{1,3}(?:[\s./-]?\(?\d{1,4}\)?){2,5}|\b0\d{3}[\s./-]?\d{3}[\s./-]?\d{3}\b")


def scrub_contacts(value):
    """`value` with email addresses and phone numbers cut out of every string."""
    if isinstance(value, str):
        cleaned = PHONE.sub("", EMAIL.sub("", value))
        return re.sub(r"\s{2,}", " ", cleaned).strip() if cleaned != value else value
    if isinstance(value, list):
        return [scrub_contacts(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub_contacts(v) for k, v in value.items()}
    return value


def make_content(client, cv_pdf):
    """The page's content as a dict matching web/lib/pages.ts PageContent.content."""
    response = client.messages.parse(
        model=MODEL,
        max_tokens=8000,
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
    content = response.parsed_output.model_dump()
    # Links aren't text: one that is an email or phone number goes entirely.
    content["links"] = [l for l in content["links"] if not (EMAIL.search(l["url"]) or PHONE.search(l["url"]))]
    return scrub_contacts(content)


def cv_hash_now(cv_path):
    """sha256 of the CV as it is now, or None if it's gone."""
    try:
        return hashlib.sha256(cv_path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def make_user_page(user_id, data_dir, dry_run=False, force=False, client=None):
    """Write data/page-content/<id>.json if the user's page is on and its content
    is out of date. Content the user edited is kept unless `force`. Returns True
    if content was written (or would be, on a dry run)."""
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
    if not force and saved.get("edited"):
        print(f"User {user_id}: page content was edited by the user, kept")
        return False
    if (not force and saved.get("cv") == cv_hash and saved.get("model") == MODEL
            and saved.get("version") == CONTENT_VERSION):
        print(f"User {user_id}: page content already up to date")
        return False
    if dry_run:
        print(f"User {user_id}: page content would be made from the CV")
        return True

    if client is None:
        import anthropic
        client = anthropic.Anthropic()
    content = make_content(client, cv_pdf)
    # The call takes a while. If the CV was deleted or replaced meanwhile, this
    # content is for a CV that's gone (the server runs again for a new one);
    # if the user saved edits meanwhile, theirs win.
    if cv_hash_now(cv_path) != cv_hash:
        print(f"User {user_id}: CV changed during the run, content not written")
        return False
    if read_json(content_path, {}).get("editedAt") != saved.get("editedAt"):
        print(f"User {user_id}: page edited during the run, content not written")
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
    parser.add_argument("--force", action="store_true", help="remake even if up to date or edited by the user")
    args = parser.parse_args()
    try:
        make_user_page(args.user, args.data_dir, dry_run=args.dry_run, force=args.force)
    except Exception as exc:  # the web app logs this; one user's failure is not a crash
        print(f"User {args.user}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
