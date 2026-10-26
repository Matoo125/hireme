"""Tests for scrapers.europe, with a stand-in for the Anthropic client. Run: python3 -m unittest"""

import contextlib
import io
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from scrapers import europe

LONG = "The role involves research and writing. " * 20


class FakeClient:
    """Says "no" to postings mentioning US work authorization, "yes" to the
    rest; titles in `refuse` come back as refusals."""

    def __init__(self, refuse=()):
        self.calls = []
        self.refuse = set(refuse)
        self.lock = threading.Lock()
        self.messages = SimpleNamespace(parse=self.parse)

    def parse(self, **kwargs):
        text = kwargs["messages"][0]["content"]
        with self.lock:
            self.calls.append(text)
        title = text.split("Title: ")[1].split("\n")[0]
        if title in self.refuse:
            return SimpleNamespace(stop_reason="refusal", parsed_output=None)
        verdict = "no" if "US work authorization" in text else "yes"
        reading = kwargs["output_format"](europe=verdict, reason=f" Because {title}. ")
        return SimpleNamespace(stop_reason="end_turn", parsed_output=reading)


def jobs():
    return [
        {"id": "a", "title": "Analyst", "organization_name": "Org", "location": "Remote", "description": "Short."},
        {"id": "b", "title": "Lead", "organization_name": "Org", "location": "", "description": "Requires US work authorization."},
    ]


class Annotate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_annotate(self, job_list, client):
        with contextlib.redirect_stderr(io.StringIO()):
            return europe.annotate(job_list, self.data, "2026-10-26", client=client, workers=2)

    def write_posting(self, job_id, text):
        (self.data / "postings").mkdir(exist_ok=True)
        (self.data / "postings" / f"{job_id}.json").write_text(json.dumps({"link": "x", "text": text}))

    def test_reads_each_job_and_sets_columns(self):
        client = FakeClient()
        listed = jobs()
        self.assertEqual(self.run_annotate(listed, client), (2, 0, 0))
        self.assertEqual([(j["europe"], j["europe_reason"]) for j in listed],
                         [("yes", "Because Analyst."), ("no", "Because Lead.")])
        request = client.calls[0]
        self.assertIn("Board location tags: Remote", request)
        self.assertIn("Posting summary (the full posting couldn't be read):\nShort.", request)

    def test_full_posting_preferred_and_a_change_rereads(self):
        self.run_annotate(jobs(), FakeClient())
        client = FakeClient()
        self.assertEqual(self.run_annotate(jobs(), client), (0, 0, 0))
        self.assertEqual(client.calls, [])
        self.write_posting("a", "Requires US work authorization. " + LONG)
        listed = jobs()
        self.assertEqual(self.run_annotate(listed, client), (1, 0, 0))
        self.assertIn("Posting:\nRequires US work authorization.", client.calls[0])
        self.assertEqual(listed[0]["europe"], "no")

    def test_without_a_key_earlier_readings_kept(self):
        self.run_annotate(jobs()[:1], FakeClient())
        listed = jobs()
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.run_annotate(listed, None), (0, 0, 1))
        self.assertEqual([j["europe"] for j in listed], ["yes", ""])

    def test_refusal_fails_and_is_retried(self):
        listed = jobs()
        self.assertEqual(self.run_annotate(listed, FakeClient(refuse={"Lead"})), (1, 1, 0))
        self.assertEqual(listed[1]["europe"], "")
        client = FakeClient()
        self.assertEqual(self.run_annotate(jobs(), client), (1, 0, 0))

    def test_unlisted_jobs_dropped(self):
        self.run_annotate(jobs(), FakeClient())
        self.run_annotate(jobs()[:1], FakeClient())
        self.assertEqual(sorted(json.loads((self.data / "europe.json").read_text())), ["a"])


if __name__ == "__main__":
    unittest.main()
