"""Shared helpers used by the individual job-board scrapers."""

import html
import re
import time
from datetime import datetime, timezone

import requests

HTML_TAG_RE = re.compile(r"<[^>]+>")

# Common CSV/output schema every scraper module must produce per job.
# Note: "id" is added later by scrapers.dedupe (it's derived from the
# post-merge record, not something individual board scrapers set).
FIELDNAMES = [
    "id",
    "source",
    "title",
    "link",
    "publication_date",
    "close_date",
    "organization_name",
    "organization_url",
    "organization_description",
    "description",
    "salary_range",
    "tags",
]


def strip_html(text):
    if not text:
        return ""
    text = HTML_TAG_RE.sub(" ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def to_iso_date(value):
    """Normalize a unix timestamp or ISO datetime string down to YYYY-MM-DD."""
    if value is None or value == "":
        return ""
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc).strftime("%Y-%m-%d")
    return str(value)[:10]


def fetch_algolia_hits(app_id, api_key, index, facet_filters, hits_per_page=100, extra_params=None):
    """Page through every hit in an Algolia index matching the given facetFilters."""
    session = requests.Session()
    headers = {
        "X-Algolia-API-Key": api_key,
        "X-Algolia-Application-Id": app_id,
        "Content-Type": "application/json",
    }
    url = f"https://{app_id}-dsn.algolia.net/1/indexes/{index}/query"
    hits = []
    page = 0
    while True:
        payload = {
            "query": "",
            "page": page,
            "hitsPerPage": hits_per_page,
            "facetFilters": facet_filters,
            **(extra_params or {}),
        }
        resp = session.post(url, json=payload, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        hits.extend(data.get("hits", []))
        nb_pages = data.get("nbPages", 0)
        page += 1
        if page >= nb_pages:
            break
        time.sleep(0.2)
    return hits


def dedup_join(values):
    seen = []
    for v in values:
        if v and v not in seen:
            seen.append(v)
    return "; ".join(seen)
