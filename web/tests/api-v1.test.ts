// Public API v1: bun test (in web/). Builds jobs.csv from the browser tests'
// fixture (98 jobs, every board and kind of salary) in a temp dir, then tests
// lib/api-v1.ts directly and the server's CORS / ETag / rate-limit wrapping.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, copyFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Subprocess } from "bun";
import { parseRows } from "../lib/csv";
import { facets, handleV1, queryJobs, toJob } from "../lib/api-v1";

const WEB = path.join(import.meta.dir, "..");
const REPO = path.join(WEB, "..");

let dir: string;
let jobsCsv: string;
let scraped: string;
let rows: Record<string, string>[];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "hireme-api-"));
  scraped = path.join(dir, "scraped.json");
  jobsCsv = path.join(dir, "jobs.csv");
  await copyFile(path.join(WEB, "tests", "browser", "fixture", "scraped.json"), scraped);
  await Bun.write(path.join(dir, "overrides.toml"), "");
  const proc = Bun.spawn(
    ["python3", "-m", "scrapers.overrides", "rebuild",
      "--scraped", scraped, "--overrides", path.join(dir, "overrides.toml"), "--jobs", jobsCsv],
    { cwd: REPO, stdout: "ignore", stderr: "pipe" }
  );
  if ((await proc.exited) !== 0) throw new Error(`rebuild failed: ${await new Response(proc.stderr).text()}`);
  rows = parseRows(await Bun.file(jobsCsv).text());
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const query = (qs: string) => queryJobs(rows, new URLSearchParams(qs));
const get = async (pathAndQuery: string) => {
  const res = handleV1(new URL(`http://x${pathAndQuery}`), { rows, scrapedAt: "2026-10-25T06:00:00.000Z" });
  return { status: res.status, body: (await res.json()) as any };
};

describe("toJob", () => {
  test("types numbers, lists and nulls", () => {
    const row = rows.find((r) => r.salary_min && r.source.includes(";"))!;
    const job = toJob(row, false) as any;
    expect(job.id).toBe(row.id);
    expect(typeof job.salary.min).toBe("number");
    expect(job.sources.length).toBeGreaterThan(1);
    expect(Array.isArray(job.location)).toBe(true);
    expect(job.description).toBeUndefined();
    expect(job.organization.description).toBeUndefined();
    const empty = toJob({ id: "x" }, true) as any;
    expect(empty.closes).toBeNull();
    expect(empty.salary).toEqual({ text: null, min: null, max: null, currency: null, period: null });
    expect(empty.tags).toEqual([]);
  });

  test("full adds descriptions", () => {
    const job = toJob(rows[0], true) as any;
    expect(job.description).toBe(rows[0].description.trim() || null);
    expect("description" in job.organization).toBe(true);
  });
});

describe("queryJobs", () => {
  test("defaults: newest first, 50 per page, next link", () => {
    const res = query("");
    expect(res.page).toMatchObject({ total: rows.length, limit: 50, offset: 0 });
    expect(res.data.length).toBe(50);
    expect(res.page.next).toBe("/api/v1/jobs?offset=50");
    const dates = res.data.map((j: any) => j.published ?? "");
    expect(dates).toEqual([...dates].sort().reverse());
  });

  test("last page has no next", () => {
    const res = query(`offset=${rows.length - 3}`);
    expect(res.data.length).toBe(3);
    expect(res.page.next).toBeNull();
  });

  test("source repeats OR, fields AND", () => {
    const one = query("source=Animal Advocacy Careers&limit=200");
    expect(one.page.total).toBeGreaterThan(0);
    expect(one.data.every((j: any) => j.sources.includes("Animal Advocacy Careers"))).toBe(true);
    const two = query("source=Animal Advocacy Careers&source=80,000 Hours&limit=200");
    expect(two.page.total).toBeGreaterThan(one.page.total);
    const both = query("source=80,000 Hours&location=Remote&limit=200");
    expect(both.data.every((j: any) => j.sources.includes("80,000 Hours") && j.location.includes("Remote"))).toBe(true);
  });

  test("q matches title, organization or description", () => {
    const org = rows[0].organization_name;
    const res = query(`q=${encodeURIComponent(org.toUpperCase())}&limit=200`);
    expect(res.data.some((j: any) => j.id === rows[0].id)).toBe(true);
  });

  test("salary_min keeps only known salaries at or above it", () => {
    const res = query("salary_min=100000&limit=200");
    expect(res.page.total).toBeGreaterThan(0);
    expect(res.data.every((j: any) => (j.salary.max ?? j.salary.min) >= 100000)).toBe(true);
  });

  test("currency and period", () => {
    const res = query("currency=GBP&period=year&limit=200");
    expect(res.data.every((j: any) => j.salary.currency === "GBP" && j.salary.period === "year")).toBe(true);
  });

  test("closes_after keeps jobs with no close date", () => {
    const res = query("closes_after=2026-11-01&limit=200");
    expect(res.data.every((j: any) => j.closes === null || j.closes >= "2026-11-01")).toBe(true);
    expect(res.data.some((j: any) => j.closes === null)).toBe(true);
  });

  test("posted_since", () => {
    const res = query("posted_since=2026-01-01&limit=200");
    expect(res.data.every((j: any) => j.published >= "2026-01-01")).toBe(true);
  });

  test("sort=closing puts dated jobs first, soonest first", () => {
    const closes = query("sort=closing&limit=200").data.map((j: any) => j.closes);
    const dated = closes.filter(Boolean);
    expect(closes.slice(0, dated.length)).toEqual([...dated].sort());
  });

  test.each([
    ["typo=1", "Unknown parameter: typo"],
    ["limit=0", "limit"],
    ["limit=201", "limit"],
    ["offset=-1", "offset"],
    ["sort=random", "sort"],
    ["fields=all", "fields"],
    ["posted_since=yesterday", "posted_since"],
    ["salary_min=lots", "salary_min"],
  ])("400 on %s", async (qs, message) => {
    const { status, body } = await get(`/api/v1/jobs?${qs}`);
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_param");
    expect(body.error.message).toContain(message);
  });
});

describe("routes", () => {
  test("one job, full", async () => {
    const { status, body } = await get(`/api/v1/jobs/${rows[5].id}`);
    expect(status).toBe(200);
    expect(body.data.id).toBe(rows[5].id);
    expect("description" in body.data).toBe(true);
    expect(body.meta).toEqual({ scraped_at: "2026-10-25T06:00:00.000Z", version: "1" });
  });

  test("404s", async () => {
    expect((await get("/api/v1/jobs/nope")).status).toBe(404);
    expect((await get("/api/v1/other")).body.error.code).toBe("not_found");
  });

  test("facets count jobs per value", async () => {
    const { body } = await get("/api/v1/facets");
    const remote = body.data.location.find((f: any) => f.value === "Remote");
    expect(remote.count).toBe(query("location=Remote").page.total);
    expect(body.data.source.map((f: any) => f.value).sort()).toEqual(
      facets(rows).source.map((f) => f.value).sort()
    );
  });

  test("meta", async () => {
    const { body } = await get("/api/v1/meta");
    expect(body.data.total_jobs).toBe(rows.length);
    expect(body.data.sources.length).toBe(4);
  });
});

describe("server", () => {
  let server: Subprocess;
  let base: string;

  beforeAll(async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    base = `http://127.0.0.1:${port}`;
    server = Bun.spawn(["bun", "run", "server.ts"], {
      cwd: WEB,
      env: { ...process.env, PORT: String(port), JOBS_CSV: jobsCsv, SCRAPED_JSON: scraped, API_RATE_LIMIT: "8" },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`${base}/api/v1/meta`, { headers: { "X-Forwarded-For": "warmup" } });
        return;
      } catch {
        await Bun.sleep(100);
      }
    }
    throw new Error("server did not start");
  });

  afterAll(() => {
    server?.kill();
  });

  const hit = (p: string, ip: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${p}`, { headers: { "X-Forwarded-For": ip, ...headers } });

  test("CORS, ETag and 304", async () => {
    const res = await hit("/api/v1/jobs?limit=1", "etag");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    const again = await hit("/api/v1/jobs?limit=1", "etag", { "If-None-Match": etag });
    expect(again.status).toBe(304);
  });

  test("errors carry CORS but no cache headers", async () => {
    const res = await hit("/api/v1/jobs?typo=1", "errors");
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("etag")).toBeNull();
  });

  test("read-only", async () => {
    const res = await fetch(`${base}/api/v1/jobs`, { method: "POST", headers: { "X-Forwarded-For": "post" } });
    expect(res.status).toBe(405);
    const pre = await fetch(`${base}/api/v1/jobs`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
  });

  test("openapi.json and docs page", async () => {
    const spec = await (await hit("/api/v1/openapi.json", "docs")).json();
    expect(spec.openapi).toStartWith("3.1");
    expect(Object.keys(spec.paths)).toContain("/api/v1/jobs");
    const page = await fetch(`${base}/api`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/api/v1/jobs");
  });

  test("rate limit per IP", async () => {
    const statuses = [];
    for (let i = 0; i < 9; i++) statuses.push((await hit("/api/v1/meta", "busy")).status);
    expect(statuses.slice(0, 8).every((s) => s === 200)).toBe(true);
    const last = await hit("/api/v1/meta", "busy");
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await hit("/api/v1/meta", "someone-else")).status).toBe(200);
  });

  test("/api/jobs unchanged", async () => {
    const all = await (await fetch(`${base}/api/jobs`)).json();
    expect(all.length).toBe(rows.length);
    expect(typeof all[0].salary_min).toBe("string");
  });
});
