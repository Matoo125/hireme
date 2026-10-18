// Our own column filters: single values with counts, OR within a column,
// AND across columns, CSV = what's shown, clearing.
const count = () => Number(document.getElementById("count").textContent.split(" ")[0]);
const total = count();
const boardsOf = (r) => r[cx("board")].split(", ");

let dd = await openFilter("board");
const boardOpts = filterOptions();
check("board options are single boards", boardOpts.length >= 4 && boardOpts.every((o) => !o.includes(", ")), JSON.stringify(boardOpts));
check("library's own filter did not open", !document.querySelector(".jss_worksheet td.jss_column_filter > div:not(.jdropdown)"));
dd.setValue(["80,000 Hours", "Animal Advocacy Careers"]);
dd.close();
await wait(250);
const afterBoard = grid.getData();
check("board OR filter", afterBoard.length > 0 && afterBoard.length < total && afterBoard.length === count() &&
  afterBoard.every((r) => boardsOf(r).some((b) => b === "80,000 Hours" || b === "Animal Advocacy Careers")),
  `${afterBoard.length} rows, count ${count()}`);
const boardCell = [...grid.filter.querySelectorAll("td.jss_column_filter")].find((t) => t.dataset.x === String(cx("board")));
check("board cell labelled", boardCell.textContent === "80,000 Hours, Animal Advocacy Careers", boardCell.textContent);
check("clear button shows", !document.getElementById("clearGridFilters").hidden && /\(1\)/.test(document.getElementById("clearGridFilters").textContent));

// Skills: options counted among the board-filtered rows; AND with board.
dd = await openFilter("skills");
const pick = filterOptions().find((o) => Number(o.match(/\((\d+)\)$/)[1]) < afterBoard.length / 2);
const skill = pick.replace(/ \(\d+\)$/, "");
const skillCount = Number(pick.match(/\((\d+)\)$/)[1]);
dd.setValue([skill]);
dd.close();
await wait(250);
const afterSkill = grid.getData();
check("skills AND board", afterSkill.length === skillCount && afterSkill.every((r) => r[cx("skills")].split(", ").includes(skill)),
  `${skill}: ${afterSkill.length} rows, option said ${skillCount}`);
check("CSV = filtered rows", (await exportCsv()).trim().split("\r\n").length - 1 === afterSkill.length);

// Checkbox columns filter on Yes/No.
dd = await openFilter("liked");
check("liked options Yes/No", filterOptions().length > 0 && filterOptions().every((o) => /^(Yes|No) \(\d+\)$/.test(o)), JSON.stringify(filterOptions()));
dd.close();
await wait(200);
check("closing without change keeps filters", grid.getData().length === afterSkill.length);

document.getElementById("clearGridFilters").click();
await wait(250);
check("clear restores all rows", grid.getData().length === total && document.getElementById("clearGridFilters").hidden, grid.getData().length);
