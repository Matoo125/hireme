// Portfolio page editor: the generated page can be edited, bad links are
// refused, edits survive a new CV (which is then flagged), "Remake from CV"
// replaces them and reports a failed run, and deleting the CV ends editing.
const auth = { Authorization: `Bearer ${TOKENS.user}` };
const upload = (bytes) => fetch("/api/cv?filename=cv.pdf", {
  method: "POST", headers: { ...auth, "Content-Type": "application/pdf" }, body: bytes,
});
const info = document.getElementById("pageInfo");
const actions = document.getElementById("pageActions");
const editor = document.getElementById("pageEditor");
const editorInfo = document.getElementById("pageEditorInfo");
const field = (name) => editor.querySelector(`.page-editor-basics [data-field="${name}"]`);
const content = async () => (await fetch("/api/page/content", { headers: auth })).json();
const status = async () => (await fetch("/api/page", { headers: auth })).json();
async function until(what, ok) {
  for (let i = 0; i < 60; i++) {
    const s = await status();
    if (ok(s)) return s;
    await wait(500);
  }
  return status();
}

check("logged out: content API refuses", (await fetch("/api/page/content")).status === 401);

await signIn("user");
updateAuthUI();
await upload("%PDF-1.4 page cv");
await fetch("/api/page", {
  method: "PUT", headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ enabled: true, slug: "jane-editor" }),
});
const ready = await until("ready", (s) => s.status === "ready");
check("page on, content up to date", ready.status === "ready" && ready.hasContent && !ready.edited, JSON.stringify(ready));
await loadPageInfo();
check("edit and remake offered", actions.hidden === false);

document.getElementById("pageEditBtn").click();
await wait(400);
check("editor opens with the page's content", !editor.hidden && field("name").value === "Jane Example"
  && field("skills").value === "Research", field("name")?.value);
check("roles listed", editor.querySelectorAll('[data-list="experience"] > .page-editor-item').length === 1);

field("headline").value = "Senior policy researcher";
const linkList = editor.querySelector('[data-list="links"]');
linkList.nextElementSibling.click(); // "Add a link"
const newLink = linkList.lastElementChild;
newLink.querySelector('[data-field="label"]').value = "Bad";
newLink.querySelector('[data-field="url"]').value = "javascript:alert(1)";
editor.requestSubmit();
await wait(400);
check("a script link is refused, editor stays open", !editor.hidden
  && editorInfo.classList.contains("cv-status--error") && editorInfo.textContent.includes("Link 2"), editorInfo.textContent);

newLink.querySelector(".btn--link.btn--danger").click(); // "Remove"
editor.requestSubmit();
await wait(400);
const saved = await content();
check("saved: editor closes, status says edited", editor.hidden && info.textContent.includes("with your edits"), info.textContent);
check("saved content has the edit", saved.edited && saved.content.headline === "Senior policy researcher"
  && saved.content.links.length === 1, JSON.stringify(saved).slice(0, 200));

await upload("%PDF-1.4 newer page cv");
const outdated = await until("outdated", (s) => s.status === "outdated");
check("new CV: edits kept, page flagged", outdated.status === "outdated"
  && (await content()).content.headline === "Senior policy researcher", JSON.stringify(outdated));
await loadPageInfo();
check("new CV: user told to remake", info.textContent.includes("new CV"), info.textContent);

// The test server reaches no Claude, so the remake fails; the user is told.
window.confirm = () => true;
document.getElementById("pageRemakeBtn").click();
const failed = await until("failure", (s) => s.status !== "generating" && s.error);
await loadPageInfo();
check("failed remake: error shown", Boolean(failed.error) && info.classList.contains("cv-status--error"), JSON.stringify(failed));
check("failed remake: edits still there", (await content()).content.headline === "Senior policy researcher");

await fetch("/api/cv", { method: "DELETE", headers: auth });
await loadPageInfo();
await wait(300);
check("CV deleted: content gone, no editing", (await fetch("/api/page/content", { headers: auth })).status === 404
  && actions.hidden && editor.hidden);

await fetch("/api/page", {
  method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }),
});
