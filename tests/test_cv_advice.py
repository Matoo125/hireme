"""Tests for cv_advice.py, with a stand-in for the Anthropic client. Run: python3 -m unittest"""

import contextlib
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import cv_advice


def job(i):
    return {"id": f"j{i}", "title": f"Job {i}", "organization_name": f"Org {i}", "description": f"Does {i}."}


JOBS = [job(i) for i in range(30)]

ADVICE = {
    "summary": "Strong on research, light on management.",
    "keep": ["Clear publication list"],
    "suggestions": [{"title": "Lead with policy work", "where": "Summary", "change": "Move it first.",
                     "why": "Most of these jobs are policy roles.", "job_ids": ["j1", "not-shown"]}],
}


class FakeClient:
    def __init__(self, refuse=False):
        self.calls = []
        self.refuse = refuse
        self.messages = SimpleNamespace(parse=self.parse)

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if self.refuse:
            return SimpleNamespace(stop_reason="refusal", parsed_output=None)
        return SimpleNamespace(stop_reason="end_turn", parsed_output=kwargs["output_format"](**ADVICE))


class AdviseUser(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        (self.data / "cv").mkdir()
        (self.data / "cv" / "7.pdf").write_bytes(b"%PDF-1.4 my cv")
        self.write("preferences", {"liked": ["j1", "gone"], "hidden": ["j3"]})
        self.write("applications", {"j2": {"status": "applied"}, "j1": {"status": "interested"}})
        self.write("fit", {"scores": {"j3": {"score": 95}, "j4": {"score": 80}, "j5": {"score": 90},
                                      "j6": {"score": 59}}})

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, kind, data):
        (self.data / kind).mkdir(exist_ok=True)
        (self.data / kind / "7.json").write_text(json.dumps(data))

    def run_user(self, client, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return cv_advice.advise_user(7, JOBS, self.data, client=client, **kwargs)

    def saved(self):
        return json.loads((self.data / "cv-advice" / "7.json").read_text())

    def test_picks_liked_then_tracked_then_best_fit_skipping_hidden_and_unlisted(self):
        ids = [j["id"] for j in cv_advice.pick_jobs(7, JOBS, self.data)]
        self.assertEqual(ids, ["j1", "j2", "j5", "j4"])

    def test_caps_the_number_of_jobs(self):
        self.write("preferences", {"liked": [j["id"] for j in JOBS]})
        self.assertEqual(len(cv_advice.pick_jobs(7, JOBS, self.data)), cv_advice.MAX_JOBS)

    def test_writes_advice_keyed_by_cv_and_jobs(self):
        self.assertTrue(self.run_user(FakeClient()))
        saved = self.saved()
        self.assertEqual(saved["cv"], hashlib.sha256(b"%PDF-1.4 my cv").hexdigest())
        self.assertEqual(saved["jobs"], ["j1", "j2", "j5", "j4"])
        self.assertEqual(saved["jobTitles"]["j1"], "Job 1 – Org 1")
        self.assertEqual(saved["advice"]["summary"], ADVICE["summary"])
        # Ids of jobs the model wasn't shown are dropped.
        self.assertEqual(saved["advice"]["suggestions"][0]["job_ids"], ["j1"])

    def test_sends_cv_and_each_job_with_its_id(self):
        client = FakeClient()
        self.run_user(client)
        request = client.calls[0]
        self.assertEqual(request["model"], "claude-opus-5-5")
        cv, text = request["messages"][0]["content"]
        self.assertEqual(cv["type"], "document")
        for i in ("j1", "j2", "j5", "j4"):
            self.assertIn(f"Job id: {i}\n", text["text"])
        self.assertNotIn("Job id: j3\n", text["text"])

    def test_skips_when_nothing_changed_unless_forced(self):
        self.run_user(FakeClient())
        client = FakeClient()
        self.assertFalse(self.run_user(client))
        self.assertTrue(self.run_user(client, force=True))
        self.assertEqual(len(client.calls), 1)

    def test_new_cv_or_new_like_advises_again(self):
        self.run_user(FakeClient())
        self.write("preferences", {"liked": ["j1", "j9"]})
        self.assertTrue(self.run_user(FakeClient()))
        (self.data / "cv" / "7.pdf").write_bytes(b"%PDF-1.4 new cv")
        self.assertTrue(self.run_user(FakeClient()))

    def test_no_cv_or_no_jobs_does_nothing(self):
        (self.data / "cv" / "7.pdf").unlink()
        self.assertFalse(self.run_user(FakeClient()))
        (self.data / "cv" / "7.pdf").write_bytes(b"%PDF-1.4 my cv")
        for kind in ("preferences", "applications", "fit"):
            (self.data / kind / "7.json").unlink()
        client = FakeClient()
        self.assertFalse(self.run_user(client))
        self.assertEqual(client.calls, [])

    def test_dry_run_calls_nothing(self):
        client = FakeClient()
        self.assertTrue(self.run_user(client, dry_run=True))
        self.assertEqual(client.calls, [])
        self.assertFalse((self.data / "cv-advice" / "7.json").exists())

    def test_refusal_raises_and_keeps_old_advice(self):
        self.run_user(FakeClient())
        before = self.saved()
        with self.assertRaises(ValueError):
            self.run_user(FakeClient(refuse=True), force=True)
        self.assertEqual(self.saved(), before)


if __name__ == "__main__":
    unittest.main()
