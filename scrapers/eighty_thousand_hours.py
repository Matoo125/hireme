"""Scraper for the 80,000 Hours job board (jobs.80000hours.org).

Backed by Algolia; there are no per-job detail pages on the site itself
(confirmed via sitemap.xml), so `link` is the external application URL.
"""

from .common import dedup_join, fetch_algolia_hits, strip_html, to_iso_date

SOURCE_NAME = "80,000 Hours"

ALGOLIA_APP_ID = "W6KM1UDIB3"
ALGOLIA_API_KEY = "d1d7f2c8696e7b36837d5ed337c4a319"  # public search-only key used by the site's own frontend
ALGOLIA_INDEX = "jobs_prod"

TAG_FIELDS = [
    "tags_area",
    "tags_role_type",
    "tags_skill",
    "tags_degree_required",
    "tags_exp_required",
    "tags_location_80k",
    "tags_location_type",
    "tags_generic",
    "tags_workload",
    "tags_immigration",
]


def _collect_tags(hit):
    values = []
    for field in TAG_FIELDS:
        values.extend(hit.get(field) or [])
    return dedup_join(values)


def _hit_to_job(hit):
    company = hit.get("company") or {}
    description = hit.get("description") or hit.get("description_short") or ""
    return {
        "source": SOURCE_NAME,
        "title": hit.get("title", ""),
        "link": hit.get("url_external", ""),
        "publication_date": to_iso_date(hit.get("posted_at")),
        "close_date": to_iso_date(hit.get("closes_at")),
        "organization_name": hit.get("company_name") or company.get("name", ""),
        "organization_url": hit.get("company_url") or company.get("url", ""),
        "organization_description": strip_html(
            hit.get("company_description") or company.get("description", "")
        ),
        "description": strip_html(description),
        "salary_range": hit.get("salary", ""),
        "tags": _collect_tags(hit),
    }


def fetch_jobs(location_filter="Remote, Global"):
    hits = fetch_algolia_hits(
        ALGOLIA_APP_ID,
        ALGOLIA_API_KEY,
        ALGOLIA_INDEX,
        facet_filters=[[f"tags_location_80k:{location_filter}"]],
    )
    return [_hit_to_job(h) for h in hits]
