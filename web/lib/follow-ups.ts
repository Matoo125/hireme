// Follow-up nudges, sent with the email digest (digest.ts) like the deadline
// reminders (lib/reminders.ts), and turned off with them: applications marked
// "applied" that haven't changed for FOLLOW_UP_DAYS days. Each is nudged once
// per quiet spell: any change to the application (status, notes, letter)
// starts a new one. Jobs no longer listed are skipped, for want of a title.

import { httpLink } from "./feed";
import type { DigestSettings, Email } from "./digest";

export const FOLLOW_UP_DAYS = 14;
const MAX_REMINDED = 2000; // as in lib/reminders.ts: the keys share one list

export interface FollowUpItem {
  row: Record<string, string>;
  daysWaiting: number;
  key: string;
}

/** Remembered in remindedKeys next to the deadline reminders' keys. */
export function followUpKey(jobId: string, updatedAt: string): string {
  return `follow-up:${jobId}@${updatedAt.slice(0, 10)}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Applications to nudge today, longest waiting first. */
export function followUpItems(
  rows: Record<string, string>[],
  apps: Record<string, { status?: string; updatedAt?: string }>,
  digest: Pick<DigestSettings, "reminders" | "remindedKeys">,
  today: string
): FollowUpItem[] {
  if (digest.reminders === false) return [];
  const reminded = new Set(digest.remindedKeys ?? []);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: FollowUpItem[] = [];
  for (const [id, app] of Object.entries(apps)) {
    const row = byId.get(id);
    if (!row || app.status !== "applied" || !/^\d{4}-\d{2}-\d{2}/.test(app.updatedAt ?? "")) continue;
    const daysWaiting = daysBetween(app.updatedAt!.slice(0, 10), today);
    const key = followUpKey(id, app.updatedAt!);
    if (daysWaiting < FOLLOW_UP_DAYS || reminded.has(key)) continue;
    out.push({ row, daysWaiting, key });
  }
  return out.sort((a, b) => b.daysWaiting - a.daysWaiting || a.row.title.localeCompare(b.row.title));
}

export function recordFollowedUp<T extends Pick<DigestSettings, "remindedKeys">>(digest: T, items: FollowUpItem[]): T {
  return { ...digest, remindedKeys: [...(digest.remindedKeys ?? []), ...items.map((i) => i.key)].slice(-MAX_REMINDED) };
}

const STYLE = "font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.5;max-width:600px";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function followUpEmail(to: string, items: FollowUpItem[], site: string, unsubscribeUrl: string): Email {
  const first = items[0];
  const subject = items.length === 1
    ? `Follow up? No news on ${first.row.title} for ${first.daysWaiting} days`
    : `${items.length} applications to follow up on`;
  const heading = (row: Record<string, string>) =>
    row.organization_name ? `${row.title} — ${row.organization_name}` : row.title;
  const settings = `${site}/#digestSection`;
  const intro = "Applications you sent with no news since. A short, polite note to ask where things stand often gets an answer, and if you've heard back, update the status on Hireme.";

  const text = [
    intro,
    "",
    ...items.flatMap((i) => [`${heading(i.row)}: applied, no change for ${i.daysWaiting} days`, httpLink(i.row.link) ?? site, ""]),
    `Your applications: ${site}/?view=tracked`,
    "",
    `Stop reminders: turn them off in your digest settings (${settings}). Unsubscribe from all email: ${unsubscribeUrl}`,
  ].join("\n");

  const cards = items.map((i) => `<div style="margin:0 0 16px">
<div><a href="${escapeHtml(httpLink(i.row.link) ?? site)}" style="color:#1a1a1a;font-weight:600">${escapeHtml(heading(i.row))}</a></div>
<div style="color:#666;font-size:14px">Applied, no change for ${i.daysWaiting} days</div>
</div>`);
  const html = `<div style="${STYLE}">
<p>${escapeHtml(intro)}</p>
${cards.join("\n")}
<p><a href="${escapeHtml(`${site}/?view=tracked`)}" style="color:#2a5aa8">Your applications on Hireme</a></p>
<p style="color:#666;font-size:13px;border-top:1px solid #ddd;padding-top:12px">Turn reminders off in your <a href="${escapeHtml(settings)}" style="color:#666">digest settings</a> · <a href="${escapeHtml(unsubscribeUrl)}" style="color:#666">Unsubscribe from all email</a></p>
</div>`;

  return {
    to,
    subject,
    text,
    html,
    headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
