// Deadline reminders, sent with the email digest (digest.ts) to the same
// confirmed address: jobs the user liked or tracks but hasn't applied to yet,
// closing within REMIND_DAYS days. Each job is reminded once per close date,
// so an extended deadline gets a new reminder. On by default for digest
// subscribers; `reminders: false` in their digest settings turns it off.

import { httpLink } from "./feed";
import type { DigestSettings, Email } from "./digest";

export const REMIND_DAYS = 3;
const MAX_REMINDED = 2000;

// Statuses that mean the user still has to apply.
const NOT_APPLIED = new Set(["interested"]);

export interface ReminderItem {
  row: Record<string, string>;
  daysLeft: number;
  tracked: boolean;
}

/** The key a reminder is remembered by: the job and the date it closes. */
export function reminderKey(row: Record<string, string>): string {
  return `${row.id}@${row.close_date}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Jobs to remind about today, soonest first. */
export function reminderItems(
  rows: Record<string, string>[],
  prefs: { liked?: string[]; hidden?: string[] },
  apps: Record<string, { status?: string }>,
  digest: Pick<DigestSettings, "reminders" | "remindedKeys">,
  today: string
): ReminderItem[] {
  if (digest.reminders === false) return [];
  const liked = new Set(prefs.liked ?? []);
  const hidden = new Set(prefs.hidden ?? []);
  const reminded = new Set(digest.remindedKeys ?? []);
  const out: ReminderItem[] = [];
  for (const row of rows) {
    const app = apps[row.id];
    if (!liked.has(row.id) && !app) continue;
    if (hidden.has(row.id)) continue;
    if (app && !NOT_APPLIED.has(app.status ?? "interested")) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.close_date ?? "")) continue;
    const daysLeft = daysBetween(today, row.close_date);
    if (daysLeft < 0 || daysLeft > REMIND_DAYS) continue;
    if (reminded.has(reminderKey(row))) continue;
    out.push({ row, daysLeft, tracked: Boolean(app) });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.row.title.localeCompare(b.row.title));
}

export function recordReminded<T extends Pick<DigestSettings, "remindedKeys">>(digest: T, items: ReminderItem[]): T {
  return { ...digest, remindedKeys: [...(digest.remindedKeys ?? []), ...items.map((i) => reminderKey(i.row))].slice(-MAX_REMINDED) };
}

const STYLE = "font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.5;max-width:600px";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function when(daysLeft: number): string {
  return daysLeft === 0 ? "closes today" : daysLeft === 1 ? "closes tomorrow" : `closes in ${daysLeft} days`;
}

export function reminderEmail(to: string, items: ReminderItem[], site: string, unsubscribeUrl: string): Email {
  const first = items[0];
  const subject = items.length === 1
    ? `Closing soon: ${first.row.title} ${when(first.daysLeft)}`
    : `${items.length} jobs you saved close soon`;
  const heading = (row: Record<string, string>) =>
    row.organization_name ? `${row.title} — ${row.organization_name}` : row.title;
  const settings = `${site}/#digestSection`;

  const text = [
    "Jobs you saved that you haven't applied to yet:",
    "",
    ...items.flatMap((i) => [
      `${heading(i.row)}: ${when(i.daysLeft)} (${i.row.close_date})`,
      httpLink(i.row.link) ?? site,
      "",
    ]),
    `Draft an application from your CV on Hireme: track the job, then "Draft application". ${site}`,
    "",
    `Stop reminders: turn them off in your digest settings (${settings}). Unsubscribe from all email: ${unsubscribeUrl}`,
  ].join("\n");

  const cards = items.map((i) => {
    const link = httpLink(i.row.link) ?? site;
    const color = i.daysLeft <= 1 ? "#a4372a" : "#7a5a00";
    return `<div style="margin:0 0 16px">
<div><a href="${escapeHtml(link)}" style="color:#1a1a1a;font-weight:600">${escapeHtml(heading(i.row))}</a></div>
<div style="color:${color};font-size:14px">${escapeHtml(when(i.daysLeft))} (${escapeHtml(i.row.close_date)})</div>
</div>`;
  });
  const html = `<div style="${STYLE}">
<p>Jobs you saved that you haven't applied to yet:</p>
${cards.join("\n")}
<p>Short on time? On <a href="${escapeHtml(site)}" style="color:#2a5aa8">Hireme</a>, track the job and press <strong>Draft application</strong> for a cover letter drafted from your CV.</p>
<p style="color:#666;font-size:13px;border-top:1px solid #ddd;padding-top:12px">Turn reminders off in your <a href="${escapeHtml(settings)}" style="color:#666">digest settings</a> · <a href="${escapeHtml(unsubscribeUrl)}" style="color:#666">Unsubscribe from all email</a></p>
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
