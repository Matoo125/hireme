// Fit scores: only for an account fit_scores.py scored, as a badge with the
// reason on each card, a "Best fit for you" sort (the default for them) that
// folds poor matches away, and a Fit column in the grid.
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
check("best fit is the default sort", sortEl.value === "fit_desc", sortEl.value);

await wait(300);
const fitX = cx("fit");
check("grid has a Fit column", fitX > 0 && grid.getValueFromCoords(fitX, rowOf(ids[0])) === 91, fitX);

layoutEl.value = "cards";
layoutEl.dispatchEvent(new Event("change"));
await wait(100);
const cardsNow = () => [...document.querySelectorAll("#jobs article.job")];
let cards = cardsNow();
const firstTitle = cards[0]?.querySelector(".job-title a")?.textContent;
check("best fit first", firstTitle === jobs.find((j) => j.id === ids[0]).title, firstTitle);
const badges = cards.slice(0, 2).map((c) => c.querySelector(".fit-score")?.textContent);
check("badges in score order", JSON.stringify(badges) === '["91","55"]', badges);
check("bands", cards[0].querySelector(".fit-score").classList.contains("fit-high")
  && cards[1].querySelector(".fit-score").classList.contains("fit-mid"));
check("reason shown", cards[0].querySelector(".job-fit").textContent.includes("Reason 0"));
check("unscored jobs have no badge", !cards[2].querySelector(".job-fit"));

// The score-12 job folds into "Probably not for you", after everything else.
const toggle = () => document.querySelector(".low-fit-toggle");
check("poor match folded", cards.length === jobs.length - 1 && toggle()?.textContent.includes("(1)"),
  `${cards.length} cards, ${toggle()?.textContent}`);
check("count says so", countEl.textContent === `${jobs.length - 1} jobs + 1 probably not`, countEl.textContent);
toggle().click();
await wait(100);
cards = cardsNow();
check("unfolds below the toggle", cards.length === jobs.length
  && toggle().nextElementSibling === cards.at(-1)
  && cards.at(-1).querySelector(".fit-score").classList.contains("fit-low"));
toggle().click();
await wait(100);
toggleLiked(ids[2]);
check("a liked poor match isn't folded", !toggle() && cardsNow().length === jobs.length);
toggleLiked(ids[2]);
sortEl.value = "posted_desc";
sortEl.dispatchEvent(new Event("change"));
await wait(100);
check("other sorts don't fold", !toggle() && cardsNow().length === jobs.length);

// Without the session token logout() skips its sign-out call to altfresh.
localStorage.removeItem("hireme.token");
logout();
check("logout: scores cleared, sort reset", fitScores.size === 0 && option.hidden && sortEl.value === "posted_desc");
