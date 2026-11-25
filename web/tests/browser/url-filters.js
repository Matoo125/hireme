// The search, tags, sources, view and a chosen sort are kept in the URL, so a
// search can be bookmarked or shared; defaults stay out of it.
const params = () => new URL(location.href).searchParams;
const [a] = jobs;
const tag = splitTags(a)[0];
const source = splitSources(a)[0];

render();
check("defaults leave the URL clean", ["q", "tag", "source", "view", "sort"].every((k) => !params().has(k)), location.search);

searchEl.value = "policy";
toggleTag(tag);
toggleSource(source);
viewEl.value = "liked";
viewEl.dispatchEvent(new Event("change"));
sortEl.value = "org";
sortEl.dispatchEvent(new Event("change"));
check("search in URL", params().get("q") === "policy", location.search);
check("tag in URL", params().getAll("tag").includes(tag), location.search);
check("source in URL", params().getAll("source").includes(source), location.search);
check("view in URL", params().get("view") === "liked");
check("sort in URL", params().get("sort") === "org");
check("layout param kept", params().get("layout") === "table" || !params().has("layout"));

// Opening a URL with filters restores them.
searchEl.value = "";
activeTags.clear();
activeSources.clear();
viewEl.value = "all";
sortEl.value = "posted_desc";
history.replaceState(null, "", `?q=${encodeURIComponent(a.title)}&tag=${encodeURIComponent(tag)}&view=all&sort=closing_soon`);
readFiltersFromUrl();
render();
check("search restored", searchEl.value === a.title);
check("tag restored", activeTags.has(tag));
check("sort restored", sortEl.value === "closing_soon");
check("filters applied", shownRows.some((j) => j.id === a.id) && shownRows.length < jobs.length, String(shownRows.length));

// Unknown values are ignored rather than leaving the selects blank.
history.replaceState(null, "", "?view=nonsense&sort=nonsense");
readFiltersFromUrl();
check("bad view ignored", viewEl.value === "all");
check("bad sort ignored", sortEl.value === "closing_soon");

searchEl.value = "";
activeTags.clear();
render();
check("clearing removes them", !params().has("q") && !params().has("tag"), location.search);
