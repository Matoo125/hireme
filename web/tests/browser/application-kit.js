// The kit in a tracked job's draft panel: the deadline, a checklist whose
// ticks are saved on the application, Copy buttons (with a fallback when the
// clipboard can't be used), the saved answers, and a note when the saved
// answers changed since the draft.
const auth = { Authorization: `Bearer ${TOKENS.user}` };
const id = jobs[1].id;
await signIn("user");
updateAuthUI();
await fetch("/api/cv?filename=cv.pdf", {
  method: "POST", headers: { ...auth, "Content-Type": "application/pdf" }, body: "%PDF-1.4 draft cv",
});
const now = new Date().toISOString();
await saveApplication(id, { status: "interested", notes: "", motivationLetter: "", createdAt: now, updatedAt: now });
layoutEl.value = "cards";
viewEl.value = "tracked";
const panel = () => document.querySelector(`#jobs article.job[data-id="${id}"] .draft-panel`);
const show = async () => {
  render();
  for (let i = 0; i < 20 && !panel()?.querySelector(".draft-letter"); i++) await wait(200);
};
await show();

check("deadline shown", /Deadline: 15 January 2027/.test(panel().textContent), panel()?.textContent.slice(0, 200));
const box = (item) => [...panel().querySelectorAll(".kit-check")].find((l) => l.textContent.includes(item))?.querySelector("input");
check("checklist shown", !!box("CV") && !!box("Work sample"));

box("Work sample").click();
await wait(300);
const apps = await (await fetch("/api/applications", { headers: auth })).json();
check("tick saved to the account", JSON.stringify(apps[id]?.checked) === '["Work sample"]', JSON.stringify(apps[id]));
await show();
check("tick survives a re-render", box("Work sample").checked && !box("CV").checked);

// Copy: the clipboard gets the letter; without one, the button says how.
const copyOf = (text) => [...panel().querySelectorAll(".copy-btn")].find((b) => b.closest(".kit-item, .draft-section-head, .draft-answer")?.textContent.includes(text));
let copied = null;
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { copied = t; } } });
panel().querySelector(".draft-section-head .copy-btn").click();
await wait(50);
check("letter copied", copied === "Dear Second org,\n\nKit letter.", JSON.stringify(copied));
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
const answerCopy = panel().querySelector(".draft-answer .copy-btn");
answerCopy.click();
await wait(50);
check("no clipboard: says how", answerCopy.textContent === "Press Ctrl+C to copy", answerCopy.textContent);

// Saved answers appear in the kit, as text; changing them marks the draft.
await fetch("/api/answers", {
  method: "PUT", headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ answers: [{ question: "Salary expectations", answer: "<b>60k</b>" }, { question: "Notice period", answer: "" }] }),
});
await loadSavedAnswers();
await show();
const saved = panel().querySelector(".kit-saved");
check("saved answers in the kit", !!saved && saved.textContent.includes("<b>60k</b>") && !saved.querySelector("b"), saved?.innerHTML.slice(0, 200));
check("unanswered ones left out", !saved.textContent.includes("Notice period"));
check("stale note", /saved answers changed/i.test(panel().textContent), panel().querySelector(".cv-status")?.textContent);

// Ticks after "Draft again": matched by text.
const data = await (await fetch(`/api/applications/${id}/draft`, { headers: auth })).json();
const body = panel().querySelector(".draft-body");
body.replaceChildren(...draftContent(id, { ...data, draft: { ...data.draft, checklist: ["CV", "References"] } }));
check("unknown item unticked", !box("References").checked);
box("CV").click();
await wait(300);
check("ticks for gone items dropped", JSON.stringify(applications.get(id).checked) === '["CV"]', JSON.stringify(applications.get(id).checked));

await fetch(`/api/applications/${id}`, { method: "DELETE", headers: auth });
applications.delete(id);
await fetch("/api/cv", { method: "DELETE", headers: auth });
await fetch("/api/answers", { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: '{"answers":[]}' });
