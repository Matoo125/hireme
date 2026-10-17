"""Scraper for the EA Opportunities Board (effectivealtruism.org/opportunities).

This page is server-rendered by Next.js (App Router) with the *entire*
opportunities dataset (all ~900+ postings, every location) embedded in
the initial HTML, inside the React Server Components "flight" payload
(`self.__next_f.push(...)` script chunks). The `locationFilter` query
string only drives client-side filtering after hydration - the server
always ships everything - so we fetch the page once and filter in Python
instead of needing an API. (Until 2026-10 the site used the Pages Router
and shipped the same data as `__NEXT_DATA__` JSON.) The board also lists
non-job opportunities (fellowships, internships, volunteering, funding,
events, courses...); we keep only job-shaped listings.
"""

import json
import re

import requests

from .common import dedup_join, strip_html, to_iso_date

SOURCE_NAME = "EA Opportunities Board"

PAGE_URL = "https://www.effectivealtruism.org/opportunities"

JOB_TYPES = {"Full-time", "Part-time", "Contract"}

FLIGHT_CHUNK_RE = re.compile(r"self\.__next_f\.push\((\[.*?\])\)</script>", re.S)

OPPORTUNITIES_RE = re.compile(r'"opportunities":(?=\[\{"id":)')


def _flight_payload(page_html):
    """Concatenate the RSC flight payload from the page's script chunks."""
    parts = []
    for chunk in FLIGHT_CHUNK_RE.findall(page_html):
        entry = json.loads(chunk)
        if len(entry) > 1 and isinstance(entry[1], str):
            parts.append(entry[1])
    return "".join(parts)


def _text_rows(flight):
    """Map row id -> text for the payload's text rows (`<id>:T<hex byte len>,<text>`).

    Rows are newline-terminated, except text rows, which are length-prefixed (in UTF-8
    bytes) and followed directly by the next row - so the payload has to be walked row
    by row rather than split on newlines.
    """
    data = flight.encode("utf-8")
    rows = {}
    pos = 0
    while pos < len(data):
        colon = data.find(b":", pos)
        if colon == -1:
            break
        row_id = data[pos:colon].decode()
        if data[colon + 1 : colon + 2] == b"T":
            comma = data.index(b",", colon)
            start = comma + 1
            end = start + int(data[colon + 2 : comma], 16)
            rows[row_id] = data[start:end].decode("utf-8", errors="replace")
            pos = end
        else:
            newline = data.find(b"\n", colon)
            pos = len(data) if newline == -1 else newline + 1
    return rows


def _decode_value(value, text_rows):
    """Undo RSC string encoding: `$$` escapes a literal leading `$`, `$<hex>` points at a
    text row (used for long descriptions), and other `$`-prefixed values (`$undefined`,
    ...) carry no data for us."""
    if not isinstance(value, str) or not value.startswith("$"):
        return value
    if value.startswith("$$"):
        return value[1:]
    if re.fullmatch(r"\$[0-9a-f]+", value):
        return text_rows.get(value[1:], "")
    return None


def _fetch_opportunities():
    resp = requests.get(PAGE_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    resp.raise_for_status()
    flight = _flight_payload(resp.text)
    match = OPPORTUNITIES_RE.search(flight)
    if not match:
        raise RuntimeError("opportunities list not found in page payload - page format changed?")
    opportunities, _ = json.JSONDecoder().raw_decode(flight, match.end())
    text_rows = _text_rows(flight)
    return [{k: _decode_value(v, text_rows) for k, v in opp.items()} for opp in opportunities]


def _format_salary(opp):
    if opp.get("salaryOriginal"):
        return opp["salaryOriginal"]
    if opp.get("salary"):
        return f"${opp['salary']:,.0f}"
    return ""

def _collect_tags(opp):
    values = []
    values.extend(opp.get("opportunityTypes") or [])
    values.extend(opp.get("causeAreas") or [])
    values.extend(opp.get("skillSet") or [])
    values.extend(opp.get("routesToImpact") or [])
    values.extend(opp.get("education") or [])
    return dedup_join(values)


def _opp_to_job(opp):
    orgs = opp.get("organizations") or []
    return {
        "source": SOURCE_NAME,
        "title": opp.get("title", ""),
        "link": opp.get("applicationLink", ""),
        "publication_date": to_iso_date(opp.get("createdAt")),
        "close_date": to_iso_date(opp.get("applicationDeadline")),
        "organization_name": dedup_join([o.get("name", "") for o in orgs]),
        "organization_url": ((orgs[0].get("link") or "").strip() if orgs else ""),
        "organization_description": "",
        "description": strip_html(opp.get("description", "")),
        "salary_range": _format_salary(opp),
        "tags": _collect_tags(opp),
    }


def fetch_jobs(location="Remote"):
    opportunities = _fetch_opportunities()
    jobs = []
    for opp in opportunities:
        if location not in (opp.get("locationFilter") or []):
            continue
        if not JOB_TYPES & set(opp.get("opportunityTypes") or []):
            continue
        jobs.append(_opp_to_job(opp))
    return jobs
