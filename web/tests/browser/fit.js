// Fit scores: only for an account fit_scores.py scored, as a badge with the
// reason on each card and a "Best fit for you" sort.
const option = document.querySelector('#sort option[value="fit_desc"]');
const ids = Object.keys(FIT_SCORES);

check("logged out: no fit sort", option.hidden === true);
const anon = await fetch("/api/fit");
check("logged out: API refuses", anon.status === 401, anon.status);

await signIn("admin");
await loadFit();
check("account without scores: no fit sort", option.hidden === true && fitScores.size === 0);

await signIn("user");
await loadFit();
check("scored account: fit sort offered", option.hidden === false);
check("scores loaded", fitScores.size === ids.length && fitScores.get(ids[0]).score === 91);

layoutEl.value = "cards";
layoutEl.dispatchEvent(new Event("change"));
sortEl.value = "fit_desc";
sortEl.dispatchEvent(new Event("change"));
await wait(100);
const cards = [...document.querySelectorAll("#jobs article.job")];
const firstTitle = cards[0]?.querySelector(".job-title")?.textContent;
check("best fit first", firstTitle === jobs.find((j) => j.id === ids[0]).title, firstTitle);
const badges = cards.slice(0, 3).map((c) => c.querySelector(".fit-score")?.textContent);
check("badges in score order", JSON.stringify(badges) === '["91","55","12"]', badges);
check("bands", cards[0].querySelector(".fit-score").classList.contains("fit-high")
  && cards[2].querySelector(".fit-score").classList.contains("fit-low"));
check("reason shown", cards[0].querySelector(".job-fit").textContent.includes("Reason 0"));
check("unscored jobs have no badge", !cards[3].querySelector(".job-fit"));

// Without the session token logout() skips its sign-out call to altfresh.
localStorage.removeItem("hireme.token");
logout();
check("logout: scores cleared, sort reset", fitScores.size === 0 && option.hidden && sortEl.value === "posted_desc");
