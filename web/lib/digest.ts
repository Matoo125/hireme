// Email digests of new, well-fitting jobs, sent through Resend. A logged-in
// user gives an address (the login token carries none), confirms it from an
// emailed link, and then gets one email after each daily scrape that found
// new jobs for them: the same selection as their RSS feed (lib/feed.ts), less
// jobs already emailed and jobs seen before they confirmed. Every email has a
// one-click unsubscribe link. Settings live in data/digests/<id>.json.

import { timingSafeEqual } from "crypto";
import { readdir, unlink } from "fs/promises";
import path from "path";
import { feedItems, httpLink, newToken, type FeedItem, type FitScore } from "./feed";

export interface DigestSettings {
  email: string;
  confirmed: boolean;
  confirmToken: string; // in the confirmation link; kept so a resent email reuses it
  unsubscribeToken: string; // in every digest's unsubscribe link
  minFit: number;
  createdAt: string;
  confirmedAt: string | null;
  confirmSentAt: string | null;
  confirmSends: number[]; // when confirmation emails went out (ms), last 24 hours only
  lastSentAt: string | null;
  sentIds: string[]; // jobs already emailed, newest last
  reminders?: boolean; // deadline reminders (lib/reminders.ts); missing means on
  remindedKeys?: string[]; // "<job id>@<close date>" already reminded, newest last
}

// &#39; rather than &apos;, which older mail clients show as is.
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const MAX_CONFIRMS_PER_DAY = 5;
export const CONFIRM_GAP_MS = 60_000;
const MAX_SENT_IDS = 2000;
const EMAIL_PATTERN = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[a-z]{2,}$/i;

export function emailProblem(email: string): string | null {
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return "Enter a valid email address";
  return null;
}

function digestPath(dir: string, userId: number): string {
  return path.join(dir, "digests", `${userId}.json`);
}

export async function readDigest(dir: string, userId: number): Promise<DigestSettings | null> {
  const file = Bun.file(digestPath(dir, userId));
  return (await file.exists()) ? file.json() : null;
}

export async function writeDigest(dir: string, userId: number, digest: DigestSettings): Promise<void> {
  await Bun.write(digestPath(dir, userId), JSON.stringify(digest, null, 1));
}

export async function removeDigest(dir: string, userId: number): Promise<void> {
  await unlink(digestPath(dir, userId)).catch(() => {});
}

export async function allDigests(dir: string): Promise<{ userId: number; digest: DigestSettings }[]> {
  const names = await readdir(path.join(dir, "digests")).catch(() => [] as string[]);
  const out = [];
  for (const name of names) {
    const match = name.match(/^(\d+)\.json$/);
    if (!match) continue;
    const userId = Number(match[1]);
    const digest = await readDigest(dir, userId).catch(() => null);
    if (digest) out.push({ userId, digest });
  }
  return out;
}

function sameToken(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The digest whose confirm or unsubscribe token is `token`, or null. */
export async function findDigest(
  dir: string,
  kind: "confirmToken" | "unsubscribeToken",
  token: string
): Promise<{ userId: number; digest: DigestSettings } | null> {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  for (const entry of await allDigests(dir)) {
    if (sameToken(entry.digest[kind], token)) return entry;
  }
  return null;
}

/** A new, unconfirmed digest for `email`, keeping what the old one had sent. */
export function newDigest(email: string, minFit: number, previous: DigestSettings | null, now: Date): DigestSettings {
  return {
    email,
    confirmed: false,
    confirmToken: newToken(),
    unsubscribeToken: newToken(),
    minFit,
    createdAt: now.toISOString(),
    confirmedAt: null,
    confirmSentAt: null,
    confirmSends: previous?.confirmSends ?? [],
    lastSentAt: previous?.lastSentAt ?? null,
    sentIds: previous?.sentIds ?? [],
    reminders: previous?.reminders ?? true,
    remindedKeys: previous?.remindedKeys ?? [],
  };
}

/** Why a confirmation email can't go out now (too soon, too many today), or null. */
export function confirmLimit(digest: { confirmSends: number[] }, now: number): string | null {
  const recent = digest.confirmSends.filter((t) => now - t < 86_400_000);
  if (recent.length >= MAX_CONFIRMS_PER_DAY) return "Too many confirmation emails today; try again tomorrow";
  if (recent.length && now - recent[recent.length - 1] < CONFIRM_GAP_MS) return "Wait a minute before sending another";
  return null;
}

export function recordConfirmSend<T extends { confirmSends: number[]; confirmSentAt: string | null }>(
  digest: T, now: number
): T {
  return {
    ...digest,
    confirmSentAt: new Date(now).toISOString(),
    confirmSends: [...digest.confirmSends.filter((t) => now - t < 86_400_000), now],
  };
}

/** Jobs to email: the feed's selection, first seen since confirming and not emailed yet. */
export function digestItems(
  rows: Record<string, string>[],
  scores: Record<string, FitScore>,
  digest: DigestSettings,
  today: string
): FeedItem[] {
  if (!digest.confirmed || !digest.confirmedAt) return [];
  const since = digest.confirmedAt.slice(0, 10);
  const sent = new Set(digest.sentIds);
  return feedItems(rows, scores, digest.minFit, today).filter(
    (item) => !sent.has(item.row.id) && (item.row.first_seen ?? "") >= since
  );
}

export function recordDigestSent(digest: DigestSettings, items: FeedItem[], now: Date): DigestSettings {
  return {
    ...digest,
    lastSentAt: now.toISOString(),
    sentIds: [...digest.sentIds, ...items.map((i) => i.row.id)].slice(-MAX_SENT_IDS),
  };
}

// ── Emails ───────────────────────────────────────────────────────────────────

export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  headers?: Record<string, string>;
}

const STYLE = "font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.5;max-width:600px";

export function confirmEmail(to: string, confirmUrl: string, site: string): Email {
  return {
    to,
    subject: "Confirm your Hireme job digest",
    text: `Confirm this address to get an email when Hireme finds new jobs that fit your CV:\n\n${confirmUrl}\n\nIf you didn't ask for this, ignore this email and nothing will be sent.\n\n${site}`,
    html: `<div style="${STYLE}"><p>Confirm this address to get an email when Hireme finds new jobs that fit your CV.</p>
<p><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;padding:10px 16px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px">Confirm my address</a></p>
<p style="color:#666;font-size:13px">If you didn't ask for this, ignore this email and nothing will be sent.</p></div>`,
  };
}

export function digestEmail(to: string, items: FeedItem[], site: string, unsubscribeUrl: string, minFit: number): Email {
  const count = items.length === 1 ? "1 new job" : `${items.length} new jobs`;
  const subject = `${count} for you on Hireme` + (items[0] ? `: ${items[0].row.title}` : "");
  const lines = (item: FeedItem) => {
    const { row, fit } = item;
    const out = [`Fit ${fit.score}: ${fit.reason}`];
    if (row.europe === "unclear") out.push("Europe: unclear" + (row.europe_reason ? ` (${row.europe_reason})` : ""));
    if (row.salary_range) out.push(`Salary: ${row.salary_range}`);
    if (row.close_date) out.push(`Closes ${row.close_date}`);
    return out;
  };
  const heading = (row: Record<string, string>) =>
    row.organization_name ? `${row.title} — ${row.organization_name}` : row.title;

  const text = [
    `${count} that fit your CV ${minFit}/100 or better:`,
    "",
    ...items.flatMap((item) => [
      `[${item.fit.score}] ${heading(item.row)}`,
      httpLink(item.row.link) ?? site,
      ...lines(item),
      "",
    ]),
    `All jobs: ${site}`,
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  const cards = items.map((item) => {
    const link = httpLink(item.row.link) ?? site;
    return `<div style="margin:0 0 20px">
<div><span style="display:inline-block;min-width:28px;padding:1px 6px;margin-right:6px;border-radius:4px;background:#e6f4ea;color:#14532d;font-weight:600;text-align:center">${item.fit.score}</span><a href="${escapeHtml(link)}" style="color:#1a1a1a;font-weight:600">${escapeHtml(heading(item.row))}</a></div>
${lines(item).map((l) => `<div style="color:#444;font-size:14px">${escapeHtml(l)}</div>`).join("\n")}
</div>`;
  });
  const html = `<div style="${STYLE}">
<p>${escapeHtml(count)} that fit your CV ${minFit}/100 or better and are open to Europe:</p>
${cards.join("\n")}
<p style="color:#666;font-size:13px;border-top:1px solid #ddd;padding-top:12px"><a href="${escapeHtml(site)}" style="color:#666">All jobs on Hireme</a> · <a href="${escapeHtml(unsubscribeUrl)}" style="color:#666">Unsubscribe</a></p>
</div>`;

  return {
    to,
    subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** Send through Resend; throws with Resend's message on failure. */
export async function sendEmail(
  email: Email,
  config: { apiKey: string; from: string; url?: string },
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const res = await fetchImpl(config.url ?? "https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.from, ...email }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
}

// ── Pages for the emailed links ──────────────────────────────────────────────
// The links open a page with a button that POSTs, so mail scanners that
// follow links don't confirm or unsubscribe on someone's behalf.

export const LINK_PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

export function linkPage(message: string, site: string, button?: { action: string; label: string }): string {
  const form = button
    ? `<form method="post" action="${escapeHtml(button.action)}"><button type="submit" style="padding:10px 16px;font-size:16px;border-radius:6px;border:0;background:#1a1a1a;color:#fff;cursor:pointer">${escapeHtml(button.label)}</button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hireme</title></head>
<body style="margin:0;padding:48px 16px;background:#fafafa"><div style="${STYLE};margin:0 auto">
<h1 style="font-size:22px">Hireme job digest</h1><p>${escapeHtml(message)}</p>${form}
<p><a href="${escapeHtml(site)}" style="color:#444">Back to Hireme</a></p></div></body></html>`;
}
