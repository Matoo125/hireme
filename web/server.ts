// Minimal Bun server: serves the static frontend and a JSON API
// reading the jobs CSV produced by scrape_80000hours_jobs.py.

import path from "path";

const PORT = Number(process.env.PORT ?? 4020);
const ROOT = import.meta.dir;
const PUBLIC_DIR = path.join(ROOT, "public");
const CSV_PATH = process.env.JOBS_CSV ?? path.join(ROOT, "..", "jobs.csv");

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

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

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
