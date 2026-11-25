// In the cards layout, j/k move between jobs, l likes, h hides (selecting
// the next job), u undoes the hide, and o opens the posting. Keys typed into
// a field, or with a modifier, are left alone.
layoutEl.value = "cards";
layoutEl.dispatchEvent(new Event("change"));
render();
await wait(100);
const press = (key, opts = {}, target = document.body) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
const cards = () => [...document.querySelectorAll("#jobs article.job")];
const selected = () => document.querySelector("#jobs article.job.is-selected");

press("j");
check("j selects the first job", selected() === cards()[0] && document.activeElement === cards()[0]);
press("j");
check("j moves down", selected() === cards()[1]);
press("k");
check("k moves up", selected() === cards()[0]);
press("k");
check("k stops at the top", selected() === cards()[0]);

const first = selected().dataset.id;
press("l");
await wait(50);
check("l likes", likedJobs.has(first));
check("selection survives re-render", selected()?.dataset.id === first);
press("l");
await wait(50);
check("l again unlikes", !likedJobs.has(first));

const second = cards()[1].dataset.id;
press("h");
await wait(50);
check("h hides", hiddenJobs.has(first));
check("next job selected after hide", selected()?.dataset.id === second);
press("u");
await wait(50);
check("u undoes the hide", !hiddenJobs.has(first));

let opened = null;
const realOpen = window.open;
window.open = (url) => { opened = url; };
press("o");
window.open = realOpen;
check("o opens the posting", opened === jobs.find((j) => j.id === selected().dataset.id).link, opened);

const before = selected();
press("j", { ctrlKey: true });
check("modifier keys ignored", selected() === before);
press("j", {}, searchEl);
check("typing in search ignored", selected() === before);

// Search is focused on load (autofocus): Esc leaves it so the keys work.
searchEl.focus();
press("Escape", {}, searchEl);
check("Esc leaves the search box", document.activeElement !== searchEl);
press("j");
check("keys work after Esc", selected() !== before || cards().length === 1);

layoutEl.value = "table";
layoutEl.dispatchEvent(new Event("change"));
await wait(100);
const likedBefore = likedJobs.size;
press("l");
check("table layout ignored", likedJobs.size === likedBefore);
