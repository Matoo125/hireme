// Job feeds: bun test (in web/). Which jobs a feed lists, its XML, and the
// token storage in lib/feed.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  FEED_LIMIT, feedItems, findFeed, newToken, readFeed, removeFeed, renderFeed, writeFeed,
} from "../lib/feed";

const TODAY = "2026-11-01";

function job(id: string, extra: Record<string, string> = {}): Record<string, string> {
  return { id, title: `Job ${id}`, organization_name: "Org", link: `https://example.org/${id}`,
    first_seen: "2026-10-30", europe: "yes", europe_reason: "", ...extra };
}

describe("feedItems", () => {
  const scores = {
    a: { score: 80, reason: "A" }, b: { score: 60, reason: "B" }, c: { score: 59, reason: "C" },
    d: { score: 90, reason: "D" }, e: { score: 95, reason: "E" }, f: { score: 70, reason: "F" },
    g: { score: 99, reason: "G" },
  };
  const rows = [
    job("a"),
    job("b", { first_seen: "2026-10-31" }),
    job("c"),                                     // under the threshold
    job("d", { europe: "no" }),                   // not open to Europe
    job("e", { first_seen: "2026-09-01" }),       // older than 30 days
    job("f", { europe: "unclear" }),
    job("g", { first_seen: "" }),                 // never seen: left out
    job("h"),                                     // unscored
  ];

  test("keeps new, well-fitting jobs open to Europe, newest then best first", () => {
    const ids = feedItems(rows, scores, 60, TODAY).map((i) => i.row.id);
    expect(ids).toEqual(["b", "a", "f"]);
  });

  test("respects the threshold", () => {
    expect(feedItems(rows, scores, 75, TODAY).map((i) => i.row.id)).toEqual(["a"]);
  });

  test("caps the number of items", () => {
    const many = Array.from({ length: FEED_LIMIT + 5 }, (_, n) => job(`m${n}`));
    const manyScores = Object.fromEntries(many.map((r) => [r.id, { score: 70, reason: "" }]));
    expect(feedItems(many, manyScores, 60, TODAY)).toHaveLength(FEED_LIMIT);
  });
});

describe("renderFeed", () => {
  const items = [
    { row: job("x", { title: "Ops <lead> & co", close_date: "2026-11-20", salary_range: "$80k" }),
      fit: { score: 82, reason: "Matches \"ops\" work" } },
    { row: job("y", { link: "javascript:alert(1)", europe: "unclear", europe_reason: "No location stated" }),
      fit: { score: 61, reason: "Some overlap" } },
  ];
  const xml = renderFeed(items, "https://hireme.sk", 60);

  test("escapes text", () => {
    expect(xml).toContain("<title>[82] Ops &lt;lead&gt; &amp; co — Org</title>");
    expect(xml).toContain("Matches &quot;ops&quot; work");
    expect(xml).not.toContain("<lead>");
  });

  test("links only to http(s), else to the site", () => {
    expect(xml).toContain("<link>https://example.org/x</link>");
    expect(xml).not.toContain("javascript:");
    expect(xml.match(/<link>https:\/\/hireme\.sk<\/link>/g)).toHaveLength(2);
  });

  test("has stable guids, dates and details", () => {
    expect(xml).toContain('<guid isPermaLink="false">hireme-x</guid>');
    expect(xml).toContain("<pubDate>Fri, 30 Oct 2026 06:00:00 GMT</pubDate>");
    expect(xml).toContain("Closes 2026-11-20.");
    expect(xml).toContain("Salary: $80k");
    expect(xml).toContain("Europe unclear: No location stated");
  });

  test("is well-formed", () => {
    const doc = new DOMParserLite(xml);
    expect(doc.balanced).toBe(true);
  });
});

// Enough of a check for "every tag closes in order", without a dependency.
class DOMParserLite {
  balanced: boolean;
  constructor(xml: string) {
    const stack: string[] = [];
    let ok = true;
    for (const [, close, name, self] of xml.replace(/<\?[^>]*\?>/g, "").matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
      if (self) continue;
      if (close) ok &&= stack.pop() === name;
      else stack.push(name);
    }
    this.balanced = ok && stack.length === 0;
  }
}

describe("storage", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), "hireme-feed-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test("tokens are 32 hex characters and differ", () => {
    const a = newToken();
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(newToken()).not.toBe(a);
  });

  test("finds a feed by its token, and not after removal", async () => {
    expect(await findFeed(dir, newToken())).toBeNull(); // no feeds dir yet
    const feed = { token: newToken(), minFit: 60, createdAt: "2026-11-01T00:00:00Z" };
    await writeFeed(dir, 7, feed);
    await writeFeed(dir, 8, { ...feed, token: newToken() });
    expect(await readFeed(dir, 7)).toEqual(feed);
    expect(await findFeed(dir, feed.token)).toEqual({ userId: 7, feed });
    expect(await findFeed(dir, newToken())).toBeNull();
    expect(await findFeed(dir, "../pages/7")).toBeNull();
    await removeFeed(dir, 7);
    expect(await findFeed(dir, feed.token)).toBeNull();
    expect(await readFeed(dir, 7)).toBeNull();
  });
});
