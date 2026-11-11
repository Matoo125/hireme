// Send each confirmed digest its new jobs, and a reminder for saved jobs that
// close soon (lib/reminders.ts): bun run digest.ts [--dry-run]
//
// Run by scrape_and_sync.sh after fit scoring. A user with nothing new gets
// no email. A failed send leaves that user's jobs unsent for the next run and
// makes this exit non-zero. --dry-run prints who would get what, sending
// nothing and changing nothing (no RESEND_API_KEY needed).

import path from "path";
import { parseRows } from "./lib/csv";
import {
  allDigests, digestEmail, digestItems, readDigest, recordDigestSent, sendEmail, writeDigest, type DigestSettings,
} from "./lib/digest";
import { recordReminded, reminderEmail, reminderItems } from "./lib/reminders";

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

const readJson = async <T>(file: string, fallback: T): Promise<T> => {
  const f = Bun.file(file);
  return (await f.exists()) ? f.json().catch(() => fallback) : fallback;
};

/** Send one email; on success, save what it recorded unless the user unsubscribed or moved address meanwhile. */
async function deliver(
  userId: number, digest: DigestSettings, email: ReturnType<typeof digestEmail>,
  record: (current: DigestSettings) => DigestSettings, what: string
): Promise<void> {
  if (dryRun) {
    console.log(`user ${userId}: would send "${email.subject}" (${what})`);
    return;
  }
  try {
    await sendEmail(email, { apiKey: API_KEY, from: FROM, url: process.env.RESEND_API_URL });
    const current = await readDigest(DATA_DIR, userId).catch(() => null);
    if (current?.unsubscribeToken === digest.unsubscribeToken) await writeDigest(DATA_DIR, userId, record(current));
    sent++;
    console.log(`user ${userId}: sent ${what}`);
  } catch (err) {
    failures++;
    console.error(`!!! user ${userId}: ${what} failed: ${err}`);
  }
}

for (const { userId, digest } of await allDigests(DATA_DIR)) {
  if (!digest.confirmed) continue;
  const unsubscribe = `${SITE_URL}/digest/unsubscribe/${digest.unsubscribeToken}`;

  const scores = (await readJson<{ scores?: Record<string, never> }>(path.join(FIT_DIR, `${userId}.json`), {})).scores ?? {};
  const items = digestItems(rows, scores, digest, today);
  if (items.length) {
    await deliver(userId, digest, digestEmail(digest.email, items, SITE_URL, unsubscribe, digest.minFit),
      (current) => recordDigestSent(current, items, new Date()), items.length === 1 ? "1 job" : `${items.length} jobs`);
  } else {
    console.log(`user ${userId}: nothing new`);
  }

  // Saved jobs closing soon: the listing plus the user's own added jobs.
  const prefs = await readJson(path.join(DATA_DIR, "preferences", `${userId}.json`), {});
  const apps = await readJson(path.join(DATA_DIR, "applications", `${userId}.json`), {});
  const own = await readJson<Record<string, string>[]>(path.join(DATA_DIR, "custom-jobs", `${userId}.json`), []);
  const due = reminderItems([...rows, ...own], prefs, apps, digest, today);
  if (due.length) {
    await deliver(userId, digest, reminderEmail(digest.email, due, SITE_URL, unsubscribe),
      (current) => recordReminded(current, due), due.length === 1 ? "1 reminder" : `${due.length} reminders`);
  }
}

console.log(`digest emails: ${sent} sent, ${failures} failed`);
process.exit(failures ? 1 : 0);
