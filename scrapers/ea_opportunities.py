"""Scraper for the EA Opportunities Board (effectivealtruism.org/opportunities).

This page is server-rendered by Next.js with the *entire* opportunities
dataset (all ~900+ postings, every location) embedded in the initial
HTML as JSON (`__NEXT_DATA__`). The `locationFilter` query string only
drives client-side filtering after hydration - the server always ships
everything - so we fetch the page once and filter in Python instead of
needing an API. The board also lists non-job opportunities (fellowships,
internships, volunteering, funding, events, courses...); we keep only
job-shaped listings.
"""

import re

import requests

from .common import dedup_join, strip_html, to_iso_date

SOURCE_NAME = "EA Opportunities Board"

PAGE_URL = "https://www.effectivealtruism.org/opportunities"

JOB_TYPES = {"Full-time", "Part-time", "Contract"}

NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S
)


def _fetch_opportunities():
    import json

    resp = requests.get(PAGE_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    resp.raise_for_status()
    match = NEXT_DATA_RE.search(resp.text)
    data = json.loads(match.group(1))
    return data["props"]["pageProps"]["opportunities"]


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
