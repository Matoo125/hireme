"""Tests for scrapers.normalize and scrapers.dedupe. Run: python3 -m unittest"""

import unittest

from scrapers.dedupe import merge_duplicates, stable_id
from scrapers.normalize import normalize_jobs, strip_trailing_acronym


def job(source, title, org, link, tags="", **extra):
    return {"source": source, "title": title, "organization_name": org, "link": link, "tags": tags, **extra}


class NormalizeTags(unittest.TestCase):
    def test_spellings_become_one(self):
        jobs, summary = normalize_jobs([
            job("A", "t1", "O", "l1", "Full-Time; AI Safety & Policy"),
            job("B", "t2", "O", "l2", "Full-time; AI safety & policy"),
            job("C", "t3", "O", "l3", "Full Time"),
        ])
        self.assertEqual([j["tags"] for j in jobs], [
            "Full-time; AI safety & policy",
            "Full-time; AI safety & policy",
            "Full-time",
        ])
        self.assertEqual(summary["tag_spellings_merged"], 3)

    def test_choice_prefers_fewest_capitals_not_majority(self):
        # 235 vs 164 on the live data: the choice must not flip with the counts.
        tags = ["Undergraduate Degree or Less"] * 3 + ["Undergraduate degree or less"]
        jobs, _ = normalize_jobs([job("A", f"t{i}", "O", f"l{i}", t) for i, t in enumerate(tags)])
        self.assertEqual({j["tags"] for j in jobs}, {"Undergraduate degree or less"})

    def test_duplicate_tags_within_a_job_collapse(self):
        jobs, _ = normalize_jobs([job("A", "t", "O", "l", "Remote; remote; Remote, Global")])
        self.assertEqual(jobs[0]["tags"], "Remote; Remote, Global")

    def test_other_fields_untouched(self):
        original = job("A", "Title", "Org", "l", "x", salary_range="$1", description="Desc")
        cleaned, _ = normalize_jobs([original])
        self.assertEqual({k: v for k, v in cleaned[0].items() if k != "tags"},
                         {k: v for k, v in original.items() if k != "tags"})


class NormalizeOrgs(unittest.TestCase):
    def test_trailing_acronym(self):
        self.assertEqual(strip_trailing_acronym("Centre for Effective Altruism (CEA)"), "Centre for Effective Altruism")
        self.assertEqual(strip_trailing_acronym("80,000 Hours (80K)"), "80,000 Hours")
        self.assertEqual(strip_trailing_acronym("Summit (2026)"), "Summit (2026)")
        self.assertEqual(strip_trailing_acronym("GovAI (Centre for the Governance of AI)"),
                         "GovAI (Centre for the Governance of AI)")

    def test_variants_become_one(self):
        jobs, summary = normalize_jobs([
            job("A", "t1", "FAR AI", "l1"),
            job("B", "t2", "FAR.AI", "l2"),
            job("C", "t3", "Lead Exposure Elimination Project (LEEP)", "l3"),
            job("D", "t4", "Lead Exposure Elimination Project", "l4"),
        ])
        self.assertEqual([j["organization_name"] for j in jobs], [
            "FAR.AI", "FAR.AI", "Lead Exposure Elimination Project", "Lead Exposure Elimination Project",
        ])
        self.assertEqual(summary["org_names_changed"], 2)


class Dedupe(unittest.TestCase):
    def test_same_link_merges(self):
        merged = merge_duplicates([
            job("80,000 Hours", "Engineer", "Org", "https://x.org/job?utm_source=80k", "a"),
            job("Probably Good", "Engineer", "Org", "https://x.org/job/", "b"),
        ])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["source"], "80,000 Hours; Probably Good")
        self.assertEqual(merged[0]["tags"], "a; b")

    def test_cross_board_org_title_merges(self):
        merged = merge_duplicates([
            job("80,000 Hours", "Full-Stack Engineer", "HIA", "https://hia.org/full-stack-jd"),
            job("Probably Good", "Full-Stack Engineer", "HIA", "https://hia.notion.site/full-stack-jd"),
        ])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["source"], "80,000 Hours; Probably Good")

    def test_same_board_org_title_stays_apart(self):
        merged = merge_duplicates([
            job("EA Opportunities Board", "Program Manager", "GiveDirectly", "https://gh.io/jobs/1", salary_range="$75,100"),
            job("EA Opportunities Board", "Program Manager", "GiveDirectly", "https://gh.io/jobs/2", salary_range="$67,400"),
        ])
        self.assertEqual(len(merged), 2)

    def test_matches_chain(self):
        # A~B by link, B~C by org+title on another board: one job.
        merged = merge_duplicates([
            job("80,000 Hours", "ML Engineer", "Gray Swan", "https://ashby/1?utm=80k"),
            job("EA Opportunities Board", "ML Engineer", "Gray Swan", "https://ashby/1"),
            job("Probably Good", "ML Engineer", "Gray Swan", "https://grayswan.ai/careers?id=1"),
        ])
        self.assertEqual(len(merged), 1)

    def test_merged_row_keeps_first_listings_id(self):
        first = job("80,000 Hours", "Head of Marketing", "HIA", "https://hia.org/marketing-jd")
        merged = merge_duplicates([
            first,
            job("Probably Good", "Head of Marketing", "HIA", "https://hia.notion.site/marketing-jd"),
        ])
        self.assertEqual(merged[0]["id"], stable_id(first))
        self.assertEqual(merged[0]["link"], first["link"])

    def test_order_follows_first_listing(self):
        merged = merge_duplicates([
            job("A", "One", "O", "https://1"),
            job("A", "Two", "O", "https://2"),
            job("B", "One", "O", "https://1b"),
        ])
        self.assertEqual([m["title"] for m in merged], ["One", "Two"])


if __name__ == "__main__":
    unittest.main()
