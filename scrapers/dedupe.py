"""Cross-board duplicate detection.

The same role is frequently cross-posted to multiple job boards. We
treat two listings as the same job if either:

  1. their application links point to the same place (after stripping
     query strings/UTM params, scheme, and trailing slashes), or
  2. they have the same organization name and the same job title
     (both normalized), which catches cases where each board wraps the
     link in its own tracking redirect.

Duplicates are merged into a single row: fields are filled in from
whichever source has them (first-seen wins per field), tags are
unioned, and a `sources` column records every board the job was found
on.
"""

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


def _merge_tag_strings(tag_strings):
    tags = []
    for s in tag_strings:
        for tag in (s or "").split(";"):
            tag = tag.strip()
            if tag and tag not in tags:
                tags.append(tag)
    return "; ".join(tags)


def merge_duplicates(jobs):
    groups = {}
    order = []
    for job in jobs:
        key = _dedup_key(job)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(job)

    merged = []
    for key in order:
        duplicates = groups[key]
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
        merged.append(primary)
    return merged
