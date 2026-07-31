"""Scraper for the Animal Advocacy Careers job board
(animaladvocacycareers.org/job-board/).

This is a WordPress site running WP Job Manager, which exposes a full
public REST API for the `job_listing` post type (rest_base
`job-listings`) plus its taxonomies - no HTML scraping or hidden API
needed. "Remote, Global" on this site is the *combination* of the
`job_remote` taxonomy term "Remote" and the `job_listing_location` term
"Worldwide" (the site's own filter form applies both facets together).

Note: WP Job Manager's "company website" meta field is repurposed by
this board to hold the actual application URL (often a direct ATS
posting, not the org's homepage), so we use it as `link`.
"""

import html
import re

import requests

from .common import dedup_join, strip_html, to_iso_date

SOURCE_NAME = "Animal Advocacy Careers"

BASE_URL = "https://animaladvocacycareers.org/wp-json/wp/v2"

TAG_TAXONOMIES = [
    "job-types",
    "job_filter",
    "job_function",
    "organisation_type",
    "language_requirements",
    "job_remote",
    "job_listing_location",
]


def _fetch_terms(taxonomy_rest_base):
    """Return {term_id: term_name} for every term in a taxonomy."""
    terms = {}
    page = 1
    while True:
        resp = requests.get(
            f"{BASE_URL}/{taxonomy_rest_base}",
            params={"per_page": 100, "page": page},
            timeout=30,
        )
        if resp.status_code == 400:  # past the last page
            break
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        for term in batch:
            terms[term["id"]] = html.unescape(term["name"])
        page += 1
    return terms


def _find_term_id(terms_by_name, name):
    for term_id, term_name in terms_by_name.items():
        if term_name == name:
            return term_id
    raise ValueError(f"Could not find term {name!r}")


def _fetch_all_job_listings(params):
    session = requests.Session()
    jobs = []
    page = 1
    while True:
        resp = session.get(
            f"{BASE_URL}/job-listings",
            params={**params, "per_page": 100, "page": page},
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json()
        jobs.extend(batch)
        total_pages = int(resp.headers.get("X-WP-TotalPages", "1"))
        if page >= total_pages:
            break
        page += 1
    return jobs


def _collect_tags(job, term_maps):
    values = []
    for taxonomy in TAG_TAXONOMIES:
        term_map = term_maps.get(taxonomy, {})
        for term_id in job.get(taxonomy) or []:
            name = term_map.get(term_id)
            if name:
                values.append(name)
    return dedup_join(values)


def _job_to_row(job, term_maps):
    meta = job.get("meta") or {}
    return {
        "source": SOURCE_NAME,
        "title": html.unescape(job.get("title", {}).get("rendered", "")),
        "link": meta.get("_company_website") or job.get("link", ""),
        "publication_date": to_iso_date(job.get("date")),
        "close_date": to_iso_date(meta.get("_job_expires")),
        "organization_name": meta.get("_company_name", ""),
        "organization_url": "",
        "organization_description": strip_html(meta.get("_company_tagline", "")),
        "description": strip_html(job.get("content", {}).get("rendered", "")),
        "salary_range": meta.get("_job_salary", ""),
        "tags": _collect_tags(job, term_maps),
    }


def fetch_jobs(remote_term="Remote", location_term="Worldwide"):
    term_maps = {taxonomy: _fetch_terms(taxonomy) for taxonomy in TAG_TAXONOMIES}

    remote_id = _find_term_id(term_maps["job_remote"], remote_term)
    location_id = _find_term_id(term_maps["job_listing_location"], location_term)

    jobs = _fetch_all_job_listings(
        {"job_remote": remote_id, "job_listing_location": location_id}
    )
    return [_job_to_row(job, term_maps) for job in jobs]
