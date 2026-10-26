"""Tests for scrapers.profesia, on trimmed copies of its pages (Oct 2026). Run: python3 -m unittest"""

import unittest

import requests

from scrapers import profesia
from scrapers.common import FIELDNAMES
from scrapers.salary import parse_salary


def row(offer_id, title, employer, salary=None):
    money = (f"""<span class='label-group'><a href="/praca/x/O{offer_id}?search_id=1">
    <span class="label label-bordered green half-margin-on-top">
        <svg   class='icon money green' viewbox="0 0 20 20"><use xlink:href='/images/svg/money.svg#Layer_1'></use></svg>
        {salary}
    </span></a></span>""" if salary else "")
    return (f"""<li class="list-row" ><h2><a  id="offer{offer_id}" href="&#x2F;praca&#x2F;acme&#x2F;O{offer_id}&#x3F;search_id&#x3D;7c">"""
            f"""<span class='title'>{title}</span></a></h2><span class='employer'>{employer}</span>"""
            f"""<span title="Remote work" class='job-location'>Remote work</span>{money}"""
            """<div class='list-footer'><span class='info'><strong>Pred 2 hodinami</strong></span></div> </li>""")


def list_page(*rows):
    return f"<html><body><ul>{''.join(rows)}</ul></body></html>"


STANDARD_OFFER = """<html><head>
<meta property="og:description" content="This&#x20;role&#x20;works&#x20;closely&#x20;with&#x20;global&#x20;sourcing..." />
</head><body>
<span itemprop="employmentType">plný úväzok, živnosť</span>
<div class='job-info details-section'><div class='subtitle-line'><h3>Information about the position</h3></div>
<h4>Job description</h4><div class='details-desc'><p>Long text.</p></div></div>
<div class='company-info details-section'><div class='subtitle-line'><h3>Advertiser</h3></div>
<h4>Brief description of the company</h4><div class='details-desc'>Marel <b>makes</b> machines.</div>
<h4>Number of employees</h4><div class='details-desc'>250-499 employees</div></div>
<span class="hidden" itemprop="datePosted">2026-10-26</span>
</body></html>"""

# An employer's own page design: no microdata contract type, no company section.
CUSTOM_OFFER = """<html><head>
<meta property="og:description" content="Support the ERP strategy" />
</head><body>
<div class="detail"><h4>Place of work</h4><p>Remote work</p>
<h4>Contract type</h4>
<p>full-time, part-time</p></div>
<span class="hidden" itemprop="datePosted">2026-10-20</span>
</body></html>"""


class ParseList(unittest.TestCase):
    def test_rows(self):
        page = list_page(row(5380709, "BI Specialist &amp; Analyst", "Marel Slovakia s.r.o.", "Od 2&nbsp;250 EUR/mesiac"),
                         row(5380466, "Recepčná", "Progress Agency"))
        self.assertEqual(profesia.parse_list(page), [
            {"id": "5380709", "link": "https://www.profesia.sk/praca/acme/O5380709", "title": "BI Specialist & Analyst",
             "organization_name": "Marel Slovakia s.r.o.", "location": "Remote work",
             "salary_range": "From 2,250 EUR per month"},
            {"id": "5380466", "link": "https://www.profesia.sk/praca/acme/O5380466", "title": "Recepčná",
             "organization_name": "Progress Agency", "location": "Remote work", "salary_range": ""},
        ])

    def test_page_past_the_last(self):
        self.assertEqual(profesia.parse_list(list_page()), [])


class SalaryText(unittest.TestCase):
    def test_labels_read_as_the_other_boards(self):
        cases = {
            "Od 2 250 EUR/mesiac": ("From 2,250 EUR per month", ("2250", "", "EUR", "month")),
            "1 500 - 2 000 EUR/mesiac": ("1,500 - 2,000 EUR per month", ("1500", "2000", "EUR", "month")),
            "Od 9,9 EUR/hod.": ("From 9.9 EUR per hour", ("9.9", "", "EUR", "hour")),
            "150 000 - 200 000 Kč/mesiac": ("150,000 - 200,000 CZK per month", ("150000", "200000", "CZK", "month")),
            "350 Kč/hod.": ("350 CZK per hour", ("350", "350", "CZK", "hour")),
        }
        for label, (text, numbers) in cases.items():
            with self.subTest(label):
                self.assertEqual(profesia.salary_text(label), text)
                p = parse_salary(text)
                self.assertEqual((p["salary_min"], p["salary_max"], p["salary_currency"], p["salary_period"]), numbers)


class ParseOffer(unittest.TestCase):
    def test_standard_layout(self):
        self.assertEqual(profesia.parse_offer(STANDARD_OFFER), {
            "publication_date": "2026-10-26",
            "description": "This role works closely with global sourcing...",
            "organization_description": "Marel makes machines.",
            "job_types": ["Full-time", "Contractor"],
        })

    def test_employer_designed_page(self):
        details = profesia.parse_offer(CUSTOM_OFFER)
        self.assertEqual(details["job_types"], ["Full-time", "Part-time"])
        self.assertEqual((details["publication_date"], details["organization_description"]), ("2026-10-20", ""))

    def test_job_types(self):
        self.assertEqual(profesia.job_types("skrátený úväzok, na dohodu (brigády), internship, stáž"),
                         ["Part-time", "Temporary", "Internship", "Internship"])
        self.assertEqual(profesia.job_types("Heimarbeit"), ["Heimarbeit"])
        self.assertEqual(profesia.job_types(""), [])


class FakeSession:
    """Serves list pages by page_num and offer pages by link; links in
    `broken` raise like a timeout."""

    def __init__(self, pages, offers, broken=()):
        self.pages, self.offers, self.broken = pages, offers, set(broken)
        self.urls = []

    def get(self, url, params=None, **kwargs):
        self.urls.append((url, params))
        if url in self.broken:
            raise requests.ConnectionError("timed out")
        text = self.pages.get(params["page_num"], list_page()) if params else self.offers[url]
        response = requests.Response()
        response.status_code, response._content, response.encoding = 200, text.encode(), "utf-8"
        return response


class FetchJobs(unittest.TestCase):
    def test_pages_until_no_new_offers_and_keeps_failed_offers(self):
        first = list_page(row(1, "Analyst", "Acme", "Od 2 000 EUR/mesiac"), row(2, "Writer", "Acme"))
        session = FakeSession(
            # Page 3 repeats page 2, as Profesia does past the last page.
            pages={1: first, 2: list_page(row(3, "Designer", "Beta")), 3: list_page(row(3, "Designer", "Beta"))},
            offers={"https://www.profesia.sk/praca/acme/O1": STANDARD_OFFER,
                    "https://www.profesia.sk/praca/acme/O3": CUSTOM_OFFER},
            broken={"https://www.profesia.sk/praca/acme/O2"})
        jobs = profesia.fetch_jobs(session)
        self.assertEqual([j["title"] for j in jobs], ["Analyst", "Writer", "Designer"])
        self.assertEqual([p["page_num"] for _, p in session.urls if p], [1, 2, 3])
        analyst, writer, designer = jobs
        self.assertEqual(analyst["source"], "Profesia")
        self.assertEqual(analyst["tags"], "Remote; Full-time; Contractor")
        self.assertEqual(analyst["salary_range"], "From 2,000 EUR per month")
        self.assertEqual(analyst["publication_date"], "2026-10-26")
        self.assertEqual((writer["tags"], writer["description"]), ("Remote", ""))
        self.assertEqual(designer["tags"], "Remote; Full-time; Part-time")
        scraped = FIELDNAMES[:FIELDNAMES.index("tags") + 1]
        self.assertEqual(set(analyst), set(scraped) - {"id", "first_seen"})


if __name__ == "__main__":
    unittest.main()
