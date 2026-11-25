// Follow-up nudges: bun test (in web/). lib/follow-ups.ts.

import { describe, expect, test } from "bun:test";
import { FOLLOW_UP_DAYS, followUpEmail, followUpItems, followUpKey, recordFollowedUp } from "../lib/follow-ups";

const TODAY = "2026-11-25";
const job = (id: string, title = `Job ${id}`) =>
  ({ id, title, organization_name: "Org", link: `https://example.org/${id}`, close_date: "" });
const ROWS = ["old", "fresh", "edge", "interested", "interviewing", "gone"].map((id) => job(id));
const at = (day: string) => `${day}T09:00:00.000Z`;
const APPS = {
  old: { status: "applied", updatedAt: at("2026-11-01") },
  fresh: { status: "applied", updatedAt: at("2026-11-20") },
  edge: { status: "applied", updatedAt: at("2026-11-11") }, // exactly 14 days
  interested: { status: "interested", updatedAt: at("2026-10-01") },
  interviewing: { status: "interviewing", updatedAt: at("2026-10-01") },
  missing: { status: "applied", updatedAt: at("2026-10-01") }, // no longer listed
};
const ids = (items: { row: { id: string } }[]) => items.map((i) => i.row.id);

describe("followUpItems", () => {
  test("applied, unchanged for FOLLOW_UP_DAYS or more, longest waiting first", () => {
    expect(FOLLOW_UP_DAYS).toBe(14);
    const items = followUpItems(ROWS, APPS, {}, TODAY);
    expect(ids(items)).toEqual(["old", "edge"]);
    expect(items.map((i) => i.daysWaiting)).toEqual([24, 14]);
  });

  test("once per quiet spell; again after the application changes and goes quiet", () => {
    const digest = recordFollowedUp({ remindedKeys: [] }, followUpItems(ROWS, APPS, {}, TODAY));
    expect(followUpItems(ROWS, APPS, digest, TODAY)).toEqual([]);
    const touched = { old: { status: "applied", updatedAt: at("2026-11-26") } };
    expect(followUpItems(ROWS, touched, digest, "2026-12-09")).toEqual([]);
    expect(ids(followUpItems(ROWS, touched, digest, "2026-12-10"))).toEqual(["old"]);
  });

  test("nothing when the user turned reminders off", () => {
    expect(followUpItems(ROWS, APPS, { reminders: false }, TODAY)).toEqual([]);
  });

  test("key is job id and the day it last changed, apart from deadline keys", () => {
    expect(followUpKey("a", at("2026-11-01"))).toBe("follow-up:a@2026-11-01");
  });
});

describe("followUpEmail", () => {
  test("one: names it; escapes; says how long; unsubscribe headers", () => {
    const items = followUpItems([job("x", "<b>Analyst</b>")], { x: APPS.old }, {}, TODAY);
    const email = followUpEmail("me@example.org", items, "https://hireme.sk", "https://hireme.sk/digest/unsubscribe/t");
    expect(email.subject).toBe("Follow up? No news on <b>Analyst</b> for 24 days");
    expect(email.html).toContain("&lt;b&gt;Analyst&lt;/b&gt;");
    expect(email.html).not.toContain("<b>Analyst</b>");
    expect(email.text).toContain("applied, no change for 24 days");
    expect(email.headers?.["List-Unsubscribe"]).toBe("<https://hireme.sk/digest/unsubscribe/t>");
  });

  test("several: counts them", () => {
    const items = followUpItems(ROWS, APPS, {}, TODAY);
    expect(followUpEmail("me@example.org", items, "https://hireme.sk", "u").subject).toBe("2 applications to follow up on");
  });
});
