// Hiding a job shows a short "Hidden" notice with an Undo button that puts it
// back; restoring a job doesn't show one.
const [a, b] = jobs;
const toast = () => document.getElementById("undoToast");
const ids = () => shownRows.map((j) => j.id);

render();
await wait(100);
toggleHidden(a.id);
await wait(100);
check("job hidden", !ids().includes(a.id));
check("notice shown", toast() && !toast().hidden && toast().textContent.includes("Hidden"), toast()?.textContent);
check("notice names the job", toast().textContent.includes(a.title), toast().textContent);
check("announced to screen readers", toast().getAttribute("role") === "status");

toast().querySelector("button").click();
await wait(100);
check("undo restores it", ids().includes(a.id) && !hiddenJobs.has(a.id));
check("notice gone after undo", toast().hidden);

// A second hide replaces the notice rather than stacking.
toggleHidden(a.id);
toggleHidden(b.id);
await wait(100);
check("latest hide shown", toast().textContent.includes(b.title) && document.querySelectorAll("#undoToast").length === 1);
toast().querySelector("button").click();
await wait(100);
check("undo targets the latest", hiddenJobs.has(a.id) && !hiddenJobs.has(b.id));

// Restoring doesn't offer an undo.
toggleHidden(a.id);
await wait(100);
check("no notice on restore", toast().hidden);
