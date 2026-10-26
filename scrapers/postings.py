"""The full text of each job's original posting.

The boards give a summary (a few hundred characters); the posting behind
each job's link has the rest: who can apply from where, what it pays, the
whole description. Each scrape fetches the posting of every job it hasn't
fetched yet into data/postings/<id>.json:

    {"link": ..., "fetched_at": "2026-10-26", "status": 200, "text": "..."}

`text` is the page's readable text, or the description in its schema.org
JobPosting data when that's longer (Ashby pages, for one, render the
posting with JavaScript but embed it there). A public Google Doc is fetched
as plain text. A posting that couldn't be read (a login wall, a form, a PDF)
is kept with whatever text it gave and fetched again after RETRY_DAYS.

Only public addresses are fetched, redirects included: the links come from
third-party boards, and this runs on the web app's server.

    python3 -m scrapers.postings            # fetch what's missing for jobs.csv
"""

import argparse
import csv
import html
import ipaddress
import json
import re
import socket
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests

USER_AGENT = "Mozilla/5.0 (compatible; hireme.sk job board; +https://hireme.sk)"
TIMEOUT = 20
MAX_BYTES = 3_000_000
MAX_TEXT = 40_000
MAX_REDIRECTS = 5
# Shorter than this, a posting is taken as not read (a login wall, an empty
# JavaScript shell): fetched again after RETRY_DAYS.
MIN_TEXT = 500
RETRY_DAYS = 7

GOOGLE_DOC_RE = re.compile(r"^https://docs\.google\.com/document/d/([\w-]+)")
# Elements whose text isn't the posting.
SKIP_TAGS = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form", "template", "head"}
BLOCK_TAGS = {"p", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "div", "tr", "section", "article", "ul", "ol"}


class FetchError(Exception):
    pass


class _PageText(HTMLParser):
    """Readable text and JSON-LD blocks of an HTML page."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skipping = 0
        self.parts = []
        self.json_ld = []
        self.in_json_ld = False

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("type", "").strip() == "application/ld+json":
            self.in_json_ld = True
            self.json_ld.append("")
        if tag in SKIP_TAGS:
            self.skipping += 1
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_json_ld = False
        if tag in SKIP_TAGS and self.skipping:
            self.skipping -= 1
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.in_json_ld:
            self.json_ld[-1] += data
        elif not self.skipping:
            self.parts.append(data)


def tidy(text):
    """Spaces collapsed within lines, at most one blank line between them."""
    # ﻿: the byte order mark Google Docs' text export starts with.
    lines = (re.sub(r"[ \t\r\f\v\xa0﻿]+", " ", line).strip() for line in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _job_postings(blocks):
    """The schema.org JobPosting objects in JSON-LD blocks."""
    found = []

    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            kind = value.get("@type")
            if kind == "JobPosting" or (isinstance(kind, list) and "JobPosting" in kind):
                found.append(value)
            for item in value.values():
                if isinstance(item, (list, dict)):
                    walk(item)

    for block in blocks:
        try:
            walk(json.loads(block))
        except ValueError:
            pass
    return found


def html_to_text(page):
    """The text of an HTML page, or its JobPosting description if longer."""
    parser = _PageText()
    parser.feed(page)
    parser.close()
    text = tidy("".join(parser.parts))
    for posting in _job_postings(parser.json_ld):
        description = posting.get("description")
        if isinstance(description, str):
            # The description is itself HTML, often entity-escaped.
            inner = _PageText()
            inner.feed(html.unescape(description))
            inner.close()
            described = tidy("".join(inner.parts))
            if len(described) > len(text):
                text = described
    return text


def fetch_url(link):
    """The link's posting as a URL to fetch: a Google Doc as plain text."""
    match = GOOGLE_DOC_RE.match(link)
    if match:
        return f"https://docs.google.com/document/d/{match.group(1)}/export?format=txt"
    return link


def check_public(url):
    """FetchError unless url is http(s) to a host with only public addresses."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise FetchError(f"not an http(s) link: {url}")
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise FetchError(f"can't resolve {parsed.hostname}: {exc}") from None
    for info in infos:
        if not ipaddress.ip_address(info[4][0].split("%")[0]).is_global:
            raise FetchError(f"{parsed.hostname} is not a public address")


def get(url, session):
    """(status, content type, body text) for url, following redirects to
    public addresses only. Raises FetchError or requests.RequestException."""
    for _ in range(MAX_REDIRECTS + 1):
        check_public(url)
        response = session.get(url, timeout=TIMEOUT, allow_redirects=False, stream=True,
                               headers={"User-Agent": USER_AGENT})
        if response.is_redirect and response.headers.get("location"):
            url = urljoin(url, response.headers["location"])
            response.close()
            continue
        body = b""
        for chunk in response.iter_content(65536):
            body += chunk
            if len(body) > MAX_BYTES:
                break
        response.close()
        content_type = response.headers.get("content-type", "")
        # Without a charset, requests assumes ISO-8859-1 for text/*; pages
        # are almost always UTF-8 (or say so in a <meta>, which this ignores).
        encoding = response.encoding if "charset=" in content_type.lower() else "utf-8"
        try:
            text = body.decode(encoding or "utf-8", errors="replace")
        except LookupError:  # a charset Python doesn't know
            text = body.decode("utf-8", errors="replace")
        return response.status_code, content_type, text
    raise FetchError("too many redirects")


def fetch_posting(link, session, today):
    """The record kept for link: status (HTTP code, or the error) and text."""
    record = {"link": link, "fetched_at": today, "status": None, "text": ""}
    try:
        status, content_type, body = get(fetch_url(link), session)
    except (FetchError, requests.RequestException) as exc:
        record["status"] = f"{type(exc).__name__}: {exc}"[:200]
        return record
    record["status"] = status
    if status >= 400:
        return record
    if "html" in content_type or body.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        text = html_to_text(body)
    elif content_type.startswith("text/"):
        text = tidy(body)
    else:
        record["status"] = f"unsupported: {content_type.split(';')[0]}"
        return record
    record["text"] = text[:MAX_TEXT]
    return record


def load(postings_dir, job_id):
    try:
        return json.loads((Path(postings_dir) / f"{job_id}.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return None


def text_of(postings_dir, job_id):
    """The posting's text, or "" if it wasn't read."""
    record = load(postings_dir, job_id)
    text = (record or {}).get("text", "")
    return text if len(text) >= MIN_TEXT else ""


def _due(record, link, today):
    if record is None or record.get("link") != link:
        return True
    if len(record.get("text", "")) >= MIN_TEXT:
        return False
    fetched = date.fromisoformat(record.get("fetched_at", "2000-01-01"))
    return date.fromisoformat(today) - fetched >= timedelta(days=RETRY_DAYS)


def fetch_missing(jobs, postings_dir, today, workers=8, session=None):
    """Fetch the postings of jobs not fetched yet (and retry unread ones
    after RETRY_DAYS). Returns (fetched, of which read)."""
    postings_dir = Path(postings_dir)
    postings_dir.mkdir(parents=True, exist_ok=True)
    todo = [job for job in jobs if job.get("link") and _due(load(postings_dir, job["id"]), job["link"], today)]
    if not todo:
        return 0, 0
    session = session or requests.Session()
    read = 0

    def run(job):
        return job, fetch_posting(job["link"], session, today)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for job, record in pool.map(run, todo):
            path = postings_dir / f"{job['id']}.json"
            tmp = path.with_name(f".{path.name}.tmp")
            tmp.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
            tmp.replace(path)
            read += len(record["text"]) >= MIN_TEXT
    return len(todo), read


def main():
    parser = argparse.ArgumentParser(prog="python3 -m scrapers.postings", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--jobs", default="jobs.csv")
    parser.add_argument("--postings", default="data/postings")
    args = parser.parse_args()
    with open(args.jobs, newline="", encoding="utf-8") as f:
        jobs = list(csv.DictReader(f))
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    fetched, read = fetch_missing(jobs, args.postings, today)
    print(f"Postings fetched: {fetched}, read: {read}")


if __name__ == "__main__":
    sys.exit(main())
