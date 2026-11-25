// Logged out, the first like or hide shows a one-time notice that triage is
// only saved in this browser, with a login button; it can be dismissed for
// good. Logging in merges the browser's likes and hides with the account's
// instead of replacing them, and returns to the same search.
const [a, b, c] = jobs;
const nudge = () => document.getElementById("loginNudge");
const auth = async () => ({ Authorization: `Bearer ${TOKENS.user}` });

render();
check("no nudge before triage", nudge().hidden);
toggleLiked(a.id);
await wait(50);
check("nudge after first like", !nudge().hidden && /this browser/i.test(nudge().textContent), nudge().textContent);
check("nudge has a login button", [...nudge().querySelectorAll("button")].some((x) => /log in/i.test(x.textContent)));
[...nudge().querySelectorAll("button")].find((x) => /dismiss/i.test(x.getAttribute("aria-label") || x.textContent)).click();
await wait(50);
check("dismissed", nudge().hidden);
toggleHidden(b.id);
await wait(50);
check("stays dismissed", nudge().hidden);

// The account already has its own likes on the server.
await fetch("/api/preferences", {
  method: "PUT",
  headers: { ...(await auth()), "Content-Type": "application/json" },
  body: JSON.stringify({ liked: [c.id], hidden: [] }),
});
// Logging in: login() remembers the search, the callback brings it back.
searchEl.value = "policy";
render();
let redirectedTo = null;
loginRedirect = (url) => { redirectedTo = url; };
login();
check("login redirects", !!redirectedTo);
history.replaceState(null, "", `/#token=test&user=Tester`);
handleAuthCallback();
check("search restored after login", new URL(location.href).searchParams.get("q") === "policy" && !location.hash, location.href);
cachedJwt = TOKENS.user;
jwtExpiresAt = Date.now() + 3600e3;
await loadPreferences();
check("server likes kept", likedJobs.has(c.id));
check("browser likes kept", likedJobs.has(a.id) && hiddenJobs.has(b.id));
// loadPreferences saves without waiting; give the write time to land.
await wait(500);
const saved = await (await fetch("/api/preferences", { headers: await auth() })).json();
check("merged set saved to the account", saved.liked.includes(a.id) && saved.liked.includes(c.id) && saved.hidden.includes(b.id),
  JSON.stringify(saved));

// Later page loads take the account's sets as they are (no merge).
toggleLiked(a.id);
await wait(300);
likedJobs.add(a.id);
await loadPreferences();
check("no merge on a normal load", !likedJobs.has(a.id));
check("no nudge when logged in", nudge().hidden);
searchEl.value = "";
render();
