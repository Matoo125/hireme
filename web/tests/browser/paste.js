// Pasting over read-only cells changes only the editable ones.
const before = grid.getValueFromCoords(cx("title"), 0);
grid.updateSelectionFromCoords(cx("liked"), 0, cx("title"), 2);
grid.paste(cx("liked"), 0, "true\ttrue\tHACKED\ntrue\ttrue\tHACKED\ntrue\tfalse\tHACKED");
await wait(450);
check("read-only title unchanged", grid.getValueFromCoords(cx("title"), 0) === before);
const liked = JSON.parse(localStorage.getItem("jobBoard.liked") || "[]").length;
const hidden = JSON.parse(localStorage.getItem("jobBoard.hidden") || "[]").length;
check("pasted checkboxes saved", liked === 3 && hidden === 2, `liked=${liked} hidden=${hidden}`);
