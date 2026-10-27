// Portfolio pages: bun test (in web/). Slugs, host parsing, rendering and the
// storage lookups in lib/pages.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  cvHash, findPage, renderNotFound, renderPage, removeContent, slugFromHost, slugOwner,
  slugProblem, writeSettings, type PageContent,
} from "../lib/pages";

const DOMAIN = "hireme.sk";

const page: PageContent = {
  cv: "abc",
  model: "claude-haiku-5-5",
  generatedAt: "2026-10-27T10:00:00Z",
  content: {
    name: "Jane <script>alert(1)</script>",
    headline: "Backend engineer",
    summary: "Builds \"data\" pipelines & tools.",
    skills: ["Python", "SQL"],
    experience: [{ title: "Engineer", organization: "Acme", period: "2020 - 2024", location: "Remote", bullets: ["Shipped it"] }],
    education: [{ school: "University", degree: "BSc", period: "2016 - 2019" }],
    projects: [
      { title: "Good", description: "Ships logs.", url: "https://example.com/log" },
      { title: "Bad", description: "Never linked.", url: "javascript:alert(2)" },
    ],
    links: [
      { label: "GitHub", url: "https://github.com/example" },
      { label: "Evil", url: "javascript:alert(3)" },
    ],
  },
};

describe("slugProblem", () => {
  test("accepts ordinary addresses", () => {
    expect(slugProblem("jane")).toBeNull();
    expect(slugProblem("jane-doe-2")).toBeNull();
  });

  test("rejects bad shapes", () => {
    for (const slug of ["ab", "-jane", "jane-", "Jane", "jane_doe", "jane--doe", "a.b", "x".repeat(41)]) {
      expect(slugProblem(slug)).not.toBeNull();
    }
  });

  test("rejects reserved names", () => {
    expect(slugProblem("www")).toBe("That name is reserved");
    expect(slugProblem("api")).toBe("That name is reserved");
  });
});

describe("slugFromHost", () => {
  test("reads the slug from a page subdomain", () => {
    expect(slugFromHost("jane.hireme.sk", DOMAIN)).toBe("jane");
    expect(slugFromHost("Jane.Hireme.SK", DOMAIN)).toBe("jane");
    expect(slugFromHost("jane.hireme.sk:4020", DOMAIN)).toBe("jane");
  });

  test("is null for the site itself and for other hosts", () => {
    expect(slugFromHost("hireme.sk", DOMAIN)).toBeNull();
    expect(slugFromHost("localhost:4020", DOMAIN)).toBeNull();
    expect(slugFromHost("evilhireme.sk", DOMAIN)).toBeNull();
    expect(slugFromHost("a.b.hireme.sk", DOMAIN)).toBeNull();
    expect(slugFromHost(null, DOMAIN)).toBeNull();
  });
});

describe("renderPage", () => {
  const html = renderPage(page, "jane");

  test("escapes every text value", () => {
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Jane &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Builds &quot;data&quot; pipelines &amp; tools.");
  });

  test("keeps http(s) links and drops script links", () => {
    expect(html).toContain('href="https://github.com/example"');
    expect(html).toContain('href="https://example.com/log"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Bad");
  });

  test("has no scripts and no external resources", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link\b/);
  });

  test("shows each section it has content for", () => {
    for (const heading of ["Experience", "Projects", "Education", "Skills"]) {
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
    expect(renderPage({ ...page, content: { ...page.content, skills: [], projects: [] } }, "jane"))
      .not.toContain("<h2>Skills</h2>");
  });

  test("says which address and date it was made for", () => {
    expect(html).toContain("Published at jane on hireme.sk");
    expect(html).toContain("last updated 2026-10-27");
  });

  test("the not-found page has no scripts either", () => {
    expect(renderNotFound()).not.toContain("<script");
  });
});

describe("cvHash", () => {
  test("is the sha256 hex of the bytes", () => {
    expect(cvHash(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("storage lookups", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hireme-pages-"));
    await mkdir(path.join(dir, "pages"), { recursive: true });
    await mkdir(path.join(dir, "page-content"), { recursive: true });
    await writeSettings(dir, 1, { enabled: true, slug: "jane", updatedAt: "" });
    await Bun.write(path.join(dir, "page-content", "1.json"), JSON.stringify(page));
    await writeSettings(dir, 2, { enabled: false, slug: "off-page", updatedAt: "" });
    await writeSettings(dir, 3, { enabled: true, slug: "no-content", updatedAt: "" });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("slugOwner finds the holder of an address, even when its page is off", async () => {
    expect(await slugOwner(dir, "jane")).toBe(1);
    expect(await slugOwner(dir, "off-page")).toBe(2);
    expect(await slugOwner(dir, "free")).toBeNull();
  });

  test("findPage serves only enabled pages that have content", async () => {
    expect((await findPage(dir, "jane"))?.userId).toBe(1);
    expect(await findPage(dir, "off-page")).toBeNull();
    expect(await findPage(dir, "no-content")).toBeNull();
    expect(await findPage(dir, "free")).toBeNull();
  });

  test("removeContent takes a page down without touching its settings", async () => {
    await removeContent(dir, 1);
    expect(await findPage(dir, "jane")).toBeNull();
    expect(await slugOwner(dir, "jane")).toBe(1);
  });
});
