"""Tests for scrapers.tag_fields and scrapers.salary. Run: python3 -m unittest"""

import unittest

from scrapers.salary import parse_salary
from scrapers.tag_fields import classify_tags


class ClassifyTags(unittest.TestCase):
    def test_boards_wording_merges(self):
        fields, unknown = classify_tags("Mid (5-9 years experience); Mid-senior level; Full-Time; Remote, Global")
        self.assertEqual(fields["experience"], "Mid (5–9y)")
        self.assertEqual(fields["job_type"], "Full-time")
        self.assertEqual(fields["location"], "Remote; Global")
        self.assertEqual(unknown, [])

    def test_one_tag_several_values(self):
        fields, _ = classify_tags("Research or data")
        self.assertEqual(fields["skills"], "Research; Data")

    def test_untyped_and_unknown(self):
        fields, unknown = classify_tags("Direct high impact on an important cause; Quantum basket weaving")
        self.assertEqual(fields["other_tags"], "Direct high impact on an important cause; Quantum basket weaving")
        self.assertEqual({v for k, v in fields.items() if k != "other_tags"}, {""})
        self.assertEqual(unknown, ["Quantum basket weaving"])

    def test_every_column_present(self):
        fields, _ = classify_tags("")
        self.assertEqual(set(fields), {"job_type", "experience", "education", "location", "cause_area", "skills", "other_tags"})


def s(text):
    p = parse_salary(text)
    return (p["salary_min"], p["salary_max"], p["salary_currency"], p["salary_period"])


class ParseSalary(unittest.TestCase):
    # All taken from the boards.
    def test_plain_ranges(self):
        self.assertEqual(s("$79,200 - $90,000"), ("79200", "90000", "USD", "year"))
        self.assertEqual(s("£55,000 - £68,000"), ("55000", "68000", "GBP", "year"))
        self.assertEqual(s("€70,000 - €110,000"), ("70000", "110000", "EUR", "year"))
        self.assertEqual(s("$205,600–$226,800"), ("205600", "226800", "USD", "year"))
        self.assertEqual(s("$120,000 – $200,000+"), ("120000", "200000", "USD", "year"))

    def test_suffixes_shared_across_a_range(self):
        self.assertEqual(s("$150K – $178K"), ("150000", "178000", "USD", "year"))
        self.assertEqual(s("£40k - 65k (+ benefits), depending on experience"), ("40000", "65000", "GBP", "year"))
        self.assertEqual(s("90 to 143 million KRW"), ("90000000", "143000000", "KRW", ""))
        self.assertEqual(s("$40 - $50 CAD per hour"), ("40", "50", "CAD", "hour"))
        self.assertEqual(s("$147,000 – 190,000"), ("147000", "190000", "USD", "year"))

    def test_periods(self):
        self.assertEqual(s("$80 - $120 per hour"), ("80", "120", "USD", "hour"))
        self.assertEqual(s("$1,000/month"), ("1000", "1000", "USD", "month"))
        self.assertEqual(s("£35,000 – £45,000 pro-rata"), ("35000", "45000", "GBP", "year"))
        self.assertEqual(s("25€/Hour"), ("25", "25", "EUR", "hour"))
        self.assertEqual(s("$100,000 - $2,000,000 grant"), ("100000", "2000000", "USD", "total"))
        self.assertEqual(s("$25,000–$38,000 for ~four (4) months"), ("25000", "38000", "USD", "total"))
        self.assertEqual(s("living stipend of ~$125,000 for the year"), ("125000", "125000", "USD", "year"))

    def test_small_amount_without_period_stays_unknown(self):
        self.assertEqual(s("£2,300"), ("2300", "2300", "GBP", ""))

    def test_variants_give_the_span_in_the_first_currency(self):
        self.assertEqual(s("$241,000 (NYC or San Francisco Bay Area) / $219,000 (All other U.S. locations)"),
                         ("219000", "241000", "USD", "year"))
        self.assertEqual(s("Bay Area: $75,000 – $90,000 | US remote: $62,500 – $75,000"), ("62500", "90000", "USD", "year"))
        self.assertEqual(s("$80K – $145K / £50K – £90K"), ("80000", "145000", "USD", "year"))
        self.assertEqual(s("£93,000–121,000 for candidates in London, £81,000–105,000 for remote candidates "
                           "outside of the US, and $116,000–170,000 for candidates in the US"),
                         ("81000", "121000", "GBP", "year"))
        self.assertEqual(s("NGN 500,000 – 730,000 (USD 370 – 550) per month"), ("500000", "730000", "NGN", "month"))

    def test_currency_markers(self):
        self.assertEqual(s("A$120,000 – $135,000"), ("120000", "135000", "AUD", "year"))
        self.assertEqual(s("6,00,000 – 9,00,000 lakhs"), ("600000", "900000", "INR", ""))
        self.assertEqual(s("24000 to 80000"), ("24000", "80000", "", ""))
        self.assertEqual(s("up to US$1,000 total"), ("", "1000", "USD", "total"))

    def test_open_ended(self):
        self.assertEqual(s("Up to $52,300"), ("", "52300", "USD", "year"))
        self.assertEqual(s("Starting: $25 per hour"), ("25", "", "USD", "hour"))

    def test_digits_in_words_are_not_pay(self):
        self.assertEqual(s("6-month initial runway of USD $15,000"), ("15000", "15000", "USD", "total"))

    def test_no_number(self):
        self.assertEqual(s("Unpaid"), ("0", "0", "", "unpaid"))
        for text in ["Competitive", "Commensurate with experience", "Dependent on experience", ""]:
            self.assertEqual(s(text), ("", "", "", ""), text)


if __name__ == "__main__":
    unittest.main()
