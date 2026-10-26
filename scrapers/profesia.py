"""Scraper for Profesia (www.profesia.sk), the largest Slovak job board.

Profesia lists ~14,000 offers, mostly on-site; only the ones it marks as
work from home only ("Práca iba z domu", the `remote_work=1` filter, a few
hundred) are taken. It has no API or feed, so this reads its HTML:

  - The list pages (/praca/?remote_work=1&page_num=N, 20 offers each) give
    the title, employer, location label and salary label of each offer.
  - Each offer's own page gives the date posted (schema.org microdata), a
    summary of the posting (its og:description, ~1,000 characters), the
    contract type and, on Profesia's standard layout, the employer's
    description. Employers with their own page design leave the latter out
    and state the contract type as text ("Contract type", "Druh pracovného
    pomeru"), which is read instead.

Offers come in Slovak, Czech, English or German; salary labels are rewritten
into the English the other boards use ("Od 2 250 EUR/mesiac" -> "From 2,250
EUR per month") so scrapers.salary reads them, and contract types into the
job type tags of scrapers.tag_fields.

Not in scrape_jobs.SCRAPERS: on its first daily run (26 Oct 2026), after ~160
requests in two minutes, Profesia's AWS firewall started answering the
server with a challenge (HTTP 202, empty body) for its whole site. Until
Profesia allows it, this runs by hand only.
"""

import html
import re
from concurrent.futures import ThreadPoolExecutor

import requests

from .common import dedup_join, strip_html

SOURCE_NAME = "Profesia"

BASE_URL = "https://www.profesia.sk"
USER_AGENT = "Mozilla/5.0 (compatible; hireme.sk job board; +https://hireme.sk)"
MAX_PAGES = 50
WORKERS = 4

_ROW_RE = re.compile(r'<li class="list-row"[^>]*>(.*?)</li>', re.S)
_OFFER_LINK_RE = re.compile(r'id="offer(\d+)"\s+href="([^"?]+)')

# Contract types as Profesia words them, in each language it's posted in.
JOB_TYPES = {
    "full-time": "Full-time",
    "plný úväzok": "Full-time",
    "plný úvazek": "Full-time",
    "vollzeitbeschäftigung": "Full-time",
    "part-time": "Part-time",
    "skrátený úväzok": "Part-time",
    "zkrácený úvazek": "Part-time",
    "teilzeitbeschäftigung": "Part-time",
    "živnosť": "Contractor",
    "živnost": "Contractor",
    "trade licence": "Contractor",
    "na dohodu (brigády)": "Temporary",
    "agreement-based (temporary jobs)": "Temporary",
    "internship": "Internship",
    "stáž": "Internship",
}
_CONTRACT_LABEL_RE = re.compile(r"(?:Contract type|Druh pracovného pomeru|Druh pracovního poměru)\s*\n\s*([^\n]+)")


def _text(fragment):
    return strip_html(html.unescape(fragment or ""))


def _field(row, css_class):
    match = re.search(rf"class='{css_class}'[^>]*>(.*?)</span>", row, re.S)
    return _text(match.group(1)) if match else ""


def parse_list(page):
    """The offers on one list page, in order."""
    offers = []
    for row in _ROW_RE.findall(html.unescape(page)):
        link = _OFFER_LINK_RE.search(row)
        if not link:
            continue
        salary = re.search(r"class='icon money[^']*'.*?</svg>\s*([^<]+)", row, re.S)
        offers.append({
            "id": link.group(1),
            "link": BASE_URL + link.group(2),
            "title": _field(row, "title"),
            "organization_name": _field(row, "employer"),
            "location": _field(row, "job-location"),
            "salary_range": salary_text(salary.group(1)) if salary else "",
        })
    return offers


def salary_text(label):
    """A Profesia salary label in the other boards' English."""
    text = " ".join(html.unescape(label).split())
    text = re.sub(r"(\d),(\d{1,2})\b", r"\1.\2", text)  # 9,9 EUR: a decimal comma
    text = re.sub(r"(?<=\d) (?=\d{3}\b)", ",", text)  # 2 250: a thousands space
    text = re.sub(r"^Od\b", "From", text)
    text = re.sub(r"^Do\b", "Up to", text)
    text = text.replace("Kč", "CZK")
    text = re.sub(r"\s*/\s*mesiac\b", " per month", text)
    text = re.sub(r"\s*/\s*hod\b\.?", " per hour", text)
    text = re.sub(r"\s*/\s*rok\b", " per year", text)
    return text


def job_types(contract):
    """Job type tags for a contract type text ("plný úväzok, živnosť")."""
    tags = []
    for part in contract.split(","):
        part = part.strip()
        if part:
            tags.append(JOB_TYPES.get(part.lower(), part))
    return tags


def parse_offer(page):
    """What an offer's own page adds to its list entry."""
    posted = re.search(r'itemprop="datePosted"[^>]*>\s*(\d{4}-\d{2}-\d{2})', page)
    summary = re.search(r'<meta property="og:description" content="([^"]*)"', page)
    contract = re.search(r'itemprop="employmentType"[^>]*>([^<]*)<', page)
    if contract:
        contract = _text(contract.group(1))
    else:
        text = html.unescape(re.sub(r"<[^>]+>", "\n", page))
        label = _CONTRACT_LABEL_RE.search(text)
        contract = label.group(1).strip() if label else ""
    about = re.search(r"company-info details-section'>.*?<div class='details-desc'>(.*?)</div>", page, re.S)
    return {
        "publication_date": posted.group(1) if posted else "",
        "description": _text(summary.group(1)) if summary else "",
        "organization_description": _text(about.group(1)) if about else "",
        "job_types": job_types(contract),
    }


def _get(session, url, **params):
    resp = session.get(url, params=params, headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    return resp.text


def _row(offer, details):
    return {
        "source": SOURCE_NAME,
        "title": offer["title"],
        "link": offer["link"],
        "publication_date": details.get("publication_date", ""),
        "close_date": "",
        "organization_name": offer["organization_name"],
        "organization_url": "",
        "organization_description": details.get("organization_description", ""),
        "description": details.get("description", ""),
        "salary_range": offer["salary_range"],
        "tags": dedup_join(["Remote", *details.get("job_types", [])]),
    }


def fetch_jobs(session=None):
    session = session or requests.Session()
    offers = {}
    for page_num in range(1, MAX_PAGES + 1):
        found = parse_list(_get(session, f"{BASE_URL}/praca/", remote_work=1, page_num=page_num))
        new = [o for o in found if o["id"] not in offers]
        if not new:
            break
        offers.update((o["id"], o) for o in new)

    def details(offer):
        # An offer whose page doesn't load still has its list entry.
        try:
            return parse_offer(_get(session, offer["link"]))
        except requests.RequestException:
            return {}

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        return [_row(o, d) for o, d in zip(offers.values(), pool.map(details, offers.values()))]
