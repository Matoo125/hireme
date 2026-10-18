"""Tests for scrapers.overrides. Run: python3 -m unittest"""

import os
import tempfile
import unittest

from scrape_jobs import derive
from scrapers.overrides import OverridesError, apply_override, load_overrides


def load(text):
    with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False) as f:
        f.write(text)
    try:
        return load_overrides(f.name)
    finally:
        os.unlink(f.name)


def job(**fields):
    base = {"id": "abc", "title": "Engineer", "close_date": "", "tags": "", "salary_range": ""}
    base.update(fields)
    base.update(derive(base))
    return base


class Load(unittest.TestCase):
    def test_values_become_text(self):
        self.assertEqual(load('["abc"]\nclose_date = 2026-11-30\nsalary_min = 50000\ntitle = "X"\n'),
                         {"abc": {"close_date": "2026-11-30", "salary_min": "50000", "title": "X"}})

    def test_missing_file_is_empty(self):
        self.assertEqual(load_overrides("/nonexistent/overrides.toml"), {})

    def test_comments_only_is_empty(self):
        self.assertEqual(load("# nothing yet\n"), {})

    def test_unknown_column(self):
        with self.assertRaisesRegex(OverridesError, "titel"):
            load('["abc"]\ntitel = "X"\n')

    def test_id_cannot_be_overridden(self):
        with self.assertRaisesRegex(OverridesError, "id"):
            load('["abc"]\nid = "def"\n')

    def test_not_a_table(self):
        with self.assertRaises(OverridesError):
            load('abc = "X"\n')

    def test_broken_toml(self):
        with self.assertRaises(OverridesError):
            load('["abc"\n')

    def test_bad_value(self):
        with self.assertRaises(OverridesError):
            load('["abc"]\ntags = ["a", "b"]\n')


class Apply(unittest.TestCase):
    def test_scraped_field(self):
        j = job(close_date="2026-11-02")
        self.assertEqual(apply_override(j, {"close_date": "2026-11-30"}, derive), [])
        self.assertEqual(j["close_date"], "2026-11-30")

    def test_corrected_source_feeds_derived_columns(self):
        j = job(salary_range="Competitive", tags="Full-time")
        apply_override(j, {"salary_range": "£40k - 65k", "tags": "Part-time; Remote"}, derive)
        self.assertEqual((j["salary_min"], j["salary_max"], j["salary_currency"], j["salary_period"]),
                         ("40000", "65000", "GBP", "year"))
        self.assertEqual((j["job_type"], j["location"]), ("Part-time", "Remote"))

    def test_derived_column_set_directly_wins(self):
        j = job(salary_range="$5,000")
        apply_override(j, {"salary_period": "month"}, derive)
        self.assertEqual((j["salary_min"], j["salary_period"]), ("5000", "month"))

    def test_reports_values_the_scrape_now_gives(self):
        j = job(close_date="2026-11-30", salary_range="$80,000")
        self.assertEqual(apply_override(j, {"close_date": "2026-11-30", "salary_period": "year", "title": "Lead"}, derive),
                         ["close_date", "salary_period"])

    def test_no_override_just_derives(self):
        j = {"id": "abc", "tags": "Remote", "salary_range": ""}
        apply_override(j, {}, derive)
        self.assertEqual(j["location"], "Remote")


if __name__ == "__main__":
    unittest.main()
