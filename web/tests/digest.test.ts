// Email digests: bun test (in web/). Which jobs a digest sends, the emails,
// the confirmation limits and storage in lib/digest.ts, and digest.ts end to
// end against a stand-in for Resend.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  confirmEmail, confirmLimit, digestEmail, digestItems, emailProblem, findDigest, newDigest,
  readDigest, recordConfirmSend, recordDigestSent, removeDigest, sendEmail, writeDigest,
  type DigestSettings,
} from "../lib/digest";

const TODAY = "2026-11-01";

function job(id: string, extra: Record<string, string> = {}): Record<string, string> {
  return { id, title: `Job ${id}`, organization_name: "Org", link: `https://example.org/${id}`,
    first_seen: "2026-10-31", europe: "yes", europe_reason: "", ...extra };
}

function confirmed(extra: Partial<DigestSettings> = {}): DigestSettings {
  return { ...newDigest("me@example.com", 60, null, new Date("2026-10-30T12:00:00Z")),
    confirmed: true, confirmedAt: "2026-10-30T12:00:00Z", ...extra };
}

describe("emailProblem", () => {
  test("accepts ordinary addresses, refuses others", () => {
    expect(emailProblem("jane.doe+jobs@example.co.uk")).toBeNull();
    for (const bad of ["", "jane", "jane@", "@example.com", "jane@example", "a b@example.com",
      "jane@example.com, evil@example.com", "<jane@example.com>"]) {
      expect(emailProblem(bad)).not.toBeNull();
    }
  });
});

describe("digestItems", () => {
  const scores = { a: { score: 80, reason: "" }, b: { score: 70, reason: "" }, c: { score: 90, reason: "" },
    d: { score: 50, reason: "" } };
  const rows = [job("a"), job("b"), job("c", { first_seen: "2026-10-29" }), job("d")];

  test("new since confirming, over the threshold, not yet sent", () => {
    expect(digestItems(rows, scores, confirmed(), TODAY).map((i) => i.row.id)).toEqual(["a", "b"]);
    expect(digestItems(rows, scores, confirmed({ sentIds: ["a"] }), TODAY).map((i) => i.row.id)).toEqual(["b"]);
  });

  test("nothing before confirming", () => {
    expect(digestItems(rows, scores, newDigest("me@example.com", 60, null, new Date()), TODAY)).toEqual([]);
  });

  test("recording a send remembers the jobs", () => {
    const items = digestItems(rows, scores, confirmed(), TODAY);
    const after = recordDigestSent(confirmed(), items, new Date("2026-11-01T07:00:00Z"));
    expect(after.sentIds).toEqual(["a", "b"]);
    expect(digestItems(rows, scores, after, TODAY)).toEqual([]);
  });

  test("a new address keeps what was sent and the send history", () => {
    const old = recordConfirmSend(confirmed({ sentIds: ["a"] }), 1000);
    const next = newDigest("new@example.com", 60, old, new Date());
    expect(next.confirmed).toBe(false);
    expect(next.sentIds).toEqual(["a"]);
    expect(next.confirmSends).toEqual([1000]);
    expect(next.confirmToken).not.toBe(old.confirmToken);
    expect(next.unsubscribeToken).not.toBe(old.unsubscribeToken);
  });
});

describe("confirmLimit", () => {
  test("one a minute, five a day", () => {
    const start = Date.parse("2026-11-01T10:00:00Z");
    let d = newDigest("me@example.com", 60, null, new Date(start));
    expect(confirmLimit(d, start)).toBeNull();
    d = recordConfirmSend(d, start);
    expect(confirmLimit(d, start + 30_000)).toMatch(/Wait/);
    for (let i = 1; i < 5; i++) d = recordConfirmSend(d, start + i * 120_000);
    expect(confirmLimit(d, start + 3_600_000)).toMatch(/Too many/);
    expect(confirmLimit(d, start + 86_400_000 + 600_000)).toBeNull();
  });
});

describe("emails", () => {
  const items = [
    { row: job("x", { title: "Ops <lead>", salary_range: "€50k", close_date: "2026-11-20" }), fit: { score: 82, reason: "Fits \"ops\"" } },
    { row: job("y", { link: "javascript:alert(1)", europe: "unclear", europe_reason: "No location" }), fit: { score: 61, reason: "Some" } },
  ];
  const email = digestEmail("me@example.com", items, "https://hireme.sk", "https://hireme.sk/digest/unsubscribe/abc", 60);

  test("subject counts the jobs and names the best new one", () => {
    expect(email.subject).toBe("2 new jobs for you on Hireme: Ops <lead>");
  });

  test("html is escaped and links only to http(s)", () => {
    expect(email.html).toContain("Ops &lt;lead&gt; — Org");
    expect(email.html).toContain("Fits &quot;ops&quot;");
    expect(email.html).not.toContain("javascript:");
    expect(email.html).toContain('href="https://example.org/x"');
  });

  test("text has the details and the unsubscribe link", () => {
    expect(email.text).toContain("[82] Ops <lead> — Org\nhttps://example.org/x\nFit 82: Fits \"ops\"\nSalary: €50k\nCloses 2026-11-20");
    expect(email.text).toContain("Europe: unclear (No location)");
    expect(email.text).toContain("Unsubscribe: https://hireme.sk/digest/unsubscribe/abc");
  });

  test("one-click unsubscribe headers", () => {
    expect(email.headers).toEqual({
      "List-Unsubscribe": "<https://hireme.sk/digest/unsubscribe/abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  test("confirmation email carries the link", () => {
    const c = confirmEmail("me@example.com", "https://hireme.sk/digest/confirm/t", "https://hireme.sk");
    expect(c.text).toContain("https://hireme.sk/digest/confirm/t");
    expect(c.html).toContain('href="https://hireme.sk/digest/confirm/t"');
  });

  test("sendEmail posts to Resend and reports its errors", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await sendEmail(email, { apiKey: "re_x", from: "Hireme <jobs@hireme.sk>" }, ok);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer re_x");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.from).toBe("Hireme <jobs@hireme.sk>");
    expect(body.to).toBe("me@example.com");
    const bad = (async () => new Response("domain not verified", { status: 403 })) as unknown as typeof fetch;
    await expect(sendEmail(email, { apiKey: "re_x", from: "x" }, bad)).rejects.toThrow("Resend 403: domain not verified");
  });
});

describe("storage and digest.ts", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), "hireme-digest-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test("finds digests by token, not after removal", async () => {
    const d = confirmed();
    await writeDigest(dir, 3, d);
    expect(await readDigest(dir, 3)).toEqual(d);
    expect((await findDigest(dir, "confirmToken", d.confirmToken))?.userId).toBe(3);
    expect((await findDigest(dir, "unsubscribeToken", d.unsubscribeToken))?.userId).toBe(3);
    expect(await findDigest(dir, "unsubscribeToken", d.confirmToken)).toBeNull();
    expect(await findDigest(dir, "confirmToken", "nope")).toBeNull();
    await removeDigest(dir, 3);
    expect(await findDigest(dir, "confirmToken", d.confirmToken)).toBeNull();
  });

  test("digest.ts sends once per new job, and only to confirmed users", async () => {
    const data = path.join(dir, "run");
    await mkdir(path.join(data, "fit"), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const csv = ["id,title,organization_name,link,first_seen,europe",
      `a,Job A,Org,https://example.org/a,${today},yes`,
      `b,Job B,Org,https://example.org/b,${today},no`].join("\n");
    await Bun.write(path.join(dir, "jobs.csv"), csv);
    const scores = { a: { score: 90, reason: "Good" }, b: { score: 95, reason: "Better" } };
    for (const id of [1, 2]) await Bun.write(path.join(data, "fit", `${id}.json`), JSON.stringify({ scores }));
    await writeDigest(data, 1, confirmed({ email: "one@example.com", confirmedAt: `${today}T00:00:00Z` }));
    await writeDigest(data, 2, newDigest("two@example.com", 60, null, new Date()));

    const received: { to: string; subject: string; headers: Record<string, string> }[] = [];
    const resend = Bun.serve({ port: 0, async fetch(req) {
      received.push(await req.json());
      return Response.json({ id: "x" });
    } });
    const run = async () => {
      const proc = Bun.spawn(["bun", "run", path.join(import.meta.dir, "..", "digest.ts")], {
        env: { ...process.env, JOBS_CSV: path.join(dir, "jobs.csv"), DATA_DIR: data, RESEND_API_KEY: "re_test",
          RESEND_API_URL: `http://127.0.0.1:${resend.port}/emails`, SITE_URL: "https://hireme.sk" },
        stdout: "pipe", stderr: "pipe",
      });
      return { code: await proc.exited, out: await new Response(proc.stdout).text() };
    };
    try {
      const first = await run();
      expect(first.code).toBe(0);
      expect(received.map((e) => e.to)).toEqual(["one@example.com"]);
      expect(received[0].subject).toBe("1 new job for you on Hireme: Job A");
      expect(received[0].headers["List-Unsubscribe"]).toContain("https://hireme.sk/digest/unsubscribe/");
      expect(first.out).not.toContain("@example.com"); // logs name users by id only
      expect((await readDigest(data, 1))?.sentIds).toEqual(["a"]);

      const second = await run();
      expect(second.code).toBe(0);
      expect(received).toHaveLength(1);
      expect(second.out).toContain("user 1: nothing new");
    } finally {
      resend.stop(true);
    }
  });
});
