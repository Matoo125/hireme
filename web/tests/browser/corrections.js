// Hand corrections from the grid: admins only, saved through the server
// (which re-derives the salary numbers and typed columns), marked, undoable.
const cell = (name, id) => grid.getCellFromCoords(cx(name), rowOf(id));
const job = (id) => jobs.find((j) => j.id === id);
const menu = (name, id) => {
  cell(name, id).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2, buttons: 2 }));
  cell(name, id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 300 }));
  return [...document.querySelectorAll(".jcontextmenu > div")].filter((d) => d.offsetParent);
};
const closeMenu = () => document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
const saved = async (id, field, value) => {
  for (let i = 0; i < 100 && job(id)[field] !== value; i++) await wait(50);
  return job(id)[field] === value;
};
const scraped = jobs.filter((j) => j.close_date && j.salary_range);
const [A, B] = [scraped[0].id, scraped[1].id];
const originalClose = job(A).close_date;

// Logged out, and as a plain user: nothing to edit.
check("logged out: read-only", grid.options.columns[cx("title")].readOnly === true);
await signIn("user");
check("plain user: not admin", isAdmin === false && grid.options.columns[cx("closes")].readOnly === true);
const forbidden = await fetch(`/api/overrides/${A}`, {
  method: "PUT", headers: { Authorization: `Bearer ${TOKENS.user}` }, body: JSON.stringify({ title: "x" }),
});
check("plain user: API refuses", forbidden.status === 403, forbidden.status);

await signIn("admin");
check("admin: scraped cells editable", isAdmin && !grid.options.columns[cx("closes")].readOnly && !grid.options.columns[cx("salary")].readOnly);
check("admin: board stays read-only", grid.options.columns[cx("board")].readOnly === true);

// A date.
grid.setValueFromCoords(cx("closes"), rowOf(A), "2031-01-15");
check("date saved", await saved(A, "close_date", "2031-01-15"), job(A).close_date);
check("corrected cell marked", cell("closes", A).classList.contains("cell--corrected") && /Corrected by hand/.test(cell("closes", A).title));
check("other cells not marked", !cell("posted", A).classList.contains("cell--corrected"));

// Salary text: the numbers follow.
grid.setValueFromCoords(cx("salary"), rowOf(B), "€50,000 - €60,000 per year");
check("salary saved", await saved(B, "salary_currency", "EUR"), job(B).salary_currency);
check("numbers re-derived", job(B).salary_min === "50000" && cell("salary_min", B).textContent === "50,000", cell("salary_min", B).textContent);
check("only the edited cell marked", cell("salary", B).classList.contains("cell--corrected") && !cell("salary_min", B).classList.contains("cell--corrected"));

// A typed column, as a multiple dropdown.
grid.setValueFromCoords(cx("location"), rowOf(B), "Remote;London");
check("location saved", await saved(B, "location", "Remote; London"), job(B).location);
check("location shown", cell("location", B).textContent.includes("London"), cell("location", B).textContent);

// A bad value is refused and the cell goes back.
const before = grid.getValueFromCoords(cx("closes"), rowOf(B));
let alerted = "";
window.alert = (m) => { alerted = m; };
grid.setValueFromCoords(cx("closes"), rowOf(B), "next week");
for (let i = 0; i < 100 && !alerted; i++) await wait(50);
await wait(100);
check("bad date refused", alerted.includes("expected a date"), alerted);
check("bad date reverted", grid.getValueFromCoords(cx("closes"), rowOf(B)) === before);

// The server's copy agrees.
const served = (await (await fetch("/api/jobs")).json()).find((j) => j.id === B);
check("served jobs.csv has corrections", served.salary_currency === "EUR" && served.corrected === "salary_range; location", served.corrected);

// A plain user sees the marks but can't undo them.
await signIn("user");
check("plain user sees mark", cell("salary", B).classList.contains("cell--corrected"));
const userMenu = menu("salary", B).map((d) => d.textContent);
closeMenu();
check("plain user has no undo", !userMenu.some((t) => t.includes("Undo hand correction")), JSON.stringify(userMenu));

// Undo from the right-click menu.
await signIn("admin");
// (jSuites menu items act on mouseup.)
menu("closes", A).find((d) => d.textContent.includes("Undo hand correction"))
  ?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
check("undo restores scraped value", await saved(A, "close_date", originalClose), job(A).close_date);
check("undo removes mark", !cell("closes", A).classList.contains("cell--corrected"));
