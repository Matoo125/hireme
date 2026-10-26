// New since your last visit: jobs first seen after the last day you visited
// before today get a "New" badge and their own view.
const today = todayUTC();
const option = viewEl.querySelector('option[value="new"]');

check("first visit: nothing is new", visits.last === today && visits.previous === null && option.hidden);
check("visit saved", JSON.parse(localStorage.getItem("jobBoard.visits")).last === today);

check("rolled on a later day", JSON.stringify(rollVisits({ last: "2026-10-20", previous: "2026-10-18" }, "2026-10-22"))
  === '{"last":"2026-10-22","previous":"2026-10-20"}');
check("same day keeps the earlier visit", JSON.stringify(rollVisits({ last: "2026-10-22", previous: "2026-10-20" }, "2026-10-22"))
  === '{"last":"2026-10-22","previous":"2026-10-20"}');
check("merge takes the latest earlier visit", mergeVisits(
  { last: today, previous: "2026-10-10" }, { last: "2026-10-12", previous: "2026-10-01" }).previous === "2026-10-12");

// Two jobs appeared after a visit three days ago; the rest are older.
const day = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
visits = { last: today, previous: day(3) };
for (const job of jobs) job.first_seen = day(30);
const [a, b] = jobs;
a.first_seen = day(1);
b.first_seen = today;
layoutEl.value = "cards";
layoutEl.dispatchEvent(new Event("change"));
await wait(100);
const badged = [...document.querySelectorAll("#jobs article.job")].filter((c) => c.querySelector(".new-badge"));
check("new jobs badged", badged.length === 2, badged.length);
check("view offered with its count", !option.hidden && option.textContent.endsWith("(2)"), option.textContent);
viewEl.value = "new";
viewEl.dispatchEvent(new Event("change"));
await wait(100);
check("view shows only them", countEl.textContent === "2 jobs", countEl.textContent);
toggleHidden(a.id);
check("hidden ones drop out", countEl.textContent === "1 job", countEl.textContent);
toggleHidden(a.id);

// Logged in, the visits go to the server with the preferences, and another
// device's later visit counts.
const put = (body) => fetch("/api/preferences", {
  method: "PUT",
  headers: { Authorization: `Bearer ${TOKENS.user}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
await put({ liked: [], hidden: [], visits: { last: day(1), previous: day(5) } });
await signIn("user");
await loadPreferences();
await wait(300);
check("merged with the server's", visits.last === today && visits.previous === day(1), JSON.stringify(visits));
const saved = await (await fetch("/api/preferences", { headers: { Authorization: `Bearer ${TOKENS.user}` } })).json();
check("merged visits saved back", saved.visits?.previous === day(1), JSON.stringify(saved.visits));
check("now only today's job is new", option.textContent.endsWith("(1)"), option.textContent);

const junk = await (await put({ liked: [], hidden: [], visits: { last: "soon", previous: 3 } })).json();
check("server drops malformed dates", !("visits" in junk), JSON.stringify(junk));
