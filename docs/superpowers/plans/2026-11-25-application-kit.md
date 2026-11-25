# Application Kit and Saved Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing per-job application draft into a kit the user can apply from in a few minutes: their saved answers to common questions feed the draft, the draft adds a checklist of what the application needs and its stated deadline, and every piece can be copied with one click. The user still submits every application themselves.

**Architecture:** Saved answers are one more per-user JSON file (`data/answers/<id>.json`) behind `GET/PUT /api/answers`, edited in a new sidebar section. `application_draft.py` (already writes letter, answers to the posting's questions, gaps) reads them into the prompt and gains `checklist` and `deadline` fields (`DRAFT_VERSION` 2). The tracked job's draft panel shows the checklist with ticks saved on the application, and copy buttons.

**Tech Stack:** Python 3 + anthropic SDK (`messages.parse`, pydantic schema), Bun server (`web/server.ts`), vanilla JS frontend (`web/public/app.js`), `bun test`, `python -m unittest`, browser tests (`web/tests/browser/*.js`, run with `CHROMIUM=google-chrome bun tests/browser/run.ts <name>`).

**Spec:** No separate spec. The design is the proposal agreed in conversation on 2026-11-25 ("application kit" + "saved answers", items 1 and 2), restated here: do everything up to the submit button, leave the submit to the user.

## Global Constraints

- Nothing is ever submitted, emailed or posted to an employer. The kit only prepares text.
- Never invent facts: the prompt keeps its rule "Use only what the CV shows"; saved answers are an additional source the model may use, verbatim where they answer a question.
- Saved answers limits: at most 30 entries; `question` 1–200 characters, `answer` 0–2000 characters, both trimmed; anything else is a 400 with a reason.
- Starter questions offered (pre-filled, empty answers) when the user has none: "Are you authorized to work in the EU / where are you based?", "Salary expectations", "Notice period / earliest start date", "LinkedIn, portfolio or GitHub links", "References (names and how to reach them)".
- Per-user files are written with `writeFileAtomic` (`web/lib/write-file.ts`); Python writes use `write_json` from `cv_advice.py`.
- All user text reaches the DOM through `textContent`, never `innerHTML`.
- Update `SPEC.md` in the same branch (§3 per-user data list, the drafts paragraph, §5 API table).

## Review Focus

1. **Drafts made before this change** (version 1: no `checklist`, no `deadline`): the panel must render them without errors and offer "Draft again".
2. **Saved answers changed after a draft:** the draft no longer reflects them; status must say so (`stale`) instead of silently showing an outdated kit.
3. **Clipboard unavailable** (insecure context, denied permission): the copy button must select the text and say "Press Ctrl+C to copy" instead of failing silently.
4. **Checklist ticks after "Draft again":** items are matched by text; ticks for items that no longer exist are dropped, ticks for unchanged items survive.
5. **Saved answer containing markup or brackets** (`<b>`, `[x]`): shown as plain text in the sidebar and the kit, and passed to the model unchanged.

---

### Task 1: Saved answers store and API

**Files:**
- Create: `web/lib/answers.ts`
- Modify: `web/server.ts` (new route next to `/api/preferences`). Deleting the CV must **not** delete saved answers: they don't come from the CV.
- Test: `web/tests/answers.test.ts`

**Interfaces:**
- Produces:
  - `type SavedAnswer = { question: string; answer: string }`
  - `STARTER_QUESTIONS: string[]` (the five from Global Constraints, in that order)
  - `cleanAnswers(body: unknown): SavedAnswer[]` — throws `Error(reason)` on invalid input
  - `readAnswers(dir: string, userId: number): Promise<SavedAnswer[]>` — `[]` when no file
  - `writeAnswers(dir: string, userId: number, answers: SavedAnswer[]): Promise<void>`
  - `GET /api/answers` → `{ answers: SavedAnswer[], starters: string[] }`; `PUT /api/answers {answers}` → `{ answers }`, 400 `{error}` from `cleanAnswers`. Auth required (same `verifyToken` pattern as `/api/preferences`).
  - File: `data/answers/<id>.json` = `SavedAnswer[]`.

- [ ] **Step 1: Write the failing tests** in `web/tests/answers.test.ts`:
  - `cleanAnswers({answers: [{question: " Salary ", answer: " 50k "}]})` → `[{question: "Salary", answer: "50k"}]`
  - throws on: not an array; 31 entries; empty question; question of 201 chars; answer of 2001 chars; non-string fields
  - entries with an empty answer are kept (the user may fill them later)
  - `writeAnswers` then `readAnswers` round-trips in a temp dir; `readAnswers` on a missing file → `[]`
- [ ] **Step 2: Run** `cd web && bun test tests/answers.test.ts` — expect FAIL (module not found)
- [ ] **Step 3: Implement `web/lib/answers.ts`** and the route in `server.ts`.
- [ ] **Step 4: Run** `bun test` — expect all pass
- [ ] **Step 5: Commit** "Save answers to common application questions"

### Task 2: Saved answers section in the sidebar

**Files:**
- Modify: `web/public/index.html` (new `<div id="answersSection" class="cv-section" hidden>` after `cvSection`), `web/public/app.js` (show it in `updateAuthUI` like `cvSection`; load/save), `web/public/style.css`
- Test: `web/tests/browser/saved-answers.js`

**Interfaces:**
- Consumes: Task 1's `GET/PUT /api/answers`.
- Produces: `loadSavedAnswers(): Promise<void>`, `savedAnswers: SavedAnswer[]` (module state, used by Task 4).

Behavior: the section lists each entry as a question input and an answer textarea, with "Add a question" and a remove (×) button per entry. With no saved entries it shows the starters with empty answers. Saving happens on blur of a changed field (one `PUT` with the whole list); a 400 shows its `error` text under the section. Entries with an empty answer are saved but marked "not answered yet".

- [ ] **Step 1: Write the failing browser test** `saved-answers.js`: after `signIn("user")`, the section is visible with 5 starter questions; filling "Salary expectations" with `<b>60k</b>` and blurring saves it (`GET /api/answers` returns it) and it shows as literal text; "Add a question" + typing + blur adds a 6th; × removes it; logged out the section is hidden.
- [ ] **Step 2: Run** `CHROMIUM=google-chrome bun tests/browser/run.ts saved-answers` — expect FAIL
- [ ] **Step 3: Implement** the section.
- [ ] **Step 4: Run** the test, then the full browser suite — expect pass
- [ ] **Step 5: Commit** "Edit saved answers in the sidebar"

### Task 3: Drafts use saved answers and add a checklist and deadline

**Files:**
- Modify: `application_draft.py`, `web/server.ts` (`draftStatus`: `stale` status)
- Test: `tests/test_application_draft.py`

**Interfaces:**
- Consumes: `data/answers/<id>.json` (Task 1's format).
- Produces: draft JSON `draft` gains `checklist: list[str]` and `deadline: str` (`""` when the posting states none); saved record gains `"answers": <sha256 of the canonical JSON of the saved answers>`; `DRAFT_VERSION = 2`. `GET /api/applications/:jobId/draft` returns `status: "stale"` when the saved record's `answers` hash differs from the current file's (computed in `server.ts` the same way: sha256 of `JSON.stringify(answers)` — Python must produce the identical string, so use `json.dumps(answers, ensure_ascii=False, separators=(",", ":"))`).

Prompt additions (append to `SYSTEM`):
- point 4: "A checklist: each thing the application asks the person to provide or do (e.g. CV, cover letter, work sample, references, a test task, a form), one short line each, in the order the posting gives them."
- point 5: "The deadline as the posting states it, verbatim (e.g. '15 January 2027, 23:59 CET'), or empty if it states none."
- After the CV, a text block "My saved answers to common questions (use them where they answer a question; don't use them otherwise):" followed by `Q: …\nA: …` pairs, only entries with a non-empty answer. Omitted entirely when there are none.

- [ ] **Step 1: Write the failing tests:**
  - `test_saved_answers_go_to_the_model`: write `answers/7.json` with one answered and one unanswered entry; the request's text includes the answered pair and not the unanswered question
  - `test_no_saved_answers_no_block`: no file → no "saved answers" text in the request
  - `test_changed_answers_make_a_new_draft`: draft, change `answers/7.json`, draft without `--force` → written again
  - `test_draft_keeps_checklist_and_deadline`: `FakeClient` returns `checklist`/`deadline`; saved draft has them; `version == 2`
- [ ] **Step 2: Run** `uv run python -m unittest tests.test_application_draft` — expect FAIL
- [ ] **Step 3: Implement** in `application_draft.py` (schema fields with `default_factory=list` / `default=""`; read answers next to the CV; hash into the up-to-date check) and the `stale` status in `server.ts`.
- [ ] **Step 4: Run** `uv run python -m unittest` and `cd web && bun test` — expect all pass
- [ ] **Step 5: Commit** "Draft from saved answers, with a checklist and the deadline"

### Task 4: The kit in the draft panel

**Files:**
- Modify: `web/public/app.js` (`draftContent`, `DRAFT_MESSAGES`), `web/server.ts` (applications PUT keeps `checked`), `web/public/style.css`
- Test: extend `web/tests/browser/drafts.js`

**Interfaces:**
- Consumes: Task 3's `draft.checklist`, `draft.deadline`, `status: "stale"`; Task 2's `savedAnswers`.
- Produces: application entries gain `checked: string[]` (checklist items ticked). `PUT /api/applications/:jobId` accepts `checked` as an array of ≤ 50 strings of ≤ 300 chars, else 400; keeps the existing value when absent.
- `copyButton(getText: () => string, label: string): HTMLButtonElement` in `app.js`.

Panel order: deadline line ("Deadline: …" when non-empty), checklist (checkboxes; ticking calls `updateApplication(jobId, "checked", [...])`), letter (existing "Use this letter" plus Copy), answers to the posting's questions (Copy on each), then "Your saved answers" (answered entries, Copy on each), then gaps. `stale` shows "Your saved answers changed since this draft. Draft again to use them." above the draft. On drafts without `checklist`/`deadline`, those parts are simply absent.

Copy: `navigator.clipboard.writeText`; on rejection or when `navigator.clipboard` is missing, select the text's element and set the button's label to "Press Ctrl+C to copy" for 3 s. Success sets "Copied" for 2 s.

- [ ] **Step 1: Extend the failing browser test** `drafts.js` with a version-2 draft fixture (`run.ts` writes the drafts fixture; add `checklist: ["CV", "Work sample"]`, `deadline: "15 January 2027"`): deadline shown; ticking "Work sample" survives a re-render and is in `GET /api/applications`; a version-1 fixture still renders (no checklist, no errors); with `navigator.clipboard` stubbed to reject, Copy shows "Press Ctrl+C to copy"; with it stubbed to resolve, the copied text equals the letter; after changing saved answers the panel shows the stale message. Ticks after a redraft: with "CV" and "Work sample" ticked, replace the fixture with `checklist: ["CV", "References"]` and re-render: "CV" is still ticked, "References" isn't, and `checked` no longer contains "Work sample" after the next tick.
- [ ] **Step 2: Run** `CHROMIUM=google-chrome bun tests/browser/run.ts drafts` — expect FAIL
- [ ] **Step 3: Implement** the panel, `copyButton`, and `checked` in the applications PUT.
- [ ] **Step 4: Run** the full browser suite and `bun test` — expect all pass
- [ ] **Step 5: Update `SPEC.md`** (answers file in §3's per-user list; drafts paragraph: saved answers, checklist, deadline, stale; §5 table: `/api/answers`, `checked` on applications) and commit "Show the application kit: checklist, deadline, copy buttons"

---

**Not in this plan (deliberately):** drafting automatically when a job is tracked (one Opus call per tracked job; decide after seeing how often the kit is used), filling employers' forms (bookmarklet/extension), and reading email for status. Each needs its own decision.
