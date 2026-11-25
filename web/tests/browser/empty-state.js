// When nothing is shown, the empty state says why and offers a way out: an
// empty view explains how jobs get there; filters each get a button that
// removes just that filter, with how many jobs it would bring back.
layoutEl.value = "cards";
layoutEl.dispatchEvent(new Event("change"));
const empty = document.getElementById("empty");
const buttons = () => [...empty.querySelectorAll("button")];
const [a] = jobs;
const tag = splitTags(a)[0];

// An empty view.
viewEl.value = "liked";
viewEl.dispatchEvent(new Event("change"));
await wait(50);
check("empty view shown", !empty.hidden && /haven.t liked/i.test(empty.textContent), empty.textContent);
const showAll = buttons().find((b) => /show all jobs/i.test(b.textContent));
check("offers all jobs", !!showAll);
showAll.click();
await wait(50);
check("back to all jobs", viewEl.value === "all" && empty.hidden);

// Filters that match nothing together.
toggleTag(tag);
searchEl.value = "zzzz-no-such-job";
render();
await wait(50);
check("filter empty state shown", !empty.hidden && /no jobs match/i.test(empty.textContent), empty.textContent);
const searchBtn = buttons().find((b) => b.textContent.includes("zzzz-no-such-job"));
check("search removable", !!searchBtn);
const tagBtn = buttons().find((b) => b.textContent.includes(tag));
check("tag removable with a count", !!tagBtn && /\(0 jobs?\)|\(\d+ jobs?\)/.test(searchBtn.textContent), searchBtn?.textContent);
const withTag = jobs.filter((j) => splitTags(j).includes(tag) && !hiddenJobs.has(j.id) && matchesEurope(j)).length;
check("count is what removing search would show", searchBtn.textContent.includes(`(${withTag} job`), `${searchBtn.textContent} vs ${withTag}`);
searchBtn.click();
await wait(50);
check("removing search applies", searchEl.value === "" && activeTags.has(tag) && empty.hidden);

searchEl.value = "zzzz-no-such-job";
render();
await wait(50);
buttons().find((b) => /clear all/i.test(b.textContent)).click();
await wait(50);
check("clear all", searchEl.value === "" && activeTags.size === 0 && empty.hidden);
check("URL cleared too", !new URL(location.href).searchParams.has("q"));
