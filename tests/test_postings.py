"""Tests for scrapers.postings, with a stand-in HTTP session. Run: python3 -m unittest"""

import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scrapers import postings

PUBLIC = "93.184.215.14"


def fake_dns(hosts):
    """getaddrinfo answering from {host: ip}."""
    def getaddrinfo(host, port, *args, **kwargs):
        if host not in hosts:
            raise socket.gaierror("unknown host")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (hosts[host], port))]
    return mock.patch("socket.getaddrinfo", getaddrinfo)


class FakeResponse:
    def __init__(self, status=200, body="", content_type="text/html; charset=utf-8", location=None):
        self.status_code = status
        self.headers = {"content-type": content_type}
        if location:
            self.headers["location"] = location
        self.is_redirect = location is not None
        self.encoding = "utf-8"
        self.body = body.encode("utf-8")

    def iter_content(self, size):
        yield self.body

    def close(self):
        pass


class FakeSession:
    def __init__(self, pages):
        self.pages = pages
        self.urls = []

    def get(self, url, **kwargs):
        self.urls.append(url)
        return self.pages[url]


LONG = "Responsibilities include research. " * 30


class HtmlToText(unittest.TestCase):
    def test_keeps_the_posting_drops_the_chrome(self):
        page = (f"<html><head><title>T</title><style>p{{}}</style></head><body><nav>Menu</nav>"
                f"<h1>Researcher</h1><p>Remote, &amp; open to Europe.</p><script>var x=1</script>"
                f"<ul><li>One</li><li>Two</li></ul><footer>Cookies</footer></body></html>")
        text = postings.html_to_text(page)
        self.assertEqual(text, "Researcher\n\nRemote, & open to Europe.\n\nOne\n\nTwo")

    def test_job_posting_description_when_longer(self):
        ld = {"@context": "https://schema.org", "@graph": [{"@type": "JobPosting",
              "description": "&lt;p&gt;US work authorization required.&lt;/p&gt;&lt;p&gt;" + LONG + "&lt;/p&gt;"}]}
        page = f'<html><body><div id="app">Loading</div><script type="application/ld+json">{json.dumps(ld)}</script></body></html>'
        text = postings.html_to_text(page)
        self.assertTrue(text.startswith("US work authorization required.\n\nResponsibilities"), text[:80])

    def test_broken_json_ld_ignored(self):
        self.assertEqual(postings.html_to_text('<p>Hi</p><script type="application/ld+json">{nope</script>'), "Hi")


class Fetching(unittest.TestCase):
    def test_google_doc_as_plain_text(self):
        self.assertEqual(postings.fetch_url("https://docs.google.com/document/d/abc-1_x/edit?usp=sharing"),
                         "https://docs.google.com/document/d/abc-1_x/export?format=txt")
        self.assertEqual(postings.fetch_url("https://example.org/job"), "https://example.org/job")

    def test_only_public_addresses(self):
        with fake_dns({"jobs.example": PUBLIC, "intranet": "10.0.0.5", "local": "127.0.0.1", "v6": "::1"}):
            postings.check_public("https://jobs.example/1")
            for url in ["http://intranet/", "http://local:4020/api", "http://v6/", "file:///etc/passwd", "ftp://jobs.example/"]:
                with self.assertRaises(postings.FetchError, msg=url):
                    postings.check_public(url)

    def test_redirects_followed_but_checked(self):
        session = FakeSession({
            "https://jobs.example/a": FakeResponse(302, location="/b"),
            "https://jobs.example/b": FakeResponse(200, f"<p>{LONG}</p>"),
            "https://jobs.example/c": FakeResponse(302, location="http://local/admin"),
        })
        with fake_dns({"jobs.example": PUBLIC, "local": "127.0.0.1"}):
            record = postings.fetch_posting("https://jobs.example/a", session, "2026-10-26")
            self.assertEqual((record["status"], record["text"]), (200, LONG.strip()))
            record = postings.fetch_posting("https://jobs.example/c", session, "2026-10-26")
        self.assertIn("not a public address", record["status"])
        self.assertNotIn("http://local/admin", session.urls)

    def test_errors_and_non_text_kept_as_status(self):
        session = FakeSession({
            "https://jobs.example/gone": FakeResponse(404, "nope"),
            "https://jobs.example/pdf": FakeResponse(200, "%PDF", content_type="application/pdf"),
        })
        with fake_dns({"jobs.example": PUBLIC}):
            self.assertEqual(postings.fetch_posting("https://jobs.example/gone", session, "d")["status"], 404)
            self.assertEqual(postings.fetch_posting("https://jobs.example/pdf", session, "d")["status"],
                             "unsupported: application/pdf")


class FetchMissing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "postings"
        self.jobs = [{"id": "a", "link": "https://jobs.example/a"}, {"id": "b", "link": "https://jobs.example/b"}]
        self.session = FakeSession({
            "https://jobs.example/a": FakeResponse(200, f"<p>{LONG}</p>"),
            "https://jobs.example/b": FakeResponse(200, "<p>Sign in to see this job</p>"),
        })
        self.dns = fake_dns({"jobs.example": PUBLIC})
        self.dns.start()

    def tearDown(self):
        self.dns.stop()
        self.tmp.cleanup()

    def test_fetches_once_and_retries_unread_after_a_week(self):
        self.assertEqual(postings.fetch_missing(self.jobs, self.dir, "2026-10-26", session=self.session), (2, 1))
        self.assertEqual(postings.text_of(self.dir, "a"), LONG.strip())
        self.assertEqual(postings.text_of(self.dir, "b"), "")  # too short to be the posting
        self.assertEqual(postings.load(self.dir, "b")["text"], "Sign in to see this job")
        self.assertEqual(postings.fetch_missing(self.jobs, self.dir, "2026-10-30", session=self.session), (0, 0))
        self.assertEqual(postings.fetch_missing(self.jobs, self.dir, "2026-11-02", session=self.session), (1, 0))
        self.assertEqual(self.session.urls.count("https://jobs.example/b"), 2)
        self.assertEqual(self.session.urls.count("https://jobs.example/a"), 1)


if __name__ == "__main__":
    unittest.main()
