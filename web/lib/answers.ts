// Saved answers to common application questions (data/answers/<id>.json):
// written once in the sidebar, used by application_draft.py and shown in
// each tracked job's kit, so they needn't be typed for every application.

import { mkdir } from "fs/promises";
import path from "path";
import { writeFileAtomic } from "./write-file";

export type SavedAnswer = { question: string; answer: string };

export const MAX_ANSWERS = 30;
export const MAX_QUESTION = 200;
export const MAX_ANSWER = 2000;

/** Offered, unanswered, to a user who has saved none. */
export const STARTER_QUESTIONS = [
  "Are you authorized to work in the EU / where are you based?",
  "Salary expectations",
  "Notice period / earliest start date",
  "LinkedIn, portfolio or GitHub links",
  "References (names and how to reach them)",
];

/** The answers in a PUT body, trimmed; throws with the reason when invalid. */
export function cleanAnswers(body: unknown): SavedAnswer[] {
  const list = (body as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(list)) throw new Error("answers must be a list");
  if (list.length > MAX_ANSWERS) throw new Error(`At most ${MAX_ANSWERS} saved answers`);
  return list.map((entry, i) => {
    const { question, answer } = (entry ?? {}) as Record<string, unknown>;
    if (typeof question !== "string" || typeof answer !== "string") throw new Error(`Entry ${i + 1}: question and answer must be text`);
    // Lone surrogates can't be written as UTF-8 (application_draft.py would fail).
    if (!question.isWellFormed() || !answer.isWellFormed()) throw new Error(`Entry ${i + 1}: contains a broken character`);
    const q = question.trim();
    const a = answer.trim();
    if (!q) throw new Error(`Entry ${i + 1}: the question is empty`);
    if (q.length > MAX_QUESTION) throw new Error(`Entry ${i + 1}: questions are at most ${MAX_QUESTION} characters`);
    if (a.length > MAX_ANSWER) throw new Error(`Entry ${i + 1}: answers are at most ${MAX_ANSWER} characters`);
    return { question: q, answer: a };
  });
}

/** sha256 of the answers as JSON.stringify writes them; application_draft.py
 * (answers_hash) stores the same in each draft, so a draft made from other
 * answers can be told apart. */
export function answersHash(answers: SavedAnswer[]): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(answers)).digest("hex");
}

function answersPath(dataDir: string, userId: number): string {
  return path.join(dataDir, "answers", `${userId}.json`);
}

export async function readAnswers(dataDir: string, userId: number): Promise<SavedAnswer[]> {
  const file = Bun.file(answersPath(dataDir, userId));
  return (await file.exists()) ? await file.json() : [];
}

export async function writeAnswers(dataDir: string, userId: number, answers: SavedAnswer[]): Promise<void> {
  await mkdir(path.join(dataDir, "answers"), { recursive: true });
  await writeFileAtomic(answersPath(dataDir, userId), JSON.stringify(answers));
}
