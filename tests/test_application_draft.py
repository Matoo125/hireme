"""Tests for application_draft.py, with a stand-in for the Anthropic client. Run: python3 -m unittest"""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import application_draft

JOBS = [{"id": "j1", "title": "Analyst", "organization_name": "Org", "description": "Analyse things."}]

DRAFT = {
    "language": "en",
    "letter": "Dear Org,\n\nI'd like to join as an analyst.",
    "answers": [{"question": "Why us?", "answer": "Because [your reason]."}],
    "gaps": ["Asks for SQL; the CV doesn't mention it"],
}


class FakeClient:
    def __init__(self, refuse=False, on_call=None, draft=DRAFT):
        self.draft = draft
        self.calls = []
        self.refuse = refuse
        self.on_call = on_call
        self.messages = SimpleNamespace(parse=self.parse)

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if self.on_call:
            self.on_call()
        if self.refuse:
            return SimpleNamespace(stop_reason="refusal", parsed_output=None)
        return SimpleNamespace(stop_reason="end_turn", parsed_output=kwargs["output_format"](**self.draft))


class DraftApplication(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        (self.data / "cv").mkdir()
        self.cv = self.data / "cv" / "7.pdf"
        self.cv.write_bytes(b"%PDF-1.4 my cv")

    def tearDown(self):
        self.tmp.cleanup()

    def run_draft(self, job_id="j1", **kwargs):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            result = application_draft.draft_application(7, job_id, JOBS, self.data, **kwargs)
        return result, out.getvalue()

    def saved(self, job_id="j1"):
        return json.loads(application_draft.draft_path(self.data, 7, job_id).read_text())

    def test_writes_the_draft_with_the_cv_and_job(self):
        client = FakeClient()
        written, _ = self.run_draft(client=client)
        self.assertTrue(written)
        saved = self.saved()
        # Older-style output (no checklist or deadline) gets them empty.
        self.assertEqual(saved["draft"], {**DRAFT, "checklist": [], "deadline": ""})
        self.assertEqual(saved["job"], "j1")
        self.assertFalse(saved["fromPosting"])
        content = client.calls[0]["messages"][0]["content"]
        self.assertEqual(content[0]["type"], "document")
        self.assertIn("Title: Analyst", content[1]["text"])

    def write_answers(self, answers):
        (self.data / "answers").mkdir(exist_ok=True)
        (self.data / "answers" / "7.json").write_text(json.dumps(answers))

    def request_text(self, client):
        return "\n".join(part.get("text", "") for part in client.calls[0]["messages"][0]["content"])

    def test_saved_answers_go_to_the_model(self):
        self.write_answers([{"question": "Salary expectations", "answer": "60k EUR"},
                            {"question": "Notice period", "answer": ""}])
        client = FakeClient()
        self.run_draft(client=client)
        text = self.request_text(client)
        self.assertIn("Q: Salary expectations\nA: 60k EUR", text)
        self.assertNotIn("Notice period", text)

    def test_no_saved_answers_no_block(self):
        client = FakeClient()
        self.run_draft(client=client)
        self.assertNotIn("saved answers", self.request_text(client).lower())

    def test_changed_answers_make_a_new_draft(self):
        self.write_answers([{"question": "Salary expectations", "answer": "60k EUR"}])
        self.run_draft(client=FakeClient())
        self.write_answers([{"question": "Salary expectations", "answer": "65k EUR"}])
        written, _ = self.run_draft(client=FakeClient())
        self.assertTrue(written)

    def test_answers_hash_matches_the_servers(self):
        # server.ts hashes JSON.stringify(answers): no spaces, non-ASCII kept.
        answers = [{"question": "Plat", "answer": "60 000 € (hrubý)"}]
        self.write_answers(answers)
        self.run_draft(client=FakeClient())
        expected = __import__("hashlib").sha256(
            '[{"question":"Plat","answer":"60 000 € (hrubý)"}]'.encode("utf-8")).hexdigest()
        self.assertEqual(self.saved()["answers"], expected)

    def test_draft_keeps_checklist_and_deadline(self):
        draft = {**DRAFT, "checklist": ["CV", "Work sample"], "deadline": "15 January 2027"}
        self.run_draft(client=FakeClient(draft=draft))
        saved = self.saved()
        self.assertEqual(saved["draft"]["checklist"], ["CV", "Work sample"])
        self.assertEqual(saved["draft"]["deadline"], "15 January 2027")
        self.assertEqual(saved["version"], 2)

    def test_checklist_fits_what_the_server_accepts_as_ticks(self):
        # PUT /api/applications refuses `checked` past 50 items of 300 characters.
        draft = {**DRAFT, "checklist": ["x" * 400] + [f"item {i}" for i in range(60)]}
        self.run_draft(client=FakeClient(draft=draft))
        checklist = self.saved()["draft"]["checklist"]
        self.assertEqual(len(checklist), 50)
        self.assertTrue(all(len(item) <= 300 for item in checklist))
        self.assertTrue(checklist[0].endswith("…"))

    def test_skips_when_cv_and_job_are_unchanged_unless_forced(self):
        self.run_draft(client=FakeClient())
        client = FakeClient()
        written, out = self.run_draft(client=client)
        self.assertFalse(written)
        self.assertIn("already up to date", out)
        self.assertEqual(client.calls, [])
        written, _ = self.run_draft(client=client, force=True)
        self.assertTrue(written)

    def test_a_new_cv_makes_a_new_draft(self):
        self.run_draft(client=FakeClient())
        self.cv.write_bytes(b"%PDF-1.4 new cv")
        written, _ = self.run_draft(client=FakeClient())
        self.assertTrue(written)

    def test_finds_the_users_own_added_jobs(self):
        (self.data / "custom-jobs").mkdir()
        (self.data / "custom-jobs" / "7.json").write_text(json.dumps(
            [{"id": "c1", "title": "Mine", "organization_name": "Own Org", "description": "Added by link."}]))
        client = FakeClient()
        written, _ = self.run_draft("c1", client=client)
        self.assertTrue(written)
        self.assertIn("Title: Mine", client.calls[0]["messages"][0]["content"][1]["text"])

    def test_no_cv_or_unknown_job_does_nothing(self):
        written, out = self.run_draft("nope", client=FakeClient())
        self.assertFalse(written)
        self.assertIn("not found", out)
        self.cv.unlink()
        written, out = self.run_draft(client=FakeClient())
        self.assertFalse(written)
        self.assertIn("no CV", out)

    def test_rejects_job_ids_that_could_escape_the_folder(self):
        with self.assertRaises(ValueError):
            self.run_draft("../8", client=FakeClient())

    def test_cv_replaced_during_the_run_is_not_saved(self):
        client = FakeClient(on_call=lambda: self.cv.write_bytes(b"%PDF-1.4 replaced"))
        written, out = self.run_draft(client=client)
        self.assertFalse(written)
        self.assertIn("CV changed", out)
        self.assertFalse(application_draft.draft_path(self.data, 7, "j1").exists())

    def test_refusal_raises(self):
        with self.assertRaises(ValueError):
            self.run_draft(client=FakeClient(refuse=True))


if __name__ == "__main__":
    unittest.main()
