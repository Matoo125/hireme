// Portfolio pages: bun test (in web/). Slugs, host parsing, rendering and the
// storage lookups in lib/pages.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  cleanEdit, cvHash, findPage, renderNotFound, renderPage, removeContent, slugFromHost, slugOwner,
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

  test("shows the open-to-work badge only when the user turns it on", () => {
    expect(html).not.toContain("Open to work");
    expect(renderPage(page, "jane", true)).toContain('<p class="open-to-work">Open to work</p>');
  });

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

  test("declares the content's language, and only a well-formed one", () => {
    expect(html).toContain('<html lang="en">');
    const sk = renderPage({ ...page, content: { ...page.content, language: "sk" } }, "jane");
    expect(sk).toContain('<html lang="sk">');
    const bad = renderPage({ ...page, content: { ...page.content, language: '"><script>' } }, "jane");
    expect(bad).toContain('<html lang="en">');
  });

  test("an edited page says when it was edited, not that it was generated", () => {
    const edited = renderPage({ ...page, edited: true, editedAt: "2026-11-07T12:00:00Z" }, "jane");
    expect(edited).toContain("last updated 2026-11-07");
    expect(edited).not.toContain("generated from a CV");
  });

  test("the not-found page has no scripts either", () => {
    expect(renderNotFound()).not.toContain("<script");
  });
});

describe("cleanEdit", () => {
  const ok = (body: unknown) => {
    const result = cleanEdit(body);
    if ("error" in result) throw new Error(result.error);
    return result.content;
  };
  const problem = (body: unknown) => {
    const result = cleanEdit(body);
    return "error" in result ? result.error : null;
  };

  test("keeps a well-formed page as it is", () => {
    const clean = {
      ...page.content, language: "sk",
      projects: page.content.projects.slice(0, 1), links: page.content.links.slice(0, 1),
    };
    expect(ok(clean)).toEqual(clean);
  });

  test("trims text and drops empty entries", () => {
    const content = ok({
      name: "  Jane  ", skills: ["Python", " ", ""],
      experience: [{ title: "Engineer", bullets: ["Did it", "  "] }, { title: "", organization: "", bullets: [] }],
      education: [{ school: "", degree: "" }],
      links: [{ label: "", url: "" }, { label: "", url: "https://example.org/me" }],
    });
    expect(content.name).toBe("Jane");
    expect(content.skills).toEqual(["Python"]);
    expect(content.experience).toEqual([{ title: "Engineer", organization: "", period: "", location: "", bullets: ["Did it"] }]);
    expect(content.education).toEqual([]);
    expect(content.links).toEqual([{ label: "example.org", url: "https://example.org/me" }]);
  });

  test("completes addresses typed without https://", () => {
    const content = ok({ name: "Jane", links: [{ label: "LinkedIn", url: "linkedin.com/in/jane" }],
      projects: [{ title: "P", url: "www.example.org/p?x=1" }] });
    expect(content.links[0].url).toBe("https://linkedin.com/in/jane");
    expect(content.projects[0].url).toBe("https://www.example.org/p?x=1");
  });

  test("refuses links that aren't web addresses", () => {
    expect(problem({ name: "Jane", links: [{ label: "x", url: "not a link" }] })).toContain("Link 1");
    expect(problem({ name: "Jane", links: [{ label: "x", url: "javascript:alert(1)" }] })).toContain("Link 1");
    expect(problem({ name: "Jane", projects: [{ title: "P", url: "data:text/html,hi" }] })).toContain("Project 1");
  });

  test("refuses a missing name, untitled roles, wrong types and oversized text", () => {
    expect(problem({ name: " " })).toBe("Name can't be empty");
    expect(problem(null)).not.toBeNull();
    expect(problem({ name: "Jane", experience: [{ organization: "Acme" }] })).toBe("Experience 1 needs a title");
    expect(problem({ name: "Jane", skills: "Python" })).toBe("Skills must be a list");
    expect(problem({ name: "Jane", summary: "x".repeat(3001) })).toContain("too long");
    expect(problem({ name: "Jane", skills: Array(81).fill("x") })).toContain("too many");
  });

  test("keeps only the fields a page shows", () => {
    const content = ok({ name: "Jane", email: "jane@example.com", experience: [{ title: "E", secret: 1 }] }) as any;
    expect(content.email).toBeUndefined();
    expect(content.experience[0].secret).toBeUndefined();
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
    await Bun.write(path.join(dir, "cv", "1.pdf"), "%PDF-1.4 jane");
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

  test("findPage never serves a page whose CV is gone", async () => {
    await unlink(path.join(dir, "cv", "1.pdf"));
    expect(await findPage(dir, "jane")).toBeNull();
    await Bun.write(path.join(dir, "cv", "1.pdf"), "%PDF-1.4 jane");
    expect((await findPage(dir, "jane"))?.userId).toBe(1);
  });

  test("removeContent takes a page down without touching its settings", async () => {
    await removeContent(dir, 1);
    expect(await findPage(dir, "jane")).toBeNull();
    expect(await slugOwner(dir, "jane")).toBe(1);
  });
});
