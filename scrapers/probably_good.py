"""Scraper for the Probably Good job board (jobs.probablygood.org).

The site is a client-rendered SPA (Neuronhub platform) backed by both a
locked-down persisted-query GraphQL API and Algolia for job search. The
Algolia app id/api key aren't baked into the JS bundle - they're fetched
at runtime via a GraphQL query named "AlgoliaSearchKey". That query text
is on the platform's server-side safelist (verified: the safelist checks
by query content, not just a precomputed hash), so we can call it
directly to obtain a short-lived-looking but currently valid search key,
then query Algolia's jobs_prod index the same way the frontend does.
"""

from .common import dedup_join, fetch_algolia_hits, strip_html, to_iso_date

import requests

SOURCE_NAME = "Probably Good"

GRAPHQL_URL = "https://backend.jobs.probablygood.org/api/graphql"

ALGOLIA_SEARCH_KEY_QUERY = """
    query AlgoliaSearchKey {
      algolia_search_key {
        api_key
        app_id
        index_name
        index_name_sorted_by_votes
        index_name_profiles
        index_name_jobs
        index_name_jobs_sorted_by_closes_at
      }
    }
  """

TAG_FIELDS = [
    "tags_area",
    "tags_skill",
    "tags_education",
    "tags_experience",
    "tags_workload",
]


def _fetch_algolia_credentials():
    resp = requests.post(
        GRAPHQL_URL,
        json={"operationName": "AlgoliaSearchKey", "query": ALGOLIA_SEARCH_KEY_QUERY},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    key = data["data"]["algolia_search_key"]
    return key["app_id"], key["api_key"], key["index_name_jobs"]


def _collect_tags(hit):
    values = []
    for field in TAG_FIELDS:
        values.extend(tag.get("name", "") for tag in hit.get(field) or [])
    return dedup_join(values)


def _hit_to_job(hit):
    org = hit.get("org") or {}
    return {
        "source": SOURCE_NAME,
        "title": hit.get("title", ""),
        "link": hit.get("url_external", ""),
        "publication_date": to_iso_date(hit.get("published_at")),
        "close_date": to_iso_date(hit.get("closes_at")),
        "organization_name": org.get("name", ""),
        "organization_url": org.get("website", ""),
        "organization_description": strip_html(org.get("description", "")),
        "description": strip_html(hit.get("description", "")),
        "salary_range": hit.get("salary_text", ""),
        "tags": _collect_tags(hit),
    }


def fetch_jobs(location_filter="[remote] Remote, Global"):
    app_id, api_key, index_name = _fetch_algolia_credentials()
    hits = fetch_algolia_hits(
        app_id,
        api_key,
        index_name,
        facet_filters=[[f"locations.algolia_filter_name:{location_filter}"]],
    )
    return [_hit_to_job(h) for h in hits]
