// Private RSS feeds of new, well-fitting jobs: a logged-in user who turns one
// on gets a secret link (data/feeds/<id>.json holds its token) that any feed
// reader can poll, no login needed. The feed lists jobs first seen in the
// last FEED_DAYS days that scored at least `minFit` against the user's CV
// (data/fit/<id>.json, written by fit_scores.py), leaving out jobs not open
// to Europe. Turning the feed off deletes the token, so the old link stops
// working; a new link (rotate) does the same while keeping the feed on.

import { timingSafeEqual } from "crypto";
import { readdir, unlink } from "fs/promises";
import path from "path";

export interface FeedSettings {
  token: string;
  minFit: number;
  createdAt: string;
}

export interface FitScore {
  score: number;
  reason: string;
}

export interface FeedItem {
  row: Record<string, string>;
  fit: FitScore;
}

export const DEFAULT_MIN_FIT = 60;
export const FEED_DAYS = 30;
export const FEED_LIMIT = 50;

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function feedPath(dir: string, userId: number): string {
  return path.join(dir, "feeds", `${userId}.json`);
}

export async function readFeed(dir: string, userId: number): Promise<FeedSettings | null> {
  const file = Bun.file(feedPath(dir, userId));
  return (await file.exists()) ? file.json() : null;
}

export async function writeFeed(dir: string, userId: number, feed: FeedSettings): Promise<void> {
  await Bun.write(feedPath(dir, userId), JSON.stringify(feed, null, 1));
}

export async function removeFeed(dir: string, userId: number): Promise<void> {
  await unlink(feedPath(dir, userId)).catch(() => {});
}

/** The user whose feed `token` opens, with its settings, or null. */
export async function findFeed(
  dir: string,
  token: string
): Promise<{ userId: number; feed: FeedSettings } | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  let names: string[];
  try {
    names = await readdir(path.join(dir, "feeds"));
  } catch {
    return null;
  }
  for (const name of names) {
    const match = name.match(/^(\d+)\.json$/);
    if (!match) continue;
    const userId = Number(match[1]);
    const feed = await readFeed(dir, userId).catch(() => null);
    if (feed && feed.token.length === token.length &&
        timingSafeEqual(Buffer.from(feed.token), Buffer.from(token))) {
      return { userId, feed };
    }
  }
  return null;
}

/** Jobs for the feed: newest first, then best fit. `today` is YYYY-MM-DD (UTC). */
export function feedItems(
  rows: Record<string, string>[],
  scores: Record<string, FitScore>,
  minFit: number,
  today: string
): FeedItem[] {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - FEED_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return rows
    .filter((row) => {
      const fit = scores[row.id];
      return fit && fit.score >= minFit && row.europe !== "no" && (row.first_seen ?? "") >= since;
    })
    .map((row) => ({ row, fit: scores[row.id] }))
    .sort(
      (a, b) =>
        (b.row.first_seen ?? "").localeCompare(a.row.first_seen ?? "") || b.fit.score - a.fit.score
    )
    .slice(0, FEED_LIMIT);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Control characters other than tab and newlines aren't allowed in XML 1.0.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function httpLink(link: string | undefined): string | null {
  try {
    const url = new URL(link ?? "");
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function rfc822(date: string): string | null {
  const ms = Date.parse(`${date}T06:00:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toUTCString();
}

/** One job's summary for a feed reader, as plain text lines. */
function describe(item: FeedItem): string {
  const { row, fit } = item;
  const lines = [`Fit ${fit.score}: ${fit.reason}`];
  if (row.europe === "yes") lines.push("Open to Europe.");
  else if (row.europe_reason) lines.push(`Europe unclear: ${row.europe_reason}`);
  if (row.salary_range) lines.push(`Salary: ${row.salary_range}`);
  if (row.close_date) lines.push(`Closes ${row.close_date}.`);
  return lines.join("\n");
}

export function renderFeed(items: FeedItem[], site: string, minFit: number): string {
  const entries = items.map((item) => {
    const { row, fit } = item;
    const title = row.organization_name ? `${row.title} — ${row.organization_name}` : row.title;
    const link = httpLink(row.link) ?? site;
    const date = rfc822(row.first_seen ?? "");
    return [
      "  <item>",
      `   <title>${escapeXml(`[${fit.score}] ${title}`)}</title>`,
      `   <link>${escapeXml(link)}</link>`,
      `   <guid isPermaLink="false">hireme-${escapeXml(row.id)}</guid>`,
      date ? `   <pubDate>${date}</pubDate>` : "",
      `   <description>${escapeXml(describe(item))}</description>`,
      "  </item>",
    ].filter(Boolean).join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    " <channel>",
    "  <title>Hireme: new jobs for you</title>",
    `  <link>${escapeXml(site)}</link>`,
    `  <description>New jobs from the last ${FEED_DAYS} days that fit your CV ${minFit}/100 or better and are open to Europe.</description>`,
    "  <ttl>360</ttl>",
    ...entries,
    " </channel>",
    "</rss>",
    "",
  ].join("\n");
}
