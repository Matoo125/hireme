"""Tests for scrapers.history. Run: python3 -m unittest"""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from scrapers.history import first_seen_from_git, record


def job(job_id, **extra):
    return {"id": job_id, "title": f"Job {job_id}", "organization_name": "Org", **extra}


class Record(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.history = Path(self.tmp.name) / "history"
        # No git history here: first-seen starts empty.
        self.jobs_csv = Path(self.tmp.name) / "jobs.csv"

    def tearDown(self):
        self.tmp.cleanup()

    def test_first_scrape_sets_today(self):
        jobs = [job("a"), job("b")]
        self.assertEqual(record(jobs, "2026-10-25", self.history, self.jobs_csv), 2)
        self.assertEqual([j["first_seen"] for j in jobs], ["2026-10-25", "2026-10-25"])
        snapshot = json.loads((self.history / "2026-10-25.json").read_text())
        self.assertEqual([j["id"] for j in snapshot], ["a", "b"])
        self.assertEqual(snapshot[0]["title"], "Job a")
        self.assertNotIn("description", snapshot[0])

    def test_known_jobs_keep_their_date(self):
        record([job("a")], "2026-10-25", self.history, self.jobs_csv)
        jobs = [job("a"), job("c")]
        self.assertEqual(record(jobs, "2026-10-26", self.history, self.jobs_csv), 1)
        self.assertEqual({j["id"]: j["first_seen"] for j in jobs}, {"a": "2026-10-25", "c": "2026-10-26"})

    def test_job_missing_for_a_day_keeps_its_date(self):
        record([job("a"), job("b")], "2026-10-25", self.history, self.jobs_csv)
        record([job("b")], "2026-10-26", self.history, self.jobs_csv)  # a's board failed
        jobs = [job("a")]
        record(jobs, "2026-10-27", self.history, self.jobs_csv)
        self.assertEqual(jobs[0]["first_seen"], "2026-10-25")
        self.assertEqual(sorted(p.name for p in self.history.glob("2026-*.json")),
                         ["2026-10-25.json", "2026-10-26.json", "2026-10-27.json"])

    def test_rerun_same_day_overwrites_snapshot(self):
        record([job("a")], "2026-10-25", self.history, self.jobs_csv)
        record([job("a"), job("b")], "2026-10-25", self.history, self.jobs_csv)
        snapshot = json.loads((self.history / "2026-10-25.json").read_text())
        self.assertEqual([j["id"] for j in snapshot], ["a", "b"])


class Backfill(unittest.TestCase):
    def test_dates_from_jobs_csv_commits(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git = lambda *args, date=None: subprocess.run(
                ["git", *args], cwd=repo, check=True, capture_output=True,
                env={"GIT_COMMITTER_DATE": date or "", "GIT_AUTHOR_DATE": date or "",
                     "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                     "GIT_COMMITTER_EMAIL": "t@t", "HOME": tmp, "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"},
            )
            git("init", "-q")
            for date, ids in [("2026-08-01T06:00:00Z", ["a"]), ("2026-08-02T06:00:00Z", ["a", "b"]),
                              ("2026-08-03T06:00:00Z", ["b", "c"])]:
                (repo / "jobs.csv").write_text("id,title\n" + "".join(f"{i},T\n" for i in ids))
                git("add", "jobs.csv")
                git("commit", "-q", "-m", "sync jobs", date=date)
            self.assertEqual(first_seen_from_git(repo / "jobs.csv"),
                             {"a": "2026-08-01", "b": "2026-08-02", "c": "2026-08-03"})

            # record() uses it when first-seen.json doesn't exist yet.
            jobs = [job("b"), job("d")]
            record(jobs, "2026-10-25", repo / "data" / "history", repo / "jobs.csv")
            self.assertEqual({j["id"]: j["first_seen"] for j in jobs}, {"b": "2026-08-02", "d": "2026-10-25"})

    def test_no_git_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(first_seen_from_git(Path(tmp) / "jobs.csv"), {})


if __name__ == "__main__":
    unittest.main()
