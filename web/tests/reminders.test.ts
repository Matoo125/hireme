// Deadline reminders: bun test (in web/). lib/reminders.ts.

import { describe, expect, test } from "bun:test";
import { recordReminded, reminderEmail, reminderItems, reminderKey } from "../lib/reminders";

const TODAY = "2026-11-11";
const job = (id: string, close_date: string, title = `Job ${id}`) =>
  ({ id, title, organization_name: "Org", link: `https://example.org/${id}`, close_date });

const ROWS = [
  job("today", "2026-11-11"),
  job("in3", "2026-11-14"),
  job("in4", "2026-11-15"),
  job("past", "2026-11-10"),
  job("open", ""),
  job("tracked", "2026-11-12"),
  job("applied", "2026-11-12"),
  job("hidden", "2026-11-12"),
  job("unsaved", "2026-11-12"),
];
const PREFS = { liked: ["today", "in3", "in4", "past", "open", "hidden"], hidden: ["hidden"] };
const APPS = { tracked: { status: "interested" }, applied: { status: "applied" } };
const ids = (items: { row: { id: string } }[]) => items.map((i) => i.row.id);

describe("reminderItems", () => {
  test("liked or tracked, not applied or hidden, closing within 3 days, soonest first", () => {
    const items = reminderItems(ROWS, PREFS, APPS, {}, TODAY);
    expect(ids(items)).toEqual(["today", "tracked", "in3"]);
    expect(items.map((i) => i.daysLeft)).toEqual([0, 1, 3]);
    expect(items.find((i) => i.row.id === "tracked")?.tracked).toBe(true);
  });

  test("reminds once per close date, again if the deadline moves", () => {
    const first = reminderItems(ROWS, PREFS, APPS, {}, TODAY);
    const digest = recordReminded({ remindedKeys: [] }, first);
    expect(reminderItems(ROWS, PREFS, APPS, digest, TODAY)).toEqual([]);
    const extended = ROWS.map((r) => (r.id === "in3" ? { ...r, close_date: "2026-11-13" } : r));
    expect(ids(reminderItems(extended, PREFS, APPS, digest, TODAY))).toEqual(["in3"]);
  });

  test("nothing when the user turned reminders off", () => {
    expect(reminderItems(ROWS, PREFS, APPS, { reminders: false }, TODAY)).toEqual([]);
  });

  test("keys are job id and close date", () => {
    expect(reminderKey(job("a", "2026-12-01"))).toBe("a@2026-12-01");
  });
});

describe("reminderEmail", () => {
  test("one job: names it in the subject; escapes titles; carries unsubscribe headers", () => {
    const items = reminderItems([job("x", "2026-11-12", "<b>Analyst</b>")], { liked: ["x"] }, {}, {}, TODAY);
    const email = reminderEmail("me@example.org", items, "https://hireme.sk", "https://hireme.sk/digest/unsubscribe/t");
    expect(email.subject).toBe("Closing soon: <b>Analyst</b> closes tomorrow");
    expect(email.html).toContain("&lt;b&gt;Analyst&lt;/b&gt;");
    expect(email.html).not.toContain("<b>Analyst</b>");
    expect(email.text).toContain("closes tomorrow (2026-11-12)");
    expect(email.headers?.["List-Unsubscribe"]).toBe("<https://hireme.sk/digest/unsubscribe/t>");
  });

  test("several jobs: counts them in the subject", () => {
    const items = reminderItems(ROWS, PREFS, APPS, {}, TODAY);
    expect(reminderEmail("me@example.org", items, "https://hireme.sk", "u").subject).toBe("3 jobs you saved close soon");
  });
});
