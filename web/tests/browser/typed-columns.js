// Typed tag columns and salary numbers: formatting, numeric sort, filters, CSV.
const cell = (name, y = 0) => grid.getCellFromCoords(cx(name), y);
check("no plain Tags column", cx("tags") === -1);

grid.orderBy(cx("salary_max"), 1);
await wait(150);
const values = grid.getData().map((r) => r[cx("salary_max")]);
const maxes = values.filter((v) => v !== "" && v != null).map(Number);
check("Max sorts numerically", maxes.length > 5 && maxes.every((v, i) => !i || maxes[i - 1] >= v), maxes.slice(0, 5).join(","));
check("pay shown with separators", /^\d{1,3}(,\d{3})+$/.test(cell("salary_max").textContent), cell("salary_max").textContent);
check("blank Max sorts last", values.slice(values.findIndex((v) => v === "" || v == null)).every((v) => v === "" || v == null));
check("links survive sorting", Boolean(cell("title").querySelector("a[href]")));

// Experience (typed, several values per job) AND Period.
let dd = await openFilter("experience");
const expOpts = filterOptions();
check("experience options", expOpts.some((o) => o.startsWith("Mid (5–9y)")) && expOpts.length <= 8, JSON.stringify(expOpts));
dd.setValue(["Mid (5–9y)"]);
dd.close();
await wait(250);
dd = await openFilter("salary_period");
check("period options labelled", filterOptions().some((o) => o.startsWith("per year")), JSON.stringify(filterOptions()));
dd.setValue(["per year"]);
dd.close();
await wait(250);
const rows = grid.getData();
// Period cells hold the period ("year"); the dropdown shows its label.
check("experience AND period", rows.length > 0 && rows.every((r) =>
  String(r[cx("experience")]).split(", ").includes("Mid (5–9y)") && r[cx("salary_period")] === "year"),
  `${rows.length} rows; ${document.getElementById("count").textContent}`);

const csv = await exportCsv();
const header = csv.split("\r\n")[0];
check("CSV header", ["Experience", "Min", "Period", "Other tags"].every((h) => header.includes(h)), header);
check("CSV rows = grid", csv.trim().split("\r\n").length - 1 === rows.length);
