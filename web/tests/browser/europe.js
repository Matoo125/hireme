// Jobs someone in Europe can't take (europe "no") are left out unless asked
// for; the table shows the verdict with its reason, and admins can correct it.
const [a, b, c] = jobs;
for (const job of jobs) Object.assign(job, { europe: "yes", europe_reason: "Remote worldwide" });
Object.assign(b, { europe: "no", europe_reason: "US work authorization required" });
Object.assign(c, { europe: "unclear", europe_reason: "" });
const toggle = document.getElementById("europeToggle");
const ids = () => shownRows.map((j) => j.id);

render();
await wait(300);
check("'no' jobs left out", !ids().includes(b.id) && ids().includes(c.id) && countEl.textContent === `${jobs.length - 1} jobs`,
  countEl.textContent);
check("toggle offers them", !toggle.hidden && toggle.textContent === "Show 1 not open to Europe", toggle.textContent);
const ex = cx("europe");
check("grid shows the verdict", ex > 0 && grid.getValueFromCoords(ex, rowOf(c.id)) === "unclear");

toggle.click();
await wait(300);
check("shown on request", ids().includes(b.id) && toggle.textContent === "Hide 1 not open to Europe", toggle.textContent);
check("remembered", localStorage.getItem("jobBoard.includeNotEurope") === "1");
const cell = grid.getCellFromCoords(ex, rowOf(b.id));
check("reason on hover", cell.title.includes("US work authorization required"), cell.title);

layoutEl.value = "cards";
layoutEl.dispatchEvent(new Event("change"));
await wait(100);
const card = [...document.querySelectorAll("#jobs article.job")].find((el) => el.textContent.includes(b.title));
check("card says why", card?.querySelector(".job-europe")?.textContent === "Not open to Europe: US work authorization required");

toggle.click();
await wait(100);
toggleLiked(b.id);
viewEl.value = "liked";
viewEl.dispatchEvent(new Event("change"));
await wait(100);
check("liked view shows it anyway", countEl.textContent === "1 job" && toggle.hidden, countEl.textContent);
toggleLiked(b.id);
viewEl.value = "all";
viewEl.dispatchEvent(new Event("change"));

// Admins correct a verdict like any other column.
layoutEl.value = "table";
layoutEl.dispatchEvent(new Event("change"));
await signIn("admin");
await wait(300);
const row = await saveCorrection(a.id, { europe: "no" });
check("correction saved", row.europe === "no" && row.corrected.includes("europe"), JSON.stringify(row.corrected));
let refused = "";
try {
  await saveCorrection(a.id, { europe: "maybe" });
} catch (err) {
  refused = err.message;
}
check("only yes, no or unclear", refused.includes("expected one of yes, no, unclear"), refused);
