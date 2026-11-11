// Contact form on portfolio pages: bun test (in web/). lib/contact.ts.

import { describe, expect, test } from "bun:test";
import {
  cleanMessage, MAX_MESSAGES_PER_DAY, messageEmail, messageLimit, newContact, recordMessage,
} from "../lib/contact";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const good = { name: "Ann Recruiter", email: "ann@example.org", message: "We'd like to talk about a role." };

describe("cleanMessage", () => {
  test("accepts a complete message, trimmed", () => {
    expect(cleanMessage(form({ ...good, name: "  Ann Recruiter " }))).toEqual(good);
  });

  test("rejects missing or bad fields", () => {
    expect(cleanMessage(form({ ...good, name: "" }))).toEqual({ error: "Add your name" });
    expect(cleanMessage(form({ ...good, name: "Ann\nBcc: x@y.z" }))).toEqual({ error: "Shorten your name" });
    expect("error" in cleanMessage(form({ ...good, email: "nope" }))).toBe(true);
    expect(cleanMessage(form({ ...good, message: "hi" }))).toEqual({ error: "Write a message" });
    expect("error" in cleanMessage(form({ ...good, message: "x".repeat(3001) }))).toBe(true);
  });

  test("flags the hidden field bots fill in", () => {
    expect(cleanMessage(form({ ...good, website: "http://spam" }))).toEqual({ error: "spam" });
  });
});

describe("limits", () => {
  test("allows a set number of messages a day, then refuses", () => {
    const now = Date.now();
    let contact = newContact("me@example.org", null, new Date(now));
    for (let i = 0; i < MAX_MESSAGES_PER_DAY; i++) {
      expect(messageLimit(contact, now)).toBeNull();
      contact = recordMessage(contact, now);
    }
    expect(messageLimit(contact, now)).not.toBeNull();
    expect(messageLimit(contact, now + 86_400_001)).toBeNull();
  });

  test("a new address keeps the send history, so limits can't be reset", () => {
    const old = recordMessage({ ...newContact("a@example.org", null, new Date()), confirmSends: [1] }, Date.now());
    const fresh = newContact("b@example.org", old, new Date());
    expect(fresh.confirmed).toBe(false);
    expect(fresh.confirmSends).toEqual([1]);
    expect(fresh.received).toEqual(old.received);
    expect(fresh.confirmToken).not.toBe(old.confirmToken);
  });
});

describe("messageEmail", () => {
  test("goes to the owner, replies to the visitor, and escapes the visitor's text", () => {
    const email = messageEmail("me@example.org", { ...good, message: "<img src=x onerror=alert(1)>" }, "https://jane.hireme.sk/", "https://hireme.sk");
    expect(email.to).toBe("me@example.org");
    expect(email.reply_to).toBe("ann@example.org");
    expect(email.subject).toBe("Message from Ann Recruiter via your Hireme page");
    expect(email.html).not.toContain("<img");
    expect(email.text).toContain("<img src=x onerror=alert(1)>");
  });
});
