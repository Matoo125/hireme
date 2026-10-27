// Minimal Bun server: serves the static frontend and a JSON API
// reading the jobs CSV produced by scrape_80000hours_jobs.py.

import path from "path";
import { mkdir, stat, unlink } from "fs/promises";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { fetchPage, FetchError } from "./lib/fetch-page";
import { parseRows } from "./lib/csv";
import { handleV1 } from "./lib/api-v1";
import {
  cvHash, findPage, readContent, readSettings, removeContent, renderNotFound, renderPage,
  slugFromHost, slugOwner, slugProblem, writeSettings, type PageSettings,
} from "./lib/pages";

const PORT = Number(process.env.PORT ?? 4020);
const ROOT = import.meta.dir;
const PUBLIC_DIR = path.join(ROOT, "public");
const CSV_PATH = process.env.JOBS_CSV ?? path.join(ROOT, "..", "jobs.csv");
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, "..", "data");
const CV_DIR = path.join(DATA_DIR, "cv");
const PREFS_DIR = path.join(DATA_DIR, "preferences");
const APPS_DIR = path.join(DATA_DIR, "applications");
const CUSTOM_JOBS_DIR = path.join(DATA_DIR, "custom-jobs");
// Written by fit_scores.py after each scrape; read-only here.
const FIT_DIR = process.env.FIT_DIR ?? path.join(DATA_DIR, "fit");
// Portfolio pages are served at <slug>.<PAGES_DOMAIN> (lib/pages.ts).
const PAGES_DOMAIN = (process.env.PAGES_DOMAIN ?? "hireme.sk").toLowerCase();

const MAX_CV_SIZE = 10 * 1024 * 1024; // 10 MB

// Hand corrections (scrapers/overrides.py): who may make them from the grid,
// and the files `python3 -m scrapers.overrides set` reads and writes.
const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number)
);
const REPO_DIR = path.join(ROOT, "..");
const OVERRIDES_PATH = process.env.OVERRIDES_PATH ?? path.join(REPO_DIR, "overrides.toml");
const SCRAPED_PATH = process.env.SCRAPED_JSON ?? path.join(REPO_DIR, "data", "scraped.json");
// Commit and push each correction (production), so the checkout stays clean
// for deploys.
const OVERRIDES_COMMIT = process.env.OVERRIDES_COMMIT === "1";

// ── JWT verification ─────────────────────────────────────────────────────────

const AUTH_ISSUER = (process.env.AUTH_ISSUER ?? "https://api.altfresh.sk").replace(/\/$/, "");
const jwks = createRemoteJWKSet(
  new URL(process.env.AUTH_JWKS_URL ?? `${AUTH_ISSUER}/auth/jwks`)
);

async function verifyToken(
  authorization: string | null
): Promise<{ id: number; username: string | null }> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new Error("unauthorized");
  const { payload } = await jwtVerify(token, jwks, { issuer: AUTH_ISSUER });
  return {
    id: Number(payload.sub),
    username: typeof payload.username === "string" ? payload.username : null,
  };
}

// ── Hand corrections ─────────────────────────────────────────────────────────

let overridesQueue: Promise<unknown> = Promise.resolve();

/** Run `scrapers.overrides set` for one job, one call at a time. */
function setOverrides(
  jobId: string,
  patch: Record<string, string | null>
): Promise<{ code: number; stdout: string; stderr: string }> {
  const run = async () => {
    const proc = Bun.spawn(
      [
        "python3", "-m", "scrapers.overrides", "set", jobId,
        "--jobs", CSV_PATH, "--overrides", OVERRIDES_PATH, "--scraped", SCRAPED_PATH,
        ...(OVERRIDES_COMMIT ? ["--commit"] : []),
      ],
      { cwd: REPO_DIR, stdin: new Blob([JSON.stringify(patch)]), stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };
  const result = overridesQueue.then(run, run);
  overridesQueue = result.catch(() => {});
  return result;
}

// ── Jobs data ────────────────────────────────────────────────────────────────

// jobs.csv parsed once and kept until its mtime or size changes (a scrape or a
// hand correction rewrites it). `version` doubles as the /api/v1 ETag.
let jobsCache: { version: string; rows: Record<string, string>[] } | null = null;

async function loadJobs(): Promise<{ version: string; rows: Record<string, string>[] }> {
  const info = await stat(CSV_PATH);
  const version = `${info.mtimeMs}-${info.size}`;
  if (jobsCache?.version !== version) {
    jobsCache = { version, rows: parseRows(await Bun.file(CSV_PATH).text()) };
  }
  return jobsCache;
}

/** When the last scrape finished: scrape_jobs.py writes data/scraped.json on
 *  every run, and nothing else does (rebuilds after corrections only read it). */
async function scrapedAt(): Promise<string | null> {
  try {
    return (await stat(SCRAPED_PATH)).mtime.toISOString();
  } catch {
    return null;
  }
}

// ── Public API rate limit ────────────────────────────────────────────────────

// Fixed one-minute window per client IP. The server only listens on localhost
// behind Caddy, so X-Forwarded-For is Caddy's and can be trusted.
const API_RATE_LIMIT = Number(process.env.API_RATE_LIMIT ?? 60);
const apiHits = new Map<string, { windowStart: number; count: number }>();

/** Seconds to wait if this request is over the limit, else null. */
function rateLimited(ip: string): number | null {
  const now = Date.now();
  let hit = apiHits.get(ip);
  if (!hit || now - hit.windowStart >= 60_000) {
    if (apiHits.size > 10_000) {
      for (const [key, h] of apiHits) if (now - h.windowStart >= 60_000) apiHits.delete(key);
    }
    hit = { windowStart: now, count: 0 };
    apiHits.set(ip, hit);
  }
  hit.count++;
  return hit.count > API_RATE_LIMIT ? Math.ceil((hit.windowStart + 60_000 - now) / 1000) : null;
}

const API_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "If-None-Match",
  "Access-Control-Expose-Headers": "ETag, Retry-After",
};

// ── CV helpers ───────────────────────────────────────────────────────────────

function cvPdfPath(userId: number): string {
  return path.join(CV_DIR, `${userId}.pdf`);
}

function cvMetaPath(userId: number): string {
  return path.join(CV_DIR, `${userId}.json`);
}

interface CvMeta {
  filename: string;
  size: number;
  uploadedAt: string;
}

async function readCvMeta(userId: number): Promise<CvMeta | null> {
  const file = Bun.file(cvMetaPath(userId));
  if (!(await file.exists())) return null;
  return file.json();
}

// ── Portfolio page helpers ───────────────────────────────────────────────────

// pages_cv.py makes one user's content at a time. A CV uploaded while a run is
// going asks for another run when it finishes, so the content never stays
// made from the old CV.
const pageJobs = new Set<number>();
const pageRerun = new Set<number>();

function startPageContent(userId: number): void {
  if (pageJobs.has(userId)) {
    pageRerun.add(userId);
    return;
  }
  pageJobs.add(userId);
  const finish = () => {
    pageJobs.delete(userId);
    if (pageRerun.delete(userId)) startPageContent(userId);
  };
  try {
    const proc = Bun.spawn(
      ["python3", "pages_cv.py", "--user", String(userId), "--data-dir", DATA_DIR],
      { cwd: REPO_DIR, stdout: "pipe", stderr: "pipe" }
    );
    Promise.all([new Response(proc.stderr).text(), proc.exited])
      .then(([stderr, code]) => {
        if (code !== 0) console.error(`Page content for user ${userId} failed: ${stderr.trim()}`);
      })
      .finally(finish);
  } catch (exc) {
    console.error(`Page content for user ${userId} could not start: ${exc}`);
    finish();
  }
}

async function pageStatus(userId: number, settings: PageSettings | null) {
  const pdf = Bun.file(cvPdfPath(userId));
  const content = await readContent(DATA_DIR, userId);
  let status: "off" | "no-cv" | "generating" | "ready" | "pending";
  if (!settings?.enabled) status = "off";
  else if (!(await pdf.exists())) status = "no-cv";
  else if (pageJobs.has(userId)) status = "generating";
  else if (content && content.cv === cvHash(new Uint8Array(await pdf.arrayBuffer()))) status = "ready";
  else status = "pending";
  return {
    enabled: settings?.enabled ?? false,
    slug: settings?.slug ?? "",
    url: settings?.enabled ? `https://${settings.slug}.${PAGES_DOMAIN}/` : null,
    status,
    generatedAt: content?.generatedAt ?? null,
  };
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  // A page is text and inline styles only: nothing from elsewhere runs or loads.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "public, max-age=300",
};

async function servePage(slug: string, req: Request): Promise<Response> {
  const page = new URL(req.url).pathname === "/" ? await findPage(DATA_DIR, slug) : null;
  if (!page) return new Response(renderNotFound(), { status: 404, headers: PAGE_HEADERS });
  return new Response(renderPage(page.content, slug), { headers: PAGE_HEADERS });
}

// ── Preferences helpers ──────────────────────────────────────────────────────

function prefsPath(userId: number): string {
  return path.join(PREFS_DIR, `${userId}.json`);
}

function appsPath(userId: number): string {
  return path.join(APPS_DIR, `${userId}.json`);
}

// ── Custom (user-added) jobs ─────────────────────────────────────────────────

interface CustomJob {
  id: string;
  source: string;
  title: string;
  link: string;
  publication_date: string;
  close_date: string;
  organization_name: string;
  organization_url: string;
  organization_description: string;
  description: string;
  salary_range: string;
  tags: string;
}

function customJobsPath(userId: number): string {
  return path.join(CUSTOM_JOBS_DIR, `${userId}.json`);
}

async function readCustomJobs(userId: number): Promise<CustomJob[]> {
  const file = Bun.file(customJobsPath(userId));
  if (!(await file.exists())) return [];
  return file.json();
}

async function writeCustomJobs(userId: number, jobs: CustomJob[]): Promise<void> {
  await mkdir(CUSTOM_JOBS_DIR, { recursive: true });
  await Bun.write(customJobsPath(userId), JSON.stringify(jobs));
}

// Strips query/UTM params and a trailing slash, mirroring scrapers/dedupe.py's
// link normalization, so re-adding the same posting (with a different
// tracking suffix) resolves to the same stable id instead of a duplicate row.
function normalizeLink(link: string): string {
  const url = new URL(link);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function customJobId(normalizedLink: string): string {
  return `custom-${Bun.hash(normalizedLink).toString(36)}`;
}

function extractTitle(html: string): string | null {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i);
  if (og?.[1]) return og[1].trim();
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (title?.[1]) return title[1].trim();
  return null;
}

// ── Editor bundle ────────────────────────────────────────────────────────────
//
// The notes and motivation-letter editor (@research/editor, shared with
// bookmarks) is bundled here, once at startup, rather than by a build step:
// the rest of the frontend is plain files served as they are, and a deploy
// only restarts this process. Served gzipped (Caddy doesn't compress this
// site) with an ETag, so a browser downloads it once per deploy. If the
// bundle fails, the page keeps its plain textareas.

interface Asset {
  body: Uint8Array;
  gzip: Uint8Array;
  etag: string;
  type: string;
}

async function buildEditorAssets(): Promise<Map<string, Asset>> {
  const result = await Bun.build({
    entrypoints: [Bun.resolveSync("@research/editor", ROOT)],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "editor bundle failed");
  const css = Bun.file(Bun.resolveSync("@research/editor/editor.css", ROOT));
  const files: [string, Uint8Array, string][] = [
    ["/editor.js", new Uint8Array(await result.outputs[0]!.arrayBuffer()), "text/javascript; charset=utf-8"],
    ["/editor.css", new Uint8Array(await css.arrayBuffer()), "text/css; charset=utf-8"],
  ];
  return new Map(files.map(([name, body, type]) => [
    name,
    { body, gzip: Bun.gzipSync(body), etag: `"${Bun.hash(body).toString(36)}"`, type },
  ]));
}

const editorAssets = buildEditorAssets().catch((err) => {
  console.error("Could not bundle the editor; notes stay plain textareas:", err);
  return new Map<string, Asset>();
});

// ── Spreadsheet bundle ───────────────────────────────────────────────────────
//
// The table layout's grid is Jspreadsheet CE (MIT), with its jSuites and
// formula dependencies. They're UMD builds that find each other as globals,
// so they're concatenated in load order into one /sheet.js rather than
// bundled; the page loads it the first time the table layout is shown.

function toAsset(body: Uint8Array, type: string): Asset {
  return { body, gzip: Bun.gzipSync(body), etag: `"${Bun.hash(body).toString(36)}"`, type };
}

async function buildSheetAssets(): Promise<Map<string, Asset>> {
  const concat = async (files: string[]) => {
    const parts = await Promise.all(files.map((f) => Bun.file(Bun.resolveSync(f, ROOT)).text()));
    return new TextEncoder().encode(parts.join("\n;\n"));
  };
  const js = await concat([
    "jsuites/dist/jsuites.js",
    "@jspreadsheet/formula/dist/index.js",
    "jspreadsheet-ce/dist/index.js",
  ]);
  const css = new TextEncoder().encode((await Promise.all([
    "jsuites/dist/jsuites.css",
    "jspreadsheet-ce/dist/jspreadsheet.css",
    "jspreadsheet-ce/dist/jspreadsheet.themes.css",
  ].map((f) => Bun.file(Bun.resolveSync(f, ROOT)).text()))).join("\n"));
  return new Map([
    ["/sheet.js", toAsset(js, "text/javascript; charset=utf-8")],
    ["/sheet.css", toAsset(css, "text/css; charset=utf-8")],
  ]);
}

const sheetAssets = buildSheetAssets().catch((err) => {
  console.error("Could not load the spreadsheet library; the table stays read-only:", err);
  return new Map<string, Asset>();
});

function serveAsset(req: Request, asset: Asset): Response {
  const headers: Record<string, string> = {
    "Content-Type": asset.type,
    ETag: asset.etag,
    "Cache-Control": "no-cache",
    Vary: "Accept-Encoding",
  };
  if (req.headers.get("if-none-match") === asset.etag) return new Response(null, { status: 304, headers });
  if (/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
    return new Response(asset.gzip, { headers: { ...headers, "Content-Encoding": "gzip" } });
  }
  return new Response(asset.body, { headers });
}

// ── Server ───────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);

    // ── Portfolio pages: <slug>.hireme.sk ──────────────────────────────────
    const pageSlug = slugFromHost(req.headers.get("host"), PAGES_DOMAIN);
    if (pageSlug) return servePage(pageSlug, req);

    // ── Jobs API ───────────────────────────────────────────────────────────
    if (url.pathname === "/api/jobs") {
      try {
        const { rows } = await loadJobs();
        return Response.json(rows);
      } catch (err) {
        return Response.json(
          { error: `Could not read ${CSV_PATH}: ${err}` },
          { status: 500 }
        );
      }
    }

    // ── Public API v1 (read-only, any origin) ──────────────────────────────
    if (url.pathname === "/api" || url.pathname === "/api/") {
      return new Response(Bun.file(path.join(PUBLIC_DIR, "api.html")));
    }
    if (url.pathname.startsWith("/api/v1/")) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: API_CORS });
      if (req.method !== "GET" && req.method !== "HEAD") {
        return Response.json(
          { error: { code: "method_not_allowed", message: "The public API is read-only" } },
          { status: 405, headers: { ...API_CORS, Allow: "GET, OPTIONS" } }
        );
      }
      const ip =
        req.headers.get("x-forwarded-for")?.split(",")[0].trim() || server.requestIP(req)?.address || "unknown";
      const wait = rateLimited(ip);
      if (wait !== null) {
        return Response.json(
          { error: { code: "rate_limited", message: `Over ${API_RATE_LIMIT} requests a minute; retry in ${wait}s` } },
          { status: 429, headers: { ...API_CORS, "Retry-After": String(wait) } }
        );
      }
      if (url.pathname === "/api/v1/openapi.json") {
        return new Response(Bun.file(path.join(PUBLIC_DIR, "openapi.json")), {
          headers: { ...API_CORS, "Content-Type": "application/json" },
        });
      }
      let jobs;
      try {
        jobs = await loadJobs();
      } catch (err) {
        console.error(`Could not read ${CSV_PATH}: ${err}`);
        return Response.json(
          { error: { code: "unavailable", message: "Job data could not be read" } },
          { status: 500, headers: API_CORS }
        );
      }
      const etag = `W/"${jobs.version}"`;
      const headers = { ...API_CORS, ETag: etag, "Cache-Control": "public, max-age=300" };
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
      const res = handleV1(url, { rows: jobs.rows, scrapedAt: await scrapedAt() });
      for (const [key, value] of Object.entries(res.ok ? headers : API_CORS)) res.headers.set(key, value);
      return res;
    }

    // ── Admin: hand corrections ────────────────────────────────────────────

    if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/overrides/")) {
      let user: { id: number; username: string | null };
      try {
        user = await verifyToken(req.headers.get("authorization"));
      } catch {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const admin = ADMIN_USER_IDS.has(user.id);

      if (url.pathname === "/api/admin" && req.method === "GET") {
        return Response.json({ admin });
      }

      // PUT /api/overrides/:jobId  {field: value, field: null (undo)}
      const jobId = decodeURIComponent(url.pathname.slice("/api/overrides/".length));
      if (jobId && req.method === "PUT") {
        if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });
        if (!/^[\w-]{1,64}$/.test(jobId)) {
          return Response.json({ error: "Invalid job id" }, { status: 400 });
        }
        let patch: unknown;
        try {
          patch = await req.json();
        } catch {
          return Response.json({ error: "Expected JSON" }, { status: 400 });
        }
        if (
          !patch || typeof patch !== "object" || Array.isArray(patch) ||
          !Object.keys(patch).length ||
          !Object.values(patch).every((v) => v === null || typeof v === "string")
        ) {
          return Response.json({ error: "Expected {field: text or null}" }, { status: 400 });
        }
        const { code, stdout, stderr } = await setOverrides(jobId, patch as Record<string, string | null>);
        if (code === 0) {
          if (stderr.trim()) console.warn(`overrides ${jobId}: ${stderr.trim()}`);
          return new Response(stdout, { headers: { "Content-Type": "application/json" } });
        }
        const error = stderr.trim().split("\n").pop() || `exit ${code}`;
        if (code !== 2 && code !== 3) console.error(`overrides ${jobId}: ${stderr.trim()}`);
        const status = code === 2 ? 400 : code === 3 ? 404 : 500;
        return Response.json({ error }, { status });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // ── CV endpoints ───────────────────────────────────────────────────────

    if (url.pathname === "/api/cv" || url.pathname === "/api/cv/file") {
      let user: { id: number; username: string | null };
      try {
        user = await verifyToken(req.headers.get("authorization"));
      } catch {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      // POST /api/cv — upload/replace
      if (url.pathname === "/api/cv" && req.method === "POST") {
        const filename = url.searchParams.get("filename") ?? "";
        if (!filename.toLowerCase().endsWith(".pdf")) {
          return Response.json({ error: "Only PDF files are accepted" }, { status: 400 });
        }

        const body = await req.arrayBuffer();
        if (body.byteLength === 0) {
          return Response.json({ error: "Empty body" }, { status: 400 });
        }
        if (body.byteLength > MAX_CV_SIZE) {
          return Response.json({ error: "File too large (max 10 MB)" }, { status: 413 });
        }

        await mkdir(CV_DIR, { recursive: true });
        await Bun.write(cvPdfPath(user.id), body);
        const meta: CvMeta = {
          filename,
          size: body.byteLength,
          uploadedAt: new Date().toISOString(),
        };
        await Bun.write(cvMetaPath(user.id), JSON.stringify(meta));
        if ((await readSettings(DATA_DIR, user.id))?.enabled) startPageContent(user.id);
        return Response.json(meta);
      }

      // GET /api/cv/file — download
      if (url.pathname === "/api/cv/file" && req.method === "GET") {
        const meta = await readCvMeta(user.id);
        if (!meta) return Response.json({ error: "No CV uploaded" }, { status: 404 });
        const file = Bun.file(cvPdfPath(user.id));
        if (!(await file.exists())) return Response.json({ error: "No CV uploaded" }, { status: 404 });
        return new Response(file, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${meta.filename}"`,
          },
        });
      }

      // GET /api/cv — metadata
      if (url.pathname === "/api/cv" && req.method === "GET") {
        const meta = await readCvMeta(user.id);
        if (!meta) return Response.json({ error: "No CV uploaded" }, { status: 404 });
        return Response.json(meta);
      }

      // DELETE /api/cv
      if (url.pathname === "/api/cv" && req.method === "DELETE") {
        try { await unlink(cvPdfPath(user.id)); } catch {}
        try { await unlink(cvMetaPath(user.id)); } catch {}
        // The page was made from this CV; take its content down with it.
        await removeContent(DATA_DIR, user.id);
        return Response.json({ ok: true });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // ── Preferences endpoints ───────────────────────────────────────────────

    if (url.pathname === "/api/preferences") {
      let user: { id: number; username: string | null };
      try {
        user = await verifyToken(req.headers.get("authorization"));
      } catch {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      // GET /api/preferences
      if (req.method === "GET") {
        const file = Bun.file(prefsPath(user.id));
        if (!(await file.exists())) {
          return Response.json({ error: "No preferences" }, { status: 404 });
        }
        return Response.json(await file.json());
      }

      // PUT /api/preferences
      if (req.method === "PUT") {
        const body = await req.json();
        const liked = Array.isArray(body.liked) ? body.liked : [];
        const hidden = Array.isArray(body.hidden) ? body.hidden : [];
        // The last two days the user visited, for "new since your last visit".
        const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
        const visits = { last: date(body.visits?.last), previous: date(body.visits?.previous) };
        const data = { liked, hidden, ...(visits.last ? { visits } : {}) };
        await mkdir(PREFS_DIR, { recursive: true });
        await Bun.write(prefsPath(user.id), JSON.stringify(data));
        return Response.json(data);
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // ── Applications endpoints ───────────────────────────────────────────

    if (
      url.pathname === "/api/applications" ||
      url.pathname.startsWith("/api/applications/")
    ) {
      let user: { id: number; username: string | null };
      try {
        user = await verifyToken(req.headers.get("authorization"));
      } catch {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      const VALID_STATUSES = [
        "interested",
        "applied",
        "interviewing",
        "offered",
        "rejected",
        "withdrawn",
      ];

      const jobId = url.pathname.slice("/api/applications/".length);

      // GET /api/applications
      if (url.pathname === "/api/applications" && req.method === "GET") {
        const file = Bun.file(appsPath(user.id));
        if (!(await file.exists())) {
          return Response.json({ error: "No applications" }, { status: 404 });
        }
        return Response.json(await file.json());
      }

      // PUT /api/applications/:jobId
      if (jobId && req.method === "PUT") {
        const body = await req.json();
        if (body.status && !VALID_STATUSES.includes(body.status)) {
          return Response.json({ error: "Invalid status" }, { status: 400 });
        }
        await mkdir(APPS_DIR, { recursive: true });
        const file = Bun.file(appsPath(user.id));
        const apps: Record<string, any> = (await file.exists())
          ? await file.json()
          : {};
        const existing = apps[jobId];
        const now = new Date().toISOString();
        apps[jobId] = {
          status: body.status ?? existing?.status ?? "interested",
          notes: body.notes ?? existing?.notes ?? "",
          motivationLetter:
            body.motivationLetter ?? existing?.motivationLetter ?? "",
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        await Bun.write(appsPath(user.id), JSON.stringify(apps));
        return Response.json(apps[jobId]);
      }

      // DELETE /api/applications/:jobId
      if (jobId && req.method === "DELETE") {
        const file = Bun.file(appsPath(user.id));
        if (await file.exists()) {
          const apps: Record<string, any> = await file.json();
          delete apps[jobId];
          await Bun.write(appsPath(user.id), JSON.stringify(apps));
        }
        return Response.json({ ok: true });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // ── Custom (user-added) jobs ─────────────────────────────────────────

    if (
      url.pathname === "/api/custom-jobs" ||
      url.pathname.startsWith("/api/custom-jobs/")
    ) {
      let user: { id: number; username: string | null };
      try {
        user = await verifyToken(req.headers.get("authorization"));
      } catch {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      // GET /api/custom-jobs
      if (url.pathname === "/api/custom-jobs" && req.method === "GET") {
        return Response.json(await readCustomJobs(user.id));
      }

      // POST /api/custom-jobs — add by link
      if (url.pathname === "/api/custom-jobs" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const rawLink = typeof body.link === "string" ? body.link.trim() : "";

        let normalized: string;
        try {
          const parsed = new URL(rawLink);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("not http(s)");
          }
          normalized = normalizeLink(rawLink);
        } catch {
          return Response.json({ error: "Invalid URL" }, { status: 400 });
        }

        const jobs = await readCustomJobs(user.id);
        const id = customJobId(normalized);
        const existing = jobs.find((j) => j.id === id);
        if (existing) return Response.json(existing);

        let title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title) {
          try {
            const { html } = await fetchPage(rawLink, { timeoutMs: 8000 });
            title = extractTitle(html) ?? "";
          } catch (err) {
            // Fetching/parsing the page is best-effort: a slow, blocked, or
            // non-HTML page shouldn't stop the user from adding the link.
            console.error(`Could not fetch title for ${rawLink}:`, err instanceof FetchError ? err.message : err);
          }
        }
        if (!title) title = new URL(normalized).hostname;

        const job: CustomJob = {
          id,
          source: "custom",
          title,
          link: rawLink,
          publication_date: new Date().toISOString().slice(0, 10),
          close_date: "",
          organization_name: typeof body.organization_name === "string" ? body.organization_name.trim() : "",
          organization_url: "",
          organization_description: "",
          description: "",
          salary_range: "",
          tags: "",
        };
        jobs.push(job);
        await writeCustomJobs(user.id, jobs);
        return Response.json(job, { status: 201 });
      }

      // DELETE /api/custom-jobs/:id
      if (req.method === "DELETE") {
        const id = url.pathname.slice("/api/custom-jobs/".length);
        const jobs = await readCustomJobs(user.id);
        const next = jobs.filter((j) => j.id !== id);
        await writeCustomJobs(user.id, next);
        return Response.json({ ok: true });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // ── Fit scores ─────────────────────────────────────────────────────────
    // GET /api/fit → {model, scores: {jobId: {score, reason, scored_at}}}
    if (url.pathname === "/api/fit") {
      let user;
      try {
        user = await verifyToken(req.headers.get("authorization"));
      } catch {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const file = Bun.file(path.join(FIT_DIR, `${user.id}.json`));
      if (!(await file.exists())) return Response.json({ error: "No fit scores" }, { status: 404 });
      const { model, scores } = await file.json();
      return Response.json({ model, scores });
    }

    // ── Portfolio page settings ────────────────────────────────────────────
    if (url.pathname === "/api/page") {
      let user: { id: number; username: string | null };
      try {
        user = await verifyToken(req.headers.get("authorization"));
      } catch {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      if (req.method === "GET") {
        return Response.json(await pageStatus(user.id, await readSettings(DATA_DIR, user.id)));
      }

      // PUT {enabled, slug?}: turn the page on or off, optionally choosing its address.
      if (req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (typeof body?.enabled !== "boolean") {
          return Response.json({ error: "enabled must be true or false" }, { status: 400 });
        }
        const current = await readSettings(DATA_DIR, user.id);
        const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : (current?.slug ?? "");
        if (!slug && body.enabled) {
          return Response.json({ error: "Choose an address for your page" }, { status: 400 });
        }
        if (slug) {
          const problem = slugProblem(slug);
          if (problem) return Response.json({ error: problem }, { status: 400 });
          const owner = await slugOwner(DATA_DIR, slug);
          if (owner !== null && owner !== user.id) {
            return Response.json({ error: "That address is taken" }, { status: 409 });
          }
        }
        const settings: PageSettings = { enabled: body.enabled, slug, updatedAt: new Date().toISOString() };
        await writeSettings(DATA_DIR, user.id, settings);
        if (settings.enabled && (await Bun.file(cvPdfPath(user.id)).exists())) startPageContent(user.id);
        return Response.json(await pageStatus(user.id, settings));
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // ── Editor bundle ──────────────────────────────────────────────────────
    if (url.pathname === "/editor.js" || url.pathname === "/editor.css") {
      const asset = (await editorAssets).get(url.pathname);
      return asset ? serveAsset(req, asset) : new Response("Editor unavailable", { status: 503 });
    }

    // ── Spreadsheet bundle ─────────────────────────────────────────────────
    if (url.pathname === "/sheet.js" || url.pathname === "/sheet.css") {
      const asset = (await sheetAssets).get(url.pathname);
      return asset ? serveAsset(req, asset) : new Response("Spreadsheet unavailable", { status: 503 });
    }

    // ── Static files ───────────────────────────────────────────────────────
    const relPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(PUBLIC_DIR, relPath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      return new Response("Not found", { status: 404 });
    }
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Job board running at http://localhost:${PORT}`);
console.log(`Reading jobs from ${CSV_PATH}`);
