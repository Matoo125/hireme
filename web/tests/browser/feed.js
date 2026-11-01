// Job feed: a logged-in user can turn on a private RSS link of new jobs that
// fit their CV, replace the link, and turn it off; the link needs no login.
const enabled = document.getElementById("feedEnabled");
const feedPath = () => new URL(document.getElementById("feedUrl").value).pathname;

check("logged out: section hidden", document.getElementById("feedSection").hidden);
check("logged out: API refuses", (await fetch("/api/feed")).status === 401);

await signIn("user");
await loadFeedInfo();
check("logged in: section shown, off", !document.getElementById("feedSection").hidden && !enabled.checked);
check("off: no link", document.getElementById("feedLinkRow").hidden);

enabled.checked = true;
enabled.dispatchEvent(new Event("change"));
await wait(300);
check("on: link shown", !document.getElementById("feedLinkRow").hidden && /^\/feed\/[a-f0-9]{32}\.xml$/.test(feedPath()), feedPath());
const first = feedPath();
const res = await fetch(first);
const xml = await res.text();
check("feed served without login", res.status === 200 && res.headers.get("content-type").startsWith("application/rss+xml"), res.status);
check("feed is RSS", xml.includes('<rss version="2.0">'));
check("scored user: told what the feed holds", document.getElementById("feedInfo").textContent.includes("fit 60"));

await saveFeed({ enabled: true, rotate: true });
check("new link differs", feedPath() !== first);
check("old link stops working", (await fetch(first)).status === 404);
check("new link works", (await fetch(feedPath())).status === 200);

const last = feedPath();
enabled.checked = false;
enabled.dispatchEvent(new Event("change"));
await wait(300);
check("off: link hidden", document.getElementById("feedLinkRow").hidden);
check("off: link stops working", (await fetch(last)).status === 404);

await signIn("admin");
await loadFeedInfo();
check("other account: its own feed, off", !enabled.checked);
enabled.checked = true;
enabled.dispatchEvent(new Event("change"));
await wait(300);
check("unscored account: told the feed is empty for now", document.getElementById("feedInfo").textContent.includes("no fit scores"));
