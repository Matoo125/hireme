// Opt-in portfolio pages: each user who turns one on gets a public page at
// <slug>.<PAGES_DOMAIN>, built from their CV. pages_cv.py writes the content
// (data/page-content/<id>.json), which the user can then edit; this module
// keeps the user's settings (data/pages/<id>.json), checks slugs and edits,
// and renders the HTML.

import { readdir, unlink } from "fs/promises";
import path from "path";

export interface PageSettings {
  enabled: boolean;
  slug: string;
  updatedAt: string;
}

// What pages_cv.py extracts from a CV. Deliberately no contact details.
export interface PageContent {
  cv: string; // sha256 of the CV the content was made from
  model: string;
  version?: number;
  generatedAt: string;
  // Set once the user saves the page editor: pages_cv.py then leaves the
  // content alone until they ask for it to be remade from the CV.
  edited?: boolean;
  editedAt?: string;
  content: {
    name: string;
    language?: string; // BCP 47, the CV's language
    headline: string;
    summary: string;
    skills: string[];
    experience: { title: string; organization: string; period: string; location: string; bullets: string[] }[];
    education: { school: string; degree: string; period: string }[];
    projects: { title: string; description: string; url: string }[];
    links: { label: string; url: string }[];
  };
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
// Names the site itself uses, so no one can take them as a subdomain.
const RESERVED_SLUGS = new Set([
  "www", "api", "admin", "app", "auth", "mail", "smtp", "ftp", "static",
  "assets", "cdn", "status", "hireme", "altfresh",
]);

/** Why `slug` can't be used, or null if it can. */
export function slugProblem(slug: string): string | null {
  if (!SLUG_PATTERN.test(slug)) {
    return "Use 3-40 letters, digits or hyphens, starting and ending with a letter or digit";
  }
  if (slug.includes("--")) return "Use single hyphens";
  if (RESERVED_SLUGS.has(slug)) return "That name is reserved";
  return null;
}

/** The page slug a Host header names, or null if it isn't a page subdomain. */
export function slugFromHost(host: string | null, domain: string): string | null {
  if (!host) return null;
  const name = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${domain}`;
  if (!name.endsWith(suffix)) return null;
  const slug = name.slice(0, -suffix.length);
  return slug && !slug.includes(".") ? slug : null;
}

/** sha256 hex of the CV bytes, the key that ties content to the CV it came from. */
export function cvHash(pdf: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(pdf);
  return hasher.digest("hex");
}

function settingsPath(dir: string, userId: number): string {
  return path.join(dir, "pages", `${userId}.json`);
}

function contentPath(dir: string, userId: number): string {
  return path.join(dir, "page-content", `${userId}.json`);
}

export async function readSettings(dir: string, userId: number): Promise<PageSettings | null> {
  const file = Bun.file(settingsPath(dir, userId));
  return (await file.exists()) ? file.json() : null;
}

export async function writeSettings(dir: string, userId: number, settings: PageSettings): Promise<void> {
  await Bun.write(settingsPath(dir, userId), JSON.stringify(settings, null, 1));
}

export async function readContent(dir: string, userId: number): Promise<PageContent | null> {
  const file = Bun.file(contentPath(dir, userId));
  return (await file.exists()) ? file.json() : null;
}

async function allSettings(dir: string): Promise<{ userId: number; settings: PageSettings }[]> {
  const files = await readdir(path.join(dir, "pages")).catch(() => [] as string[]);
  const out = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const userId = Number(file.slice(0, -".json".length));
    const settings = await readSettings(dir, userId);
    if (settings) out.push({ userId, settings });
  }
  return out;
}

export async function removeContent(dir: string, userId: number): Promise<void> {
  await unlink(contentPath(dir, userId)).catch(() => {});
}

/** The user who holds this slug (even with their page off), or null if it's free. */
export async function slugOwner(dir: string, slug: string): Promise<number | null> {
  const match = (await allSettings(dir)).find((s) => s.settings.slug === slug);
  return match ? match.userId : null;
}

export async function writeContent(dir: string, userId: number, page: PageContent): Promise<void> {
  await Bun.write(contentPath(dir, userId), JSON.stringify(page, null, 1));
}

/** The enabled page with this slug, with its owner's id, or null. A page whose
 * CV was deleted is never served, even if its content outlived the CV. */
export async function findPage(
  dir: string, slug: string
): Promise<{ userId: number; settings: PageSettings; content: PageContent } | null> {
  const match = (await allSettings(dir)).find((s) => s.settings.enabled && s.settings.slug === slug);
  if (!match) return null;
  if (!(await Bun.file(path.join(dir, "cv", `${match.userId}.pdf`)).exists())) return null;
  const content = await readContent(dir, match.userId);
  return content ? { ...match, content } : null;
}

// ── Edits ────────────────────────────────────────────────────────────────────

type Content = PageContent["content"];

// Generous for a one-page portfolio, small enough that a page stays a page.
const LIMITS = { short: 200, long: 3000, items: 40, bullets: 30 };

class EditError extends Error {}

function text(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new EditError(`${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new EditError(`${field} is too long (at most ${max} characters)`);
  return trimmed;
}

function list(value: unknown, field: string, max = LIMITS.items): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new EditError(`${field} must be a list`);
  if (value.length > max) throw new EditError(`${field} has too many entries (at most ${max})`);
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EditError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

// "linkedin.com/in/jane": a bare address, typed without https://.
const BARE_ADDRESS = /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i;

/** A link field: empty, or an http(s) URL. A bare address gets https://. */
function link(value: unknown, field: string, required = false): string {
  let raw = text(value, field, 2000);
  if (!raw && !required) return "";
  if (BARE_ADDRESS.test(raw)) raw = `https://${raw}`;
  if (!webUrl(raw)) throw new EditError(`${field} must be a web address starting with https:// or http://`);
  return raw;
}

/**
 * The page content from an edit, trimmed, with empty entries dropped; or why it
 * can't be saved. The user may write what they like (their own contact details
 * included), but only http(s) links and only the fields a page shows.
 */
export function cleanEdit(body: unknown): { content: Content } | { error: string } {
  try {
    const c = record(body, "content");
    const name = text(c.name, "Name", LIMITS.short);
    if (!name) throw new EditError("Name can't be empty");
    const language = text(c.language, "Language", 35);
    const content: Content = {
      name,
      language: LANG_PATTERN.test(language) ? language : "",
      headline: text(c.headline, "Headline", LIMITS.short),
      summary: text(c.summary, "Summary", LIMITS.long),
      skills: list(c.skills, "Skills", 80).map((s) => text(s, "A skill", 80)).filter(Boolean),
      experience: list(c.experience, "Experience").map((raw, i) => {
        const e = record(raw, `Experience ${i + 1}`);
        const where = `Experience ${i + 1}`;
        return {
          title: text(e.title, `${where}: title`, LIMITS.short),
          organization: text(e.organization, `${where}: organization`, LIMITS.short),
          period: text(e.period, `${where}: period`, 80),
          location: text(e.location, `${where}: location`, LIMITS.short),
          bullets: list(e.bullets, `${where}: bullets`, LIMITS.bullets)
            .map((b) => text(b, `${where}: a bullet`, 1000)).filter(Boolean),
        };
      }).filter((e) => e.title || e.organization || e.bullets.length),
      education: list(c.education, "Education").map((raw, i) => {
        const e = record(raw, `Education ${i + 1}`);
        const where = `Education ${i + 1}`;
        return {
          school: text(e.school, `${where}: school`, LIMITS.short),
          degree: text(e.degree, `${where}: degree`, LIMITS.short),
          period: text(e.period, `${where}: period`, 80),
        };
      }).filter((e) => e.school || e.degree),
      projects: list(c.projects, "Projects").map((raw, i) => {
        const p = record(raw, `Project ${i + 1}`);
        const where = `Project ${i + 1}`;
        return {
          title: text(p.title, `${where}: title`, LIMITS.short),
          description: text(p.description, `${where}: description`, LIMITS.long),
          url: link(p.url, `${where}: link`),
        };
      }).filter((p) => p.title || p.description),
      links: list(c.links, "Links", 20).map((raw, i) => {
        const l = record(raw, `Link ${i + 1}`);
        const label = text(l.label, `Link ${i + 1}: label`, 80);
        const url = text(l.url, `Link ${i + 1}: address`, 2000);
        return { label, url: label || url ? link(url, `Link ${i + 1}: address`, true) : "" };
      }).filter((l) => l.url).map((l) => ({ label: l.label || new URL(l.url).hostname, url: l.url })),
    };
    for (const [i, e] of content.experience.entries()) {
      if (!e.title) throw new EditError(`Experience ${i + 1} needs a title`);
    }
    for (const [i, p] of content.projects.entries()) {
      if (!p.title) throw new EditError(`Project ${i + 1} needs a title`);
    }
    return { content };
  } catch (err) {
    if (err instanceof EditError) return { error: err.message };
    throw err;
  }
}

/** An https or http link, or null: page links must not run script or open files. */
function webUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

// A language tag safe to put in lang="": "sk", "en-GB", "sr-Latn".
const LANG_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
  :root { color-scheme: light dark; --bg: #fdfcf9; --fg: #1d1d1b; --muted: #5d5b55; --line: #dcd8cf; --accent: #8a4b1f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161513; --fg: #ece9e1; --muted: #a6a195; --line: #3a3832; --accent: #e0a070; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 system-ui, sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 3rem 1rem 4rem; }
  h1 { font-size: 2.2rem; margin: 0 0 .25rem; line-height: 1.2; }
  h2 { font-size: 1.2rem; margin: 2.5rem 0 1rem; padding-bottom: .4rem; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1rem; margin: 0; }
  p, li { color: var(--fg); }
  .headline { color: var(--muted); font-size: 1.1rem; margin: 0 0 1rem; }
  .meta { color: var(--muted); font-size: .9rem; }
  .links a, .item a { color: var(--accent); margin-right: 1rem; }
  .item { margin-bottom: 1.5rem; }
  ul { padding-left: 1.2rem; margin: .4rem 0 0; }
  .skills { display: flex; flex-wrap: wrap; gap: .4rem; list-style: none; padding: 0; }
  .skills li { border: 1px solid var(--line); border-radius: 999px; padding: .1rem .7rem; font-size: .9rem; }
  footer { margin-top: 3rem; color: var(--muted); font-size: .85rem; }
`;

/** The full HTML document for a page. Every value is escaped, every link checked. */
export function renderPage(page: PageContent, slug: string): string {
  const c = page.content;
  const links = c.links.flatMap((l) => {
    const url = webUrl(l.url);
    return url ? [`<a href="${esc(url)}" rel="me noopener nofollow">${esc(l.label)}</a>`] : [];
  });
  const section = (title: string, body: string) => (body ? `<h2>${esc(title)}</h2>\n${body}` : "");

  const experience = c.experience.map((e) => `
    <div class="item">
      <h3>${esc(e.title)}</h3>
      <div class="meta">${esc([e.organization, e.location, e.period].filter(Boolean).join(" · "))}</div>
      ${e.bullets.length ? `<ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    </div>`).join("");

  const education = c.education.map((e) => `
    <div class="item">
      <h3>${esc(e.degree || e.school)}</h3>
      <div class="meta">${esc([e.school && e.degree ? e.school : "", e.period].filter(Boolean).join(" · "))}</div>
    </div>`).join("");

  const projects = c.projects.map((p) => {
    const url = webUrl(p.url);
    return `
    <div class="item">
      <h3>${url ? `<a href="${esc(url)}" rel="noopener nofollow">${esc(p.title)}</a>` : esc(p.title)}</h3>
      <p>${esc(p.description)}</p>
    </div>`;
  }).join("");

  const skills = c.skills.length
    ? `<ul class="skills">${c.skills.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
    : "";

  return `<!doctype html>
<html lang="${LANG_PATTERN.test(c.language ?? "") ? c.language : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.name)}</title>
<meta name="description" content="${esc(c.headline)}">
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${esc(c.name)}</h1>
  ${c.headline ? `<p class="headline">${esc(c.headline)}</p>` : ""}
  ${links.length ? `<p class="links">${links.join("")}</p>` : ""}
  ${c.summary ? `<p>${esc(c.summary)}</p>` : ""}
  ${section("Experience", experience)}
  ${section("Projects", projects)}
  ${section("Education", education)}
  ${section("Skills", skills)}
  <footer>Published at ${esc(slug)} on hireme.sk · ${page.edited ? "" : "generated from a CV, "}last updated ${esc((page.editedAt ?? page.generatedAt).slice(0, 10))}</footer>
</main>
</body>
</html>
`;
}

/** The page for a slug that isn't published (or is switched off). */
export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title>
<style>${STYLE}</style></head>
<body><main><h1>Not found</h1><p class="headline">No page is published at this address.</p></main></body>
</html>
`;
}
