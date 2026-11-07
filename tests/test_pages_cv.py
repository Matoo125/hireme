"""Tests for pages_cv.py, with a stand-in for the Anthropic client. Run: python3 -m unittest"""

import contextlib
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import pages_cv


CONTENT = {
    "name": "Jane Example",
    "language": "en",
    "headline": "Backend engineer",
    "summary": "Builds data pipelines.",
    "skills": ["Python", "SQL"],
    "experience": [{"title": "Engineer", "organization": "Acme", "period": "2020 - 2024",
                    "location": "Remote", "bullets": ["Shipped the ingest pipeline"]}],
    "education": [{"school": "University", "degree": "BSc", "period": "2016 - 2019"}],
    "projects": [{"title": "Log tool", "description": "Ships logs.", "url": "https://example.com/log"}],
    "links": [{"label": "GitHub", "url": "https://github.com/example"}],
}


class FakeClient:
    """Answers messages.parse() with `content` (CONTENT by default), or a refusal
    when `refuse` is set. `during` runs inside the call, standing in for whatever
    happens while Claude is answering."""

    def __init__(self, refuse=False, content=None, during=None):
        self.calls = []
        self.refuse = refuse
        self.content = content or CONTENT
        self.during = during
        self.messages = SimpleNamespace(parse=self.parse)

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if self.during:
            self.during()
        if self.refuse:
            return SimpleNamespace(stop_reason="refusal", parsed_output=None)
        return SimpleNamespace(stop_reason="end_turn", parsed_output=kwargs["output_format"](**self.content))


class MakeUserPage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        (self.data / "cv").mkdir()
        (self.data / "cv" / "7.pdf").write_bytes(b"%PDF-1.4 my cv")
        self.turn_on(True)

    def tearDown(self):
        self.tmp.cleanup()

    def turn_on(self, enabled):
        (self.data / "pages").mkdir(exist_ok=True)
        (self.data / "pages" / "7.json").write_text(json.dumps({"enabled": enabled, "slug": "jane"}))

    def run_user(self, client, dry_run=False, force=False):
        with contextlib.redirect_stdout(io.StringIO()):
            return pages_cv.make_user_page(7, self.data, dry_run=dry_run, force=force, client=client)

    def edit(self, at="2026-11-07T12:00:00Z", **changes):
        """Save the content the way the web app's editor does."""
        saved = self.saved()
        saved["content"].update(changes)
        saved["edited"] = True
        saved["editedAt"] = at
        (self.data / "page-content" / "7.json").write_text(json.dumps(saved))

    def saved(self):
        return json.loads((self.data / "page-content" / "7.json").read_text())

    def test_writes_content_with_cv_hash_and_no_contact_fields(self):
        client = FakeClient()
        self.assertTrue(self.run_user(client))
        saved = self.saved()
        self.assertEqual(saved["content"]["name"], "Jane Example")
        self.assertEqual(saved["content"]["experience"][0]["bullets"], ["Shipped the ingest pipeline"])
        self.assertEqual(saved["model"], "claude-haiku-5-5")
        self.assertEqual(saved["version"], pages_cv.CONTENT_VERSION)
        self.assertEqual(saved["cv"], hashlib.sha256(b"%PDF-1.4 my cv").hexdigest())
        self.assertNotIn("email", saved["content"])
        self.assertNotIn("phone", saved["content"])

    def test_sends_cv_as_document_and_asks_for_the_schema(self):
        client = FakeClient()
        self.run_user(client)
        request = client.calls[0]
        self.assertEqual(request["model"], "claude-haiku-5-5")
        self.assertIn("Never include contact details", request["system"])
        document = request["messages"][0]["content"][0]
        self.assertEqual(document["type"], "document")
        self.assertEqual(document["source"]["media_type"], "application/pdf")

    def test_unchanged_cv_is_not_remade(self):
        self.run_user(FakeClient())
        client = FakeClient()
        self.assertFalse(self.run_user(client))
        self.assertEqual(client.calls, [])

    def test_new_cv_is_remade(self):
        self.run_user(FakeClient())
        (self.data / "cv" / "7.pdf").write_bytes(b"%PDF-1.4 new cv")
        client = FakeClient()
        self.assertTrue(self.run_user(client))
        self.assertEqual(len(client.calls), 1)

    def test_page_turned_off_makes_nothing(self):
        self.turn_on(False)
        client = FakeClient()
        self.assertFalse(self.run_user(client))
        self.assertEqual(client.calls, [])
        self.assertFalse((self.data / "page-content" / "7.json").exists())

    def test_no_cv_makes_nothing(self):
        (self.data / "cv" / "7.pdf").unlink()
        self.assertFalse(self.run_user(FakeClient()))

    def test_dry_run_calls_nothing_and_writes_nothing(self):
        client = FakeClient()
        self.assertTrue(self.run_user(client, dry_run=True))
        self.assertEqual(client.calls, [])
        self.assertFalse((self.data / "page-content" / "7.json").exists())

    def test_cuts_contact_details_the_model_wrote_anyway(self):
        leaky = {**CONTENT,
                 "summary": "Builds pipelines. Write to jane@example.com or call +421 905 123 456.",
                 "experience": [{**CONTENT["experience"][0], "bullets": ["Shipped 2019 - 2024", "Hotline 0905 123 456"]}],
                 "links": [*CONTENT["links"], {"label": "Email", "url": "mailto:jane@example.com"}]}
        self.run_user(FakeClient(content=leaky))
        content = self.saved()["content"]
        text = json.dumps(content)
        self.assertNotIn("jane@example.com", text)
        self.assertNotIn("905", text)
        self.assertIn("2019 - 2024", text)
        self.assertEqual([l["label"] for l in content["links"]], ["GitHub"])

    def test_edited_content_is_kept_over_a_new_cv(self):
        self.run_user(FakeClient())
        self.edit(headline="Edited by hand")
        (self.data / "cv" / "7.pdf").write_bytes(b"%PDF-1.4 new cv")
        client = FakeClient()
        self.assertFalse(self.run_user(client))
        self.assertEqual(client.calls, [])
        self.assertEqual(self.saved()["content"]["headline"], "Edited by hand")

    def test_force_remakes_edited_content(self):
        self.run_user(FakeClient())
        self.edit(headline="Edited by hand")
        self.assertTrue(self.run_user(FakeClient(), force=True))
        saved = self.saved()
        self.assertEqual(saved["content"]["headline"], "Backend engineer")
        self.assertNotIn("edited", saved)

    def test_cv_deleted_during_the_run_writes_nothing(self):
        client = FakeClient(during=lambda: (self.data / "cv" / "7.pdf").unlink())
        self.assertFalse(self.run_user(client))
        self.assertFalse((self.data / "page-content" / "7.json").exists())

    def test_cv_replaced_during_the_run_writes_nothing(self):
        client = FakeClient(during=lambda: (self.data / "cv" / "7.pdf").write_bytes(b"%PDF-1.4 newer"))
        self.assertFalse(self.run_user(client))
        self.assertFalse((self.data / "page-content" / "7.json").exists())

    def test_edits_saved_during_a_remake_win(self):
        self.run_user(FakeClient())
        self.edit(headline="First edit")
        client = FakeClient(during=lambda: self.edit(headline="Second edit", at="2026-11-07T12:05:00Z"))
        self.assertFalse(self.run_user(client, force=True))
        self.assertEqual(self.saved()["content"]["headline"], "Second edit")

    def test_refusal_raises_and_writes_nothing(self):
        with self.assertRaises(ValueError):
            self.run_user(FakeClient(refuse=True))
        self.assertFalse((self.data / "page-content" / "7.json").exists())


if __name__ == "__main__":
    unittest.main()
