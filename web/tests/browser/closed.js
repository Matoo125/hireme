// Jobs whose posting is gone (closed) are left out of All jobs and New unless
// asked for, and always shown, labelled, where you kept them (liked, tracked).
layoutEl.value = "cards";
layoutEl.dispatchEvent(new Event("change"));
const [a, b, c] = jobs;
for (const job of jobs) Object.assign(job, { closed: "", europe: "yes" });
Object.assign(b, { closed: "2026-11-20" });
const toggle = document.getElementById("closedToggle");
const ids = () => [...document.querySelectorAll("#jobs article.job")].map((el) => el.dataset.id);

render();
await wait(100);
check("closed job left out", !ids().includes(b.id) && ids().includes(a.id));
check("toggle offers it", !toggle.hidden && toggle.textContent === "Show 1 closed", toggle.textContent);

toggle.click();
await wait(100);
check("shown on request", ids().includes(b.id) && toggle.textContent === "Hide 1 closed", toggle.textContent);
check("remembered", localStorage.getItem("jobBoard.includeClosed") === "1");
const card = document.querySelector(`#jobs article.job[data-id="${b.id}"]`);
check("card says it's closed", /posting closed/i.test(card.querySelector(".job-closed")?.textContent || ""),
  card.querySelector(".job-closed")?.textContent);
check("open job has no label", !document.querySelector(`#jobs article.job[data-id="${a.id}"] .job-closed`));
toggle.click();
await wait(100);

toggleLiked(b.id);
viewEl.value = "liked";
viewEl.dispatchEvent(new Event("change"));
await wait(100);
check("liked view shows it anyway", ids().includes(b.id) && toggle.hidden);
check("labelled there too", !!document.querySelector(`#jobs article.job[data-id="${b.id}"] .job-closed`));
toggleLiked(b.id);
viewEl.value = "all";
viewEl.dispatchEvent(new Event("change"));

// The empty state offers closed jobs too.
searchEl.value = b.title;
render();
await wait(100);
const offer = [...document.querySelectorAll("#empty button")].find((x) => /closed/i.test(x.textContent));
check("empty state offers closed jobs", !!offer, document.getElementById("empty").textContent);
searchEl.value = "";
render();
