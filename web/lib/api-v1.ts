// Public read-only API, /api/v1: jobs.csv rows as typed JSON, with filters,
// paging and facets. The contract is web/public/openapi.json; within v1 fields
// are only ever added. server.ts adds CORS, ETag and rate limiting around it.

export const API_VERSION = "1";

export const SOURCES_NOTE =
  "Listings come from 80,000 Hours, Probably Good, the EA Opportunities Board and " +
  "Animal Advocacy Careers. Please link to each job's original posting (url).";

/** Typed tag columns (scrapers/tag_fields.py), filterable and faceted. */
const TAG_FIELDS = ["job_type", "experience", "education", "location", "cause_area", "skills"] as const;

const LIST_PARAMS = new Set([
  "q", "source", "organization", "currency", "period", ...TAG_FIELDS,
  "salary_min", "posted_since", "closes_after", "sort", "fields", "limit", "offset",
]);
const SORTS = ["newest", "oldest", "closing", "organization"] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Row = Record<string, string>;

export interface Dataset {
  rows: Row[];
  /** When the last scrape finished (ISO 8601), if known. */
  scrapedAt: string | null;
}

class BadRequest extends Error {}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

const list = (s: string | undefined): string[] =>
  (s ?? "").split(";").map((v) => v.trim()).filter(Boolean);
const text = (s: string | undefined): string | null => (s ?? "").trim() || null;
const num = (s: string | undefined): number | null => {
  const t = (s ?? "").trim();
  return t === "" || !Number.isFinite(Number(t)) ? null : Number(t);
};

/** A jobs.csv row as the v1 job object. */
export function toJob(row: Row, full: boolean) {
  const job: Record<string, unknown> = {
    id: row.id,
    title: text(row.title),
    url: text(row.link),
    sources: list(row.source),
    organization: {
      name: text(row.organization_name),
      url: text(row.organization_url),
      ...(full ? { description: text(row.organization_description) } : {}),
    },
    published: text(row.publication_date),
    closes: text(row.close_date),
    salary: {
      text: text(row.salary_range),
      min: num(row.salary_min),
      max: num(row.salary_max),
      currency: text(row.salary_currency),
      period: text(row.salary_period),
    },
    ...Object.fromEntries(TAG_FIELDS.map((f) => [f, list(row[f])])),
    other_tags: list(row.other_tags),
    tags: list(row.tags),
    corrected: list(row.corrected),
    links: { self: `/api/v1/jobs/${encodeURIComponent(row.id)}` },
  };
  if (full) job.description = text(row.description);
  return job;
}

function dateParam(params: URLSearchParams, name: string): string | null {
  const v = params.get(name);
  if (v === null) return null;
  if (!DATE.test(v)) throw new BadRequest(`${name} must be a date, YYYY-MM-DD`);
  return v;
}

function intParam(params: URLSearchParams, name: string, fallback: number, max?: number): number {
  const v = params.get(name);
  if (v === null) return fallback;
  if (!/^\d+$/.test(v)) throw new BadRequest(`${name} must be a non-negative integer`);
  const n = Number(v);
  if (max !== undefined && (n < 1 || n > max)) throw new BadRequest(`${name} must be between 1 and ${max}`);
  return n;
}

/** Filter, sort and page rows for GET /api/v1/jobs. Throws BadRequest. */
export function queryJobs(rows: Row[], params: URLSearchParams) {
  for (const key of params.keys()) {
    if (!LIST_PARAMS.has(key)) throw new BadRequest(`Unknown parameter: ${key}`);
  }

  const q = params.get("q")?.trim().toLowerCase() || null;
  const postedSince = dateParam(params, "posted_since");
  const closesAfter = dateParam(params, "closes_after");
  const salaryMinParam = params.get("salary_min");
  if (salaryMinParam !== null && !Number.isFinite(Number(salaryMinParam))) {
    throw new BadRequest("salary_min must be a number");
  }
  const salaryMin = salaryMinParam === null ? null : Number(salaryMinParam);
  const sort = params.get("sort") ?? "newest";
  if (!(SORTS as readonly string[]).includes(sort)) {
    throw new BadRequest(`sort must be one of ${SORTS.join(", ")}`);
  }
  const fields = params.get("fields") ?? "summary";
  if (fields !== "summary" && fields !== "full") throw new BadRequest("fields must be summary or full");
  const limit = intParam(params, "limit", DEFAULT_LIMIT, MAX_LIMIT);
  const offset = intParam(params, "offset", 0);

  // Repeats of one parameter OR together; different parameters AND (like the
  // grid's column filters).
  // [column, param] pairs → [column, wanted values], for the params given.
  const wanted = (pairs: [string, string][]): [string, Set<string>][] =>
    pairs
      .map(([column, param]): [string, Set<string>] => [column, new Set(params.getAll(param))])
      .filter(([, values]) => values.size > 0);
  const listFilters = wanted([["source", "source"], ...TAG_FIELDS.map((f): [string, string] => [f, f])]);
  const exactFilters = wanted([
    ["organization_name", "organization"],
    ["salary_currency", "currency"],
    ["salary_period", "period"],
  ]);

  const matched = rows.filter((row) => {
    if (q && ![row.title, row.organization_name, row.description].some((s) => s?.toLowerCase().includes(q))) {
      return false;
    }
    for (const [field, values] of listFilters) {
      if (!list(row[field]).some((v) => values.has(v))) return false;
    }
    for (const [field, values] of exactFilters) {
      if (!values.has(row[field]?.trim() ?? "")) return false;
    }
    if (salaryMin !== null) {
      const top = num(row.salary_max) ?? num(row.salary_min);
      if (top === null || top < salaryMin) return false;
    }
    if (postedSince && !(row.publication_date && row.publication_date >= postedSince)) return false;
    if (closesAfter && row.close_date && row.close_date < closesAfter) return false;
    return true;
  });

  // Same orders as the web app's sort dropdown (sortJobs in public/app.js).
  const by = (field: string, dir: 1 | -1) => (a: Row, b: Row) =>
    dir * (a[field] || "").localeCompare(b[field] || "");
  if (sort === "newest") matched.sort(by("publication_date", -1));
  else if (sort === "oldest") matched.sort(by("publication_date", 1));
  else if (sort === "organization") matched.sort(by("organization_name", 1));
  else {
    matched.sort((a, b) => {
      if (!a.close_date && !b.close_date) return 0;
      if (!a.close_date) return 1;
      if (!b.close_date) return -1;
      return a.close_date.localeCompare(b.close_date);
    });
  }

  const page = matched.slice(offset, offset + limit);
  let next: string | null = null;
  if (offset + limit < matched.length) {
    const nextParams = new URLSearchParams(params);
    nextParams.set("offset", String(offset + limit));
    next = `/api/v1/jobs?${nextParams}`;
  }
  return {
    data: page.map((row) => toJob(row, fields === "full")),
    page: { total: matched.length, limit, offset, next },
  };
}

/** Each filterable field's values with job counts, most common first. */
export function facets(rows: Row[]) {
  const count = (values: (row: Row) => string[]) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const v of new Set(values(row))) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }));
  };
  const single = (field: string) => (row: Row) => (row[field]?.trim() ? [row[field].trim()] : []);
  return {
    source: count((row) => list(row.source)),
    ...Object.fromEntries(TAG_FIELDS.map((f) => [f, count((row) => list(row[f]))])),
    organization: count(single("organization_name")),
    currency: count(single("salary_currency")),
    period: count(single("salary_period")),
  };
}

/** Route a GET under /api/v1 (other than openapi.json, which server.ts serves). */
export function handleV1(url: URL, data: Dataset): Response {
  const meta = { scraped_at: data.scrapedAt, version: API_VERSION };
  const route = url.pathname.replace(/\/+$/, "");
  try {
    if (route === "/api/v1/jobs") {
      return Response.json({ ...queryJobs(data.rows, url.searchParams), meta });
    }
    if (route.startsWith("/api/v1/jobs/")) {
      const id = decodeURIComponent(route.slice("/api/v1/jobs/".length));
      const row = data.rows.find((r) => r.id === id);
      if (!row) return error(404, "not_found", `No job with id ${id}`);
      return Response.json({ data: toJob(row, true), meta });
    }
    if (route === "/api/v1/facets") {
      return Response.json({ data: facets(data.rows), meta });
    }
    if (route === "/api/v1/meta") {
      return Response.json({
        data: {
          ...meta,
          total_jobs: data.rows.length,
          sources: facets(data.rows).source,
          attribution: SOURCES_NOTE,
          docs: "/api",
          openapi: "/api/v1/openapi.json",
        },
      });
    }
    return error(404, "not_found", `No such endpoint: ${url.pathname}`);
  } catch (err) {
    if (err instanceof BadRequest) return error(400, "bad_param", err.message);
    throw err;
  }
}
