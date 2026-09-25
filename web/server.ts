// Minimal Bun server: serves the static frontend and a JSON API
// reading the jobs CSV produced by scrape_80000hours_jobs.py.

import path from "path";
import { mkdir, unlink } from "fs/promises";
import { createRemoteJWKSet, jwtVerify } from "jose";

const PORT = Number(process.env.PORT ?? 4020);
const ROOT = import.meta.dir;
const PUBLIC_DIR = path.join(ROOT, "public");
const CSV_PATH = process.env.JOBS_CSV ?? path.join(ROOT, "..", "jobs.csv");
const CV_DIR = path.join(ROOT, "..", "data", "cv");

const MAX_CV_SIZE = 10 * 1024 * 1024; // 10 MB

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

// ── CSV parsing ──────────────────────────────────────────────────────────────

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // ignore, \n handles the line break
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

async function loadJobs(): Promise<Record<string, string>[]> {
  const text = await Bun.file(CSV_PATH).text();
  const rows = parseCSV(text);
  const [header, ...body] = rows;
  return body.map((row) =>
    Object.fromEntries(header.map((key, i) => [key, row[i] ?? ""]))
  );
}

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

// ── Server ───────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // ── Jobs API ───────────────────────────────────────────────────────────
    if (url.pathname === "/api/jobs") {
      try {
        const jobs = await loadJobs();
        return Response.json(jobs);
      } catch (err) {
        return Response.json(
          { error: `Could not read ${CSV_PATH}: ${err}` },
          { status: 500 }
        );
      }
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
        return Response.json({ ok: true });
      }

      return new Response("Method not allowed", { status: 405 });
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
