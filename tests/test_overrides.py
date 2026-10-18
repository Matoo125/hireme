"""Tests for scrapers.overrides. Run: python3 -m unittest"""

import csv
import json
import os
import tempfile
import unittest
from pathlib import Path

from scrapers.overrides import (
    OverridesError, UnknownJob, apply_override, clean_value, derive, edit_text, load_overrides,
    parse_overrides, set_overrides,
)


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



FILE = """# Hand corrections.

["aaa"]  # First job
# board shows last year's date
close_date = "2026-11-30"
title = "Lead"

[bbb]
salary_range = "$1"
"""


class EditText(unittest.TestCase):
    def test_change_keeps_comments_and_order(self):
        out = edit_text(FILE, "aaa", {"close_date": "2026-12-01"})
        self.assertEqual(out, FILE.replace("2026-11-30", "2026-12-01"))

    def test_add_field_to_existing_table(self):
        out = edit_text(FILE, "bbb", {"title": 'Say "hi"\\'})
        self.assertEqual(parse_overrides(out)["bbb"], {"salary_range": "$1", "title": 'Say "hi"\\'})
        self.assertTrue(out.startswith(FILE.rstrip("\n")))

    def test_new_table_at_end_with_comment(self):
        out = edit_text(FILE, "ccc", {"title": "X"}, "Engineer - Org")
        self.assertTrue(out.endswith('\n\n["ccc"]  # Engineer - Org\ntitle = "X"\n'))

    def test_removing_last_field_drops_table(self):
        out = edit_text(FILE, "bbb", {"salary_range": None})
        self.assertEqual(parse_overrides(out), {"aaa": {"close_date": "2026-11-30", "title": "Lead"}})
        self.assertNotIn("bbb", out)
        self.assertTrue(out.endswith('title = "Lead"\n'))

    def test_removing_one_field(self):
        out = edit_text(FILE, "aaa", {"title": None})
        self.assertEqual(parse_overrides(out)["aaa"], {"close_date": "2026-11-30"})
        self.assertIn("# board shows", out)

    def test_control_characters_escaped(self):
        out = edit_text("", "ccc", {"description": "a\nb\tc\x01"})
        self.assertEqual(parse_overrides(out), {"ccc": {"description": "a\nb\tc\x01"}})

    def test_removing_from_missing_table_changes_nothing(self):
        self.assertEqual(edit_text(FILE, "zzz", {"title": None}), FILE)


class CleanValue(unittest.TestCase):
    def test_values(self):
        self.assertEqual(clean_value("salary_min", " 80,000 "), "80000")
        self.assertEqual(clean_value("salary_currency", "usd"), "USD")
        self.assertEqual(clean_value("location", "Remote;Global; Remote"), "Remote; Global")
        self.assertEqual(clean_value("close_date", "2026-11-30"), "2026-11-30")
        self.assertEqual(clean_value("title", "  "), "")

    def test_refused(self):
        for field, value in [("salary_min", "lots"), ("close_date", "30/11/2026"), ("salary_period", "fortnight"),
                             ("salary_currency", "dollars"), ("id", "x"), ("corrected", "x")]:
            with self.assertRaises(OverridesError, msg=field):
                clean_value(field, value)


class SetOverrides(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.scraped = self.dir / "scraped.json"
        self.overrides = self.dir / "overrides.toml"
        self.jobs = self.dir / "jobs.csv"
        self.scraped.write_text(json.dumps([
            {"id": "aaa", "title": "Engineer", "organization_name": "Org", "close_date": "2026-11-02",
             "tags": "Full-time", "salary_range": "$80,000"},
            {"id": "bbb", "title": "Analyst", "organization_name": "Org", "close_date": "",
             "tags": "", "salary_range": ""},
        ]))
        self.overrides.write_text("# Hand corrections.\n")

    def set(self, job_id, patch):
        return set_overrides(job_id, patch, self.overrides, self.scraped, self.jobs)

    def csv_rows(self):
        with open(self.jobs, newline="") as f:
            return {r["id"]: r for r in csv.DictReader(f)}

    def test_set_rebuilds_jobs_csv(self):
        row = self.set("aaa", {"salary_range": "£40k - 65k", "close_date": "2026-11-30"})
        self.assertEqual((row["salary_min"], row["salary_currency"], row["close_date"]), ("40000", "GBP", "2026-11-30"))
        self.assertEqual(row["corrected"], "close_date; salary_range")
        self.assertEqual(self.csv_rows()["aaa"]["salary_max"], "65000")
        self.assertEqual(self.csv_rows()["bbb"]["corrected"], "")
        self.assertIn('["aaa"]  # Engineer - Org', self.overrides.read_text())

    def test_null_undoes(self):
        self.set("aaa", {"close_date": "2026-11-30"})
        row = self.set("aaa", {"close_date": None})
        self.assertEqual((row["close_date"], row["corrected"]), ("2026-11-02", ""))
        self.assertEqual(self.overrides.read_text(), "# Hand corrections.\n")

    def test_scraped_value_undoes(self):
        self.set("aaa", {"salary_period": "month"})
        row = self.set("aaa", {"salary_period": "year"})
        self.assertEqual(row["corrected"], "")
        self.assertEqual(load_overrides(self.overrides), {})

    def test_unknown_job(self):
        with self.assertRaises(UnknownJob):
            self.set("zzz", {"title": "X"})

    def test_bad_value_writes_nothing(self):
        with self.assertRaises(OverridesError):
            self.set("aaa", {"salary_min": "lots"})
        self.assertEqual(self.overrides.read_text(), "# Hand corrections.\n")
        self.assertFalse(self.jobs.exists())


if __name__ == "__main__":
    unittest.main()
