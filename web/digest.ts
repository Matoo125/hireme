// Send each confirmed digest its new jobs: bun run digest.ts [--dry-run]
//
// Run by scrape_and_sync.sh after fit scoring. A user with nothing new gets
// no email. A failed send leaves that user's jobs unsent for the next run and
// makes this exit non-zero. --dry-run prints who would get what, sending
// nothing and changing nothing (no RESEND_API_KEY needed).

import path from "path";
import { parseRows } from "./lib/csv";
import { allDigests, digestEmail, digestItems, recordDigestSent, sendEmail, writeDigest } from "./lib/digest";

const ROOT = import.meta.dir;
const CSV_PATH = process.env.JOBS_CSV ?? path.join(ROOT, "..", "jobs.csv");
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, "..", "data");
const FIT_DIR = process.env.FIT_DIR ?? path.join(DATA_DIR, "fit");
const SITE_URL = (process.env.SITE_URL ?? `https://${process.env.PAGES_DOMAIN ?? "hireme.sk"}`).replace(/\/$/, "");
const FROM = process.env.DIGEST_FROM ?? "Hireme <jobs@hireme.sk>";
const API_KEY = process.env.RESEND_API_KEY ?? "";
const dryRun = process.argv.includes("--dry-run");

if (!dryRun && !API_KEY) {
  console.log("RESEND_API_KEY not set: no digests sent");
  process.exit(0);
}

const rows = parseRows(await Bun.file(CSV_PATH).text());
const today = new Date().toISOString().slice(0, 10);
let failures = 0;
let sent = 0;

for (const { userId, digest } of await allDigests(DATA_DIR)) {
  if (!digest.confirmed) continue;
  const fitFile = Bun.file(path.join(FIT_DIR, `${userId}.json`));
  const scores = (await fitFile.exists()) ? (await fitFile.json()).scores : {};
  const items = digestItems(rows, scores, digest, today);
  if (!items.length) {
    console.log(`user ${userId}: nothing new`);
    continue;
  }
  const unsubscribe = `${SITE_URL}/digest/unsubscribe/${digest.unsubscribeToken}`;
  const email = digestEmail(digest.email, items, SITE_URL, unsubscribe, digest.minFit);
  if (dryRun) {
    console.log(`user ${userId}: would send "${email.subject}" (${items.length} jobs)`);
    continue;
  }
  try {
    await sendEmail(email, { apiKey: API_KEY, from: FROM, url: process.env.RESEND_API_URL });
    // Re-read: the user may have unsubscribed or changed address meanwhile.
    const current = await Bun.file(path.join(DATA_DIR, "digests", `${userId}.json`)).json().catch(() => null);
    if (current?.unsubscribeToken === digest.unsubscribeToken) {
      await writeDigest(DATA_DIR, userId, recordDigestSent(current, items, new Date()));
    }
    sent++;
    console.log(`user ${userId}: sent ${items.length === 1 ? "1 job" : `${items.length} jobs`}`);
  } catch (err) {
    failures++;
    console.error(`!!! user ${userId}: digest failed: ${err}`);
  }
}

console.log(`digests: ${sent} sent, ${failures} failed`);
process.exit(failures ? 1 : 0);
