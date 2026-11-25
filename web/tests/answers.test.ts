// Saved answers to common application questions: bun test (in web/). lib/answers.ts.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { STARTER_QUESTIONS, answersHash, cleanAnswers, readAnswers, writeAnswers } from "../lib/answers";

describe("cleanAnswers", () => {
  test("trims questions and answers", () => {
    expect(cleanAnswers({ answers: [{ question: " Salary ", answer: " 50k " }] })).toEqual([{ question: "Salary", answer: "50k" }]);
  });

  test("keeps entries not answered yet", () => {
    expect(cleanAnswers({ answers: [{ question: "Notice period", answer: "" }] })).toEqual([{ question: "Notice period", answer: "" }]);
  });

  const bad: [string, unknown][] = [
    ["no list", { answers: "x" }],
    ["no body", null],
    ["31 entries", { answers: Array.from({ length: 31 }, (_, i) => ({ question: `Q${i}`, answer: "" })) }],
    ["empty question", { answers: [{ question: "  ", answer: "a" }] }],
    ["question over 200", { answers: [{ question: "q".repeat(201), answer: "" }] }],
    ["answer over 2000", { answers: [{ question: "Q", answer: "a".repeat(2001) }] }],
    ["non-string field", { answers: [{ question: "Q", answer: 5 }] }],
    // A lone surrogate can't be encoded as UTF-8: drafting would fail on it.
    ["lone surrogate", { answers: [{ question: "Q", answer: "a\ud800b" }] }],
  ];
  for (const [name, body] of bad) {
    test(`refuses ${name}`, () => {
      expect(() => cleanAnswers(body)).toThrow();
    });
  }

  test("limits are inclusive", () => {
    const max = Array.from({ length: 30 }, (_, i) => ({ question: "q".repeat(200 - String(i).length) + i, answer: "a".repeat(2000) }));
    expect(cleanAnswers({ answers: max })).toHaveLength(30);
  });
});

test("hash matches application_draft.answers_hash", () => {
  // Same vectors as tests/test_application_draft.py.
  expect(answersHash([{ question: "Plat", answer: "60 000 € (hrubý)" }]))
    .toBe("871cb23289bdbd27b599c6311889128060f7479cd9cc4fa3645c771a12bcd890");
  expect(answersHash([])).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
});

test("starter questions", () => {
  expect(STARTER_QUESTIONS).toEqual([
    "Are you authorized to work in the EU / where are you based?",
    "Salary expectations",
    "Notice period / earliest start date",
    "LinkedIn, portfolio or GitHub links",
    "References (names and how to reach them)",
  ]);
});

test("written answers read back; none yet reads as empty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "answers-"));
  expect(await readAnswers(dir, 7)).toEqual([]);
  await writeAnswers(dir, 7, [{ question: "Salary", answer: "<b>50k</b>" }]);
  expect(await readAnswers(dir, 7)).toEqual([{ question: "Salary", answer: "<b>50k</b>" }]);
  await rm(dir, { recursive: true });
});
