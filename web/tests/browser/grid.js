// The grid: columns, liking, read-only cells, the user's own columns when
// logged in, CSV order, and switching back to cards.
const heads = () => [...document.querySelectorAll(".jss_worksheet thead tr:first-child td")]
  .filter((t) => t.style.display !== "none").map((t) => t.textContent.trim()).filter(Boolean);
const cell = (name, y = 0) => grid.getCellFromCoords(cx(name), y);
const total = grid.getData().length;

check("logged-out columns", JSON.stringify(heads()) === JSON.stringify([
  "★", "✕", "Title", "Organization", "Board", "Posted", "Closes", "Type", "Experience", "Location",
  "Cause area", "Skills", "Education", "Salary", "Min", "Max", "Currency", "Period", "Other tags", "Description",
]), JSON.stringify(heads()));
check("row count = count line", `${total} jobs` === document.getElementById("count").textContent, total);

// Like via the grid.
const firstId = grid.getValueFromCoords(0, 0);
grid.setValueFromCoords(cx("liked"), 0, true);
await wait(50);
check("checkbox likes job", JSON.parse(localStorage.getItem("jobBoard.liked") || "[]").includes(firstId));
check("view counts updated", /Liked \(1\)/.test(document.querySelector(`#view option[value="liked"]`).textContent));

// Read-only cells don't open an editor.
cell("title").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
cell("title").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
await wait(50);
check("read-only title opens no editor", !document.querySelector(".jss_worksheet .editor"), cell("title").className);
check("title is a link", Boolean(cell("title").querySelector('a[href^="http"]')));

// Sort in the grid, then the CSV follows that order.
grid.orderBy(cx("title"), 0);
await wait(50);
const firstCsvTitle = (await exportCsv()).split("\r\n")[1].split(",")[2].replace(/"/g, "");
check("CSV follows grid sort", firstCsvTitle === String(grid.getValueFromCoords(cx("title"), 0)),
  `${firstCsvTitle} / ${grid.getValueFromCoords(cx("title"), 0)}`);

// Logged in: Status and Notes. (Saving them to the server is fire-and-forget;
// local state is what's checked.)
await signIn("user");
check("logged-in adds Status and Notes", heads().includes("Status") && heads().includes("Notes"), JSON.stringify(heads()));
const id0 = grid.getValueFromCoords(0, 0);
grid.setValueFromCoords(cx("notes"), 0, "=1+1 call them");
await wait(50);
const app = JSON.parse(localStorage.getItem("jobBoard.applications") || "{}")[id0];
check("notes on untracked job start tracking", app?.status === "interested" && app?.notes === "=1+1 call them", JSON.stringify(app));
check("status cell set to interested", grid.getValueFromCoords(cx("status"), 0) === "interested");
check("formula not evaluated", grid.getValueFromCoords(cx("notes"), 0) === "=1+1 call them" && !/^2/.test(cell("notes").textContent));
check("Tracked count", /Tracked \(1\)/.test(document.querySelector(`#view option[value="tracked"]`).textContent));

// Clearing the status of an application with notes is refused.
window.alert = () => {};
grid.setValueFromCoords(cx("status"), 0, "");
await wait(50);
check("clearing status with notes refused", grid.getValueFromCoords(cx("status"), 0) === "interested" &&
  Boolean(JSON.parse(localStorage.getItem("jobBoard.applications"))[id0]));

// Status on a fresh job, then cleared: untracked.
const id1 = grid.getValueFromCoords(0, 1);
grid.setValueFromCoords(cx("status"), 1, "applied");
await wait(50);
check("status tracks job", JSON.parse(localStorage.getItem("jobBoard.applications"))[id1]?.status === "applied");
grid.setValueFromCoords(cx("status"), 1, "");
await wait(50);
check("clearing status untracks empty application", !JSON.parse(localStorage.getItem("jobBoard.applications"))[id1]);

// Search rebuilds the grid with fewer rows; cards destroy it.
const search = document.getElementById("search");
search.value = "research";
search.dispatchEvent(new Event("input"));
await wait(100);
check("search filters grid", grid.getData().length < total && grid.getData().length > 0, grid.getData().length);
const layout = document.getElementById("layout");
layout.value = "cards";
layout.dispatchEvent(new Event("change"));
await wait(100);
check("cards destroy grid", grid === null && !document.querySelector(".jss_worksheet") && document.querySelectorAll("#jobs .job").length > 0);
