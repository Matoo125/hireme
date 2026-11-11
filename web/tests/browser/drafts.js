// Application drafts: shown on a tracked job's card, "Use this letter" copies
// the draft into the motivation letter, unknown jobs and a missing CV say why,
// and deleting the CV deletes the drafts.
const auth = { Authorization: `Bearer ${TOKENS.user}` };
const id = jobs[0].id;
const draftUrl = (jobId) => `/api/applications/${encodeURIComponent(jobId)}/draft`;

check("logged out: API refuses", (await fetch(draftUrl(id))).status === 401);

await signIn("user");
const noCv = await (await fetch(draftUrl(id), { headers: auth })).json();
check("no CV: status no-cv", noCv.status === "no-cv" && noCv.draft === null, JSON.stringify(noCv));
check("no CV: drafting refused", (await fetch(draftUrl(id), { method: "POST", headers: auth })).status === 400);
check("bad job id: 404", (await fetch(draftUrl("../x"), { headers: auth })).status === 404);

await fetch("/api/cv?filename=cv.pdf", {
  method: "POST", headers: { ...auth, "Content-Type": "application/pdf" }, body: "%PDF-1.4 draft cv",
});
const now = new Date().toISOString();
await saveApplication(id, { status: "interested", notes: "", motivationLetter: "", createdAt: now, updatedAt: now });
layoutEl.value = "cards";
viewEl.value = "tracked";
render();
for (let i = 0; i < 20 && !document.querySelector(".draft-letter"); i++) await wait(200);

const panel = document.querySelector(".draft-panel");
check("tracked card shows the draft panel", Boolean(panel));
check("saved draft rendered", panel?.textContent.includes("Dear First org")
  && panel.textContent.includes("Why us?") && panel.textContent.includes("Asks for SQL")
  && panel.textContent.includes("the full posting"), panel?.textContent.slice(0, 300));
check("button offers to draft again", panel?.querySelector(".draft-head button").textContent === "Draft again");

[...panel.querySelectorAll("button")].find((b) => b.textContent === "Use this letter").click();
await wait(300);
check("Use this letter copies it in", applications.get(id)?.motivationLetter === "Dear First org,\n\nI'd like to join as [role].",
  JSON.stringify(applications.get(id)));

// A job that isn't listed: the script stops before calling Claude and says why.
await fetch(draftUrl("missing-job"), { method: "POST", headers: auth });
let missing;
for (let i = 0; i < 40; i++) {
  missing = await (await fetch(draftUrl("missing-job"), { headers: auth })).json();
  if (missing.error) break;
  await wait(500);
}
check("unknown job: says so", missing.error?.includes("no longer listed"), JSON.stringify(missing));

await fetch("/api/cv", { method: "DELETE", headers: auth });
const gone = await (await fetch(draftUrl(id), { headers: auth })).json();
check("CV deleted: draft gone", gone.status === "no-cv" && gone.draft === null, JSON.stringify(gone));
await fetch("/api/cv?filename=cv.pdf", {
  method: "POST", headers: { ...auth, "Content-Type": "application/pdf" }, body: "%PDF-1.4 draft cv",
});
const after = await (await fetch(draftUrl(id), { headers: auth })).json();
check("same CV again: old draft not back", after.status === "none" && after.draft === null, JSON.stringify(after));
await fetch("/api/cv", { method: "DELETE", headers: auth });
