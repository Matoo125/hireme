// Contact form on portfolio pages. Pages carry no contact details, so a
// visitor writes a message on the page and the server emails it to the page's
// owner, with Reply-To set to the visitor: the owner's address is never shown.
// The owner gives the address (the login token carries none) and confirms it
// from an emailed link, so the form can't be pointed at someone else's inbox.
// Settings live in data/contact/<id>.json.

import { timingSafeEqual } from "crypto";
import { readdir, unlink } from "fs/promises";
import path from "path";
import { emailProblem, type Email } from "./digest";
import { newToken } from "./feed";

export interface ContactSettings {
  email: string;
  confirmed: boolean;
  confirmToken: string;
  createdAt: string;
  confirmedAt: string | null;
  confirmSentAt: string | null;
  confirmSends: number[]; // confirmation emails sent (ms), last 24 hours only
  received: number[]; // messages forwarded (ms), last 24 hours only
}

export const MAX_MESSAGES_PER_DAY = 10;
export const LIMITS = { name: 100, email: 254, message: 3000 };

function contactPath(dir: string, userId: number): string {
  return path.join(dir, "contact", `${userId}.json`);
}

export async function readContact(dir: string, userId: number): Promise<ContactSettings | null> {
  const file = Bun.file(contactPath(dir, userId));
  return (await file.exists()) ? file.json() : null;
}

export async function writeContact(dir: string, userId: number, contact: ContactSettings): Promise<void> {
  await Bun.write(contactPath(dir, userId), JSON.stringify(contact, null, 1));
}

export async function removeContact(dir: string, userId: number): Promise<void> {
  await unlink(contactPath(dir, userId)).catch(() => {});
}

/** The contact settings whose confirmation token is `token`, or null. */
export async function findContactByToken(
  dir: string, token: string
): Promise<{ userId: number; contact: ContactSettings } | null> {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const names = await readdir(path.join(dir, "contact")).catch(() => [] as string[]);
  for (const name of names) {
    const match = name.match(/^(\d+)\.json$/);
    if (!match) continue;
    const contact = await readContact(dir, Number(match[1])).catch(() => null);
    const t = contact?.confirmToken ?? "";
    if (t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token))) {
      return { userId: Number(match[1]), contact: contact! };
    }
  }
  return null;
}

/** New, unconfirmed settings for `email`, keeping the send history so limits hold. */
export function newContact(email: string, previous: ContactSettings | null, now: Date): ContactSettings {
  return {
    email,
    confirmed: false,
    confirmToken: newToken(),
    createdAt: now.toISOString(),
    confirmedAt: null,
    confirmSentAt: null,
    confirmSends: previous?.confirmSends ?? [],
    received: previous?.received ?? [],
  };
}

/** Why another message can't be forwarded today, or null. */
export function messageLimit(contact: ContactSettings, now: number): string | null {
  const recent = contact.received.filter((t) => now - t < 86_400_000);
  return recent.length >= MAX_MESSAGES_PER_DAY
    ? "This person has had a lot of messages today; try again tomorrow"
    : null;
}

export function recordMessage(contact: ContactSettings, now: number): ContactSettings {
  return { ...contact, received: [...contact.received.filter((t) => now - t < 86_400_000), now] };
}

export interface ContactMessage {
  name: string;
  email: string;
  message: string;
}

/** The visitor's message from the form, checked, or why it can't be sent. */
export function cleanMessage(form: FormData): ContactMessage | { error: string } {
  const field = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  // Hidden from people; bots that fill every field get a quiet "sent".
  if (field("website")) return { error: "spam" };
  const msg = { name: field("name"), email: field("email"), message: field("message") };
  if (!msg.name) return { error: "Add your name" };
  if (msg.name.length > LIMITS.name || /[\r\n]/.test(msg.name)) return { error: "Shorten your name" };
  if (emailProblem(msg.email)) return { error: "Enter a valid email address, so they can reply" };
  if (msg.message.length < 10) return { error: "Write a message" };
  if (msg.message.length > LIMITS.message) return { error: `Keep the message under ${LIMITS.message} characters` };
  return msg;
}

const STYLE = "font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.5;max-width:600px";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function contactConfirmEmail(to: string, confirmUrl: string, site: string): Email {
  return {
    to,
    subject: "Confirm where your Hireme page's messages go",
    text: `Confirm this address to get messages people send from your Hireme page. Your address is never shown on the page.\n\n${confirmUrl}\n\nIf you didn't ask for this, ignore this email and nothing will be sent.\n\n${site}`,
    html: `<div style="${STYLE}"><p>Confirm this address to get messages people send from your Hireme page. Your address is never shown on the page.</p>
<p><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;padding:10px 16px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px">Confirm my address</a></p>
<p style="color:#666;font-size:13px">If you didn't ask for this, ignore this email and nothing will be sent.</p></div>`,
  };
}

/** The visitor's message, to the page's owner; replying goes to the visitor. */
export function messageEmail(to: string, msg: ContactMessage, pageUrl: string, site: string): Email {
  return {
    to,
    reply_to: msg.email,
    subject: `Message from ${msg.name} via your Hireme page`,
    text: `${msg.name} <${msg.email}> wrote from ${pageUrl}:\n\n${msg.message}\n\n—\nReply to this email to answer them. Hireme didn't check who they are.\nTurn messages off in your page settings: ${site}`,
    html: `<div style="${STYLE}"><p><strong>${escapeHtml(msg.name)}</strong> (${escapeHtml(msg.email)}) wrote from <a href="${escapeHtml(pageUrl)}">${escapeHtml(pageUrl)}</a>:</p>
<p style="white-space:pre-wrap;border-left:3px solid #ddd;padding-left:12px">${escapeHtml(msg.message)}</p>
<p style="color:#666;font-size:13px">Reply to this email to answer them. Hireme didn't check who they are. <a href="${escapeHtml(site)}" style="color:#666">Turn messages off</a> in your page settings.</p></div>`,
  };
}
