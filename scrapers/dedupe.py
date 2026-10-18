"""Cross-board duplicate detection.

The same role is frequently cross-posted to multiple job boards. We
treat two listings as the same job if either:

  1. their application links point to the same place (after stripping
     query strings/UTM params, scheme, and trailing slashes), or
  2. they come from different boards and have the same organization
     name and job title (both normalized; names are already cleaned up
     by scrapers.normalize), which catches each board linking to its
     own copy: an ATS page vs the org's careers page, a tracking
     redirect, a locale in the path. Two listings on the *same* board
     with the same title are kept apart: the board lists them as
     separate jobs (e.g. one role in two locations, at two salaries).

Matches chain: if A matches B and B matches C, all three are one job.
Duplicates are merged into a single row: fields are filled in from
whichever source has them (first-seen wins per field), tags are
unioned, and a `sources` column records every board the job was found
on. The merged row keeps the first-seen listing's id (see stable_id).
"""

import hashlib
import re
from urllib.parse import urlsplit

_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^\w\s]")


def normalize_url(url):
    if not url:
        return ""
    parts = urlsplit(url.strip())
    path = parts.path.rstrip("/")
    return f"{parts.netloc.lower()}{path}"


def normalize_text(text):
    if not text:
        return ""
    text = text.lower()
    text = _PUNCT_RE.sub("", text)
    return _WS_RE.sub(" ", text).strip()


def _dedup_key(job):
    url_key = normalize_url(job.get("link", ""))
    if url_key:
        return ("url", url_key)
    return (
        "org_title",
        normalize_text(job.get("organization_name", "")),
        normalize_text(job.get("title", "")),
    )


def stable_id(job):
    """A short id derived from the same identity key used for deduping,
    so it stays consistent across re-scrapes for as long as a job's
    link (or org+title) doesn't change - which is what lets the
    frontend remember likes/hides in localStorage between runs."""
    key = _dedup_key(job)
    digest = hashlib.md5("|".join(key).encode("utf-8")).hexdigest()
    return digest[:12]


def _merge_tag_strings(tag_strings):
    tags = []
    for s in tag_strings:
        for tag in (s or "").split(";"):
            tag = tag.strip()
            if tag and tag not in tags:
                tags.append(tag)
    return "; ".join(tags)


def _duplicate_groups(jobs):
    """Indices of jobs grouped into duplicates, each group in scrape order,
    groups ordered by their first job."""
    parent = list(range(len(jobs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        a, b = find(i), find(j)
        if a != b:
            # The earlier job stays the root, so a group's first job is its root.
            parent[max(a, b)] = min(a, b)

    by_url = {}
    by_org_title = {}
    for i, job in enumerate(jobs):
        url = normalize_url(job.get("link", ""))
        if url:
            union(i, by_url.setdefault(url, i))
        org = normalize_text(job.get("organization_name", ""))
        title = normalize_text(job.get("title", ""))
        if org and title:
            by_org_title.setdefault((org, title), []).append(i)

    for indices in by_org_title.values():
        for i in indices:
            for j in indices:
                if j >= i:
                    break
                if jobs[i]["source"] != jobs[j]["source"]:
                    union(i, j)
                    break

    groups = {}
    for i in range(len(jobs)):
        groups.setdefault(find(i), []).append(i)
    return [groups[root] for root in sorted(groups)]


def merge_duplicates(jobs):
    merged = []
    for indices in _duplicate_groups(jobs):
        duplicates = [jobs[i] for i in indices]
        primary = dict(duplicates[0])
        for field in (
            "title",
            "link",
            "publication_date",
            "close_date",
            "organization_name",
            "organization_url",
            "organization_description",
            "description",
            "salary_range",
        ):
            if not primary.get(field):
                for dup in duplicates[1:]:
                    if dup.get(field):
                        primary[field] = dup[field]
                        break
        primary["tags"] = _merge_tag_strings(d.get("tags", "") for d in duplicates)
        sources = []
        for dup in duplicates:
            if dup["source"] not in sources:
                sources.append(dup["source"])
        primary["source"] = "; ".join(sources)
        primary["id"] = stable_id(primary)
        merged.append(primary)
    return merged
