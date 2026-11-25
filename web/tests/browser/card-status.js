// A tracked job's card shows its status as a small select in every view, not
// only Tracked, so it can be updated where the job is found.
layoutEl.value = "cards";
layoutEl.dispatchEvent(new Event("change"));
await signIn("user");
const [a, b] = jobs;
const card = (id) => document.querySelector(`#jobs article.job[data-id="${id}"]`);
const select = (id) => card(id)?.querySelector(".card-status-select");

render();
await wait(50);
check("untracked card has no status", !select(a.id));
toggleTracked(a.id);
await wait(300);
check("tracked card shows status in All jobs", select(a.id)?.value === "interested", select(a.id)?.value);
check("labelled for screen readers", !!select(a.id).getAttribute("aria-label"));

select(a.id).value = "applied";
select(a.id).dispatchEvent(new Event("change"));
await wait(300);
check("status saved", applications.get(a.id).status === "applied");
const server = await (await fetch(`/api/applications`, { headers: { Authorization: `Bearer ${TOKENS.user}` } })).json();
const saved = Array.isArray(server) ? server.find((x) => x.jobId === a.id) : server[a.id];
check("status saved to the account", saved?.status === "applied", JSON.stringify(saved));
check("card keeps the new status", select(a.id)?.value === "applied");

viewEl.value = "tracked";
viewEl.dispatchEvent(new Event("change"));
await wait(50);
check("Tracked view keeps its own panel (no duplicate)", !select(a.id) && !!card(a.id).querySelector(".app-status-select"));
check("untracked job still absent", !card(b.id));
viewEl.value = "all";
viewEl.dispatchEvent(new Event("change"));
toggleTracked(a.id);
await wait(300);
