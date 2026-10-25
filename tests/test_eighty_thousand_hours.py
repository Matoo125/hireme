"""Tests for scrapers.eighty_thousand_hours. Run: python3 -m unittest"""

import unittest
from datetime import datetime, timezone

from scrapers.eighty_thousand_hours import _publication_date


def ts(day):
    return int(datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp())


class PublicationDate(unittest.TestCase):
    def test_open_call_placeholder_uses_created_at(self):
        # Rosalind Biodefense Program, as the board served it in Oct 2026.
        hit = {"posted_at": ts("2022-01-13"), "created_at": ts("2026-07-03")}
        self.assertEqual(_publication_date(hit), "2026-07-03")

    def test_ordinary_job_keeps_posted_at(self):
        hit = {"posted_at": ts("2026-10-20"), "created_at": ts("2026-10-19")}
        self.assertEqual(_publication_date(hit), "2026-10-20")

    def test_repost_keeps_later_posted_at(self):
        hit = {"posted_at": ts("2026-10-01"), "created_at": ts("2023-03-01")}
        self.assertEqual(_publication_date(hit), "2026-10-01")

    def test_posted_somewhat_before_created_is_kept(self):
        # The board has jobs posted up to ~70 days before they were added.
        hit = {"posted_at": ts("2026-08-01"), "created_at": ts("2026-10-01")}
        self.assertEqual(_publication_date(hit), "2026-08-01")

    def test_missing_dates(self):
        self.assertEqual(_publication_date({"created_at": ts("2026-07-03")}), "2026-07-03")
        self.assertEqual(_publication_date({"posted_at": ts("2026-07-03")}), "2026-07-03")
        self.assertEqual(_publication_date({}), "")


if __name__ == "__main__":
    unittest.main()
