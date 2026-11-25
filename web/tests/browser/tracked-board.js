// The Tracked view can show applications as a board: a column per status,
// compact cards, moved by dragging or with each card's status select.
layoutEl.value = "cards";
layoutEl.dispatchEvent(new Event("change"));
await signIn("user");
const [a, b, c] = jobs;
toggleTracked(a.id);
toggleTracked(b.id);
await wait(300);
updateApplication(b.id, "status", "applied");
viewEl.value = "tracked";
viewEl.dispatchEvent(new Event("change"));
await wait(100);

const switchBtn = (label) => [...document.querySelectorAll("#trackedLayout button")].find((x) => x.textContent === label);
check("switch shown in Tracked view", !!switchBtn("Board") && !document.getElementById("trackedLayout").hidden);
switchBtn("Board").click();
await wait(100);
const board = document.querySelector(".tracked-board");
// Looked up afresh: every move re-renders the board.
const column = (s) => document.querySelector(`.tracked-board .board-column[data-status="${s}"]`);
const inColumn = (s) => [...(column(s)?.querySelectorAll(".board-card") || [])].map((el) => el.dataset.id);
check("board shown", !!board && document.getElementById("jobs").contains(board));
check("a column per status", ["interested", "applied", "interviewing", "offered", "rejected", "withdrawn"].every((s) => column(s)));
check("cards in their status's column", inColumn("interested").includes(a.id) && inColumn("applied").includes(b.id), JSON.stringify([inColumn("interested"), inColumn("applied")]));
check("column counts", column("applied").querySelector(".board-count").textContent === "1");
check("untracked job not on the board", !board.querySelector(`[data-id="${c.id}"]`));
check("remembered", localStorage.getItem("jobBoard.trackedLayout") === "board");

// Moving with the select.
const sel = board.querySelector(`.board-card[data-id="${a.id}"] .card-status-select`);
sel.value = "interviewing";
sel.dispatchEvent(new Event("change"));
await wait(100);
check("select moves the card", inColumn("interviewing").includes(a.id) && applications.get(a.id).status === "interviewing",
  JSON.stringify([applications.get(a.id), inColumn("interviewing"), !!document.querySelector(".tracked-board")]));

// Moving by dragging.
const dt = new DataTransfer();
const card = document.querySelector(`.board-card[data-id="${b.id}"]`);
card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
column("offered").dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
column("offered").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
await wait(100);
check("drop moves the card", inColumn("offered").includes(b.id) && applications.get(b.id).status === "offered");

// Details link goes back to the list.
document.querySelector(`.board-card[data-id="${a.id}"] .board-details`).click();
await wait(100);
check("details opens the list", !document.querySelector(".tracked-board") && !!document.querySelector(`#jobs article.job[data-id="${a.id}"] .app-panel`));

viewEl.value = "all";
viewEl.dispatchEvent(new Event("change"));
await wait(50);
check("switch hidden outside Tracked", document.getElementById("trackedLayout").hidden);
