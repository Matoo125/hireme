"""Tests for fit_scores.py, with a stand-in for the Anthropic client. Run: python3 -m unittest"""

import contextlib
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

import fit_scores


class FakeClient:
    """Answers messages.parse() with a score per job title; titles in
    `refuse` come back as refusals."""

    def __init__(self, refuse=()):
        self.calls = []
        self.refuse = set(refuse)
        self.lock = threading.Lock()
        self.messages = SimpleNamespace(parse=self.parse)

    def parse(self, **kwargs):
        with self.lock:
            self.calls.append(kwargs)
        text = kwargs["messages"][0]["content"][1]["text"]
        title = text.split("Title: ")[1].split("\n")[0]
        usage = SimpleNamespace(input_tokens=100, cache_read_input_tokens=900,
                                cache_creation_input_tokens=0, output_tokens=40)
        if title in self.refuse:
            return SimpleNamespace(stop_reason="refusal", parsed_output=None, usage=usage)
        fit = kwargs["output_format"](score=len(title) * 5, reason=f" Fits {title}. ")
        return SimpleNamespace(stop_reason="end_turn", parsed_output=fit, usage=usage)


def jobs(*titles):
    return [{"id": t.lower(), "title": t, "organization_name": "Org", "description": f"About {t}"} for t in titles]


class ScoreUser(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        (self.data / "cv").mkdir()
        (self.data / "cv" / "7.pdf").write_bytes(b"%PDF-1.4 my cv")

    def tearDown(self):
        self.tmp.cleanup()

    def run_user(self, job_list, client, user="7"):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return fit_scores.score_user(user, job_list, self.data, workers=2, client=client)

    def saved(self):
        return json.loads((self.data / "fit" / "7.json").read_text())

    def test_scores_every_job_with_cv_cached_first(self):
        client = FakeClient()
        self.assertEqual(self.run_user(jobs("Analyst", "Lead"), client), (2, 0))
        scores = self.saved()["scores"]
        self.assertEqual(scores["analyst"]["score"], 35)
        self.assertEqual(scores["analyst"]["reason"], "Fits Analyst.")
        self.assertIn("scored_at", scores["lead"])
        request = client.calls[0]
        self.assertEqual(request["model"], "claude-haiku-5-5")
        self.assertEqual(request["output_config"], {"effort": "low"})
        cv = request["messages"][0]["content"][0]
        self.assertEqual((cv["type"], cv["cache_control"]), ("document", {"type": "ephemeral"}))
        self.assertIn("Description: About Analyst", request["messages"][0]["content"][1]["text"])

    def test_only_new_jobs_are_scored_and_closed_ones_dropped(self):
        self.run_user(jobs("Analyst", "Lead"), FakeClient())
        client = FakeClient()
        self.assertEqual(self.run_user(jobs("Lead", "Engineer"), client), (1, 0))
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(sorted(self.saved()["scores"]), ["engineer", "lead"])

    def test_new_cv_rescores_everything(self):
        self.run_user(jobs("Analyst"), FakeClient())
        (self.data / "cv" / "7.pdf").write_bytes(b"%PDF-1.4 updated cv")
        client = FakeClient()
        self.run_user(jobs("Analyst"), client)
        self.assertEqual(len(client.calls), 1)

    def test_refusal_counts_as_failure_and_is_retried_next_time(self):
        self.assertEqual(self.run_user(jobs("Analyst", "Lead"), FakeClient(refuse={"Lead"})), (1, 1))
        self.assertEqual(sorted(self.saved()["scores"]), ["analyst"])
        client = FakeClient()
        self.run_user(jobs("Analyst", "Lead"), client)
        self.assertEqual(len(client.calls), 1)

    def test_user_without_cv_is_skipped(self):
        client = FakeClient()
        self.assertEqual(self.run_user(jobs("Analyst"), client, user="8"), (0, 0))
        self.assertEqual(client.calls, [])

    def test_dry_run_calls_nothing_and_writes_nothing(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            fit_scores.score_user("7", jobs("Analyst"), self.data, dry_run=True, client=FakeClient())
        self.assertIn("1 to score", out.getvalue())
        self.assertFalse((self.data / "fit").exists())


class Evaluate(unittest.TestCase):
    def test_liked_vs_hidden(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            fit_scores.write_json(data / "fit" / "7.json", {"scores": {
                "a": {"score": 85}, "b": {"score": 70}, "c": {"score": 20}, "d": {"score": 55},
            }})
            fit_scores.write_json(data / "preferences" / "7.json", {"liked": ["a", "b"], "hidden": ["c", "d"]})
            with contextlib.redirect_stdout(io.StringIO()) as out:
                fit_scores.evaluate("7", data)
            self.assertIn("liked: 2 scored, median 77.5", out.getvalue())
            self.assertIn("hidden jobs scored below 40: 50%", out.getvalue())


if __name__ == "__main__":
    unittest.main()
