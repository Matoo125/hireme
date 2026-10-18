"""Clean up values that differ between boards only in spelling.

Runs over every scraped job before deduplication (scrape_jobs.py), so the
cleaned values are also what duplicates are matched on:

  - Tags: each board capitalises its own way ("Full-time", "Full-Time",
    "Full Time"). Tags that are the same apart from case and punctuation
    become one spelling: sentence case - starting with a capital, then the
    fewest capitals, which keeps acronyms like "AI" - then the most used,
    then the first alphabetically, so the choice doesn't wander from day
    to day.
  - Organization names: a trailing acronym in brackets is dropped
    ("Centre for Effective Altruism (CEA)"), and names that are the same
    apart from case and punctuation ("FAR AI", "FAR.AI") become one:
    ORG_ALIASES if listed there, else the most used spelling.

Nothing else about a job is changed.
"""

import re
from collections import Counter, defaultdict

# Spellings to use where the automatic choice isn't the right one, by
# org_key() of the name.
ORG_ALIASES = {
    "farai": "FAR.AI",
}

# "Name (ABC)", "Name (80K)": an acronym in brackets at the end. It must
# have a letter, so a year like "(2026)" stays.
_TRAILING_ACRONYM_RE = re.compile(r"\s*\(([A-Z0-9][A-Z0-9&.\-]{1,11})\)\s*$")
_NON_ALNUM_RE = re.compile(r"[^\w]+")


def tag_key(tag):
    """'Full-Time', 'full time' and 'Full Time' all give 'full time'."""
    return _NON_ALNUM_RE.sub(" ", tag.lower()).strip()


def org_key(name):
    """'FAR AI' and 'FAR.AI' both give 'farai'."""
    return _NON_ALNUM_RE.sub("", name.lower())


def strip_trailing_acronym(name):
    match = _TRAILING_ACRONYM_RE.search(name)
    if not match or not re.search(r"[A-Z]", match.group(1)):
        return name.strip()
    return name[: match.start()].strip() or name.strip()


def _split_tags(value):
    return [t.strip() for t in (value or "").split(";") if t.strip()]


def _capitals(text):
    return sum(1 for c in text if c.isupper())


def canonical_tags(jobs):
    """{spelling: chosen spelling} for every tag spelling in jobs."""
    seen = defaultdict(Counter)
    for job in jobs:
        for tag in _split_tags(job.get("tags")):
            seen[tag_key(tag)][tag] += 1
    chosen = {}
    for spellings in seen.values():
        best = min(spellings, key=lambda s: (not s[:1].isupper(), _capitals(s), -spellings[s], s))
        for spelling in spellings:
            chosen[spelling] = best
    return chosen


def canonical_orgs(jobs):
    """{name as scraped: chosen name} for every organization name in jobs."""
    seen = defaultdict(Counter)
    for job in jobs:
        name = (job.get("organization_name") or "").strip()
        if name:
            seen[org_key(strip_trailing_acronym(name))][name] += 1
    chosen = {}
    for key, spellings in seen.items():
        stripped = Counter()
        for name, n in spellings.items():
            stripped[strip_trailing_acronym(name)] += n
        best = ORG_ALIASES.get(key) or min(stripped, key=lambda s: (-stripped[s], s))
        for name in spellings:
            chosen[name] = best
    return chosen


def normalize_jobs(jobs):
    """Return copies of jobs with tags and organization names cleaned up,
    plus a summary of what changed for the scrape log."""
    tag_map = canonical_tags(jobs)
    org_map = canonical_orgs(jobs)
    out = []
    for job in jobs:
        job = dict(job)
        tags = []
        for tag in _split_tags(job.get("tags")):
            tag = tag_map.get(tag, tag)
            if tag not in tags:
                tags.append(tag)
        job["tags"] = "; ".join(tags)
        name = (job.get("organization_name") or "").strip()
        if name:
            job["organization_name"] = org_map.get(name, name)
        out.append(job)
    summary = {
        "tag_spellings_merged": sum(1 for a, b in tag_map.items() if a != b),
        "tags": len(set(tag_map.values())),
        "org_names_changed": sum(1 for a, b in org_map.items() if a != b),
    }
    return out, summary
