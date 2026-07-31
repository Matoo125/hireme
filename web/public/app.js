const jobsEl = document.getElementById("jobs");
const searchEl = document.getElementById("search");
const sortEl = document.getElementById("sort");
const countEl = document.getElementById("count");
const emptyEl = document.getElementById("empty");
const activeTagsEl = document.getElementById("activeTags");
const sourceFiltersEl = document.getElementById("sourceFilters");

let jobs = [];
const activeTags = new Set();
const activeSources = new Set();

function splitTags(job) {
  return (job.tags || "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
}

function splitSources(job) {
  return (job.source || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

const MAX_VISIBLE_TAGS = 4;

function parseDate(dateStr) {
  if (!dateStr) return null;
  const date = new Date(`${dateStr}T00:00:00Z`);
  return isNaN(date) ? null : date;
}

function formatAbsoluteDate(date) {
  const now = new Date();
  const opts = { month: "short", day: "numeric" };
  if (date.getUTCFullYear() !== now.getUTCFullYear()) opts.year = "numeric";
  return date.toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

function formatPosted(dateStr) {
  const date = parseDate(dateStr);
  if (!date) return "";
  const diff = daysBetween(date, new Date());
  if (diff <= 0) return "Posted today";
  if (diff === 1) return "Posted yesterday";
  if (diff < 14) return `Posted ${diff} days ago`;
  if (diff < 60) return `Posted ${Math.round(diff / 7)} weeks ago`;
  return `Posted ${formatAbsoluteDate(date)}`;
}

function formatCloses(dateStr) {
  const date = parseDate(dateStr);
  if (!date) return "";
  const diff = daysBetween(new Date(), date);
  if (diff < 0) return `Closed ${formatAbsoluteDate(date)}`;
  if (diff === 0) return "Closes today";
  if (diff === 1) return "Closes tomorrow";
  if (diff <= 21) return `Closes in ${diff} days`;
  return `Closes ${formatAbsoluteDate(date)}`;
}

function matchesSearch(job, term) {
  if (!term) return true;
  const haystack = [
    job.title,
    job.organization_name,
    job.description,
    job.tags,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(term);
}

function matchesActiveTags(job) {
  if (activeTags.size === 0) return true;
  const tags = splitTags(job);
  return [...activeTags].every((t) => tags.includes(t));
}

function matchesActiveSources(job) {
  if (activeSources.size === 0) return true;
  const sources = splitSources(job);
  return sources.some((s) => activeSources.has(s));
}

function sortJobs(list, mode) {
  const sorted = [...list];
  switch (mode) {
    case "posted_asc":
      sorted.sort((a, b) => (a.publication_date || "").localeCompare(b.publication_date || ""));
      break;
    case "closing_soon":
      sorted.sort((a, b) => {
        if (!a.close_date && !b.close_date) return 0;
        if (!a.close_date) return 1;
        if (!b.close_date) return -1;
        return a.close_date.localeCompare(b.close_date);
      });
      break;
    case "org":
      sorted.sort((a, b) => (a.organization_name || "").localeCompare(b.organization_name || ""));
      break;
    case "posted_desc":
    default:
      sorted.sort((a, b) => (b.publication_date || "").localeCompare(a.publication_date || ""));
  }
  return sorted;
}

function tagChip(tag) {
  const chip = document.createElement("button");
  chip.className = "chip" + (activeTags.has(tag) ? " active" : "");
  chip.textContent = tag;
  chip.addEventListener("click", () => toggleTag(tag));
  return chip;
}

function toggleTag(tag) {
  if (activeTags.has(tag)) activeTags.delete(tag);
  else activeTags.add(tag);
  render();
}

function toggleSource(source) {
  if (activeSources.has(source)) activeSources.delete(source);
  else activeSources.add(source);
  render();
}

function renderActiveTags() {
  activeTagsEl.innerHTML = "";
  for (const tag of activeTags) {
    const btn = document.createElement("button");
    btn.className = "chip removable active";
    btn.textContent = tag;
    btn.addEventListener("click", () => toggleTag(tag));
    activeTagsEl.appendChild(btn);
  }
}

function renderSourceFilters() {
  const counts = new Map();
  for (const job of jobs) {
    for (const source of splitSources(job)) {
      counts.set(source, (counts.get(source) || 0) + 1);
    }
  }
  sourceFiltersEl.innerHTML = "";
  for (const [source, count] of [...counts.entries()].sort()) {
    const btn = document.createElement("button");
    btn.className = "chip source-chip" + (activeSources.has(source) ? " active" : "");
    btn.textContent = `${source} (${count})`;
    btn.addEventListener("click", () => toggleSource(source));
    sourceFiltersEl.appendChild(btn);
  }
}

function jobCard(job) {
  const el = document.createElement("article");
  el.className = "job";

  const top = document.createElement("div");
  top.className = "job-top";

  const titleWrap = document.createElement("div");
  const title = document.createElement("h2");
  title.className = "job-title";
  const titleLink = document.createElement("a");
  titleLink.href = job.link || "#";
  titleLink.target = "_blank";
  titleLink.rel = "noopener noreferrer";
  titleLink.textContent = job.title || "Untitled role";
  title.appendChild(titleLink);
  titleWrap.appendChild(title);

  const org = document.createElement("p");
  org.className = "job-org";
  if (job.organization_url) {
    const orgLink = document.createElement("a");
    orgLink.href = job.organization_url;
    orgLink.target = "_blank";
    orgLink.rel = "noopener noreferrer";
    orgLink.textContent = job.organization_name || "Unknown organization";
    org.appendChild(orgLink);
  } else {
    org.textContent = job.organization_name || "Unknown organization";
  }
  titleWrap.appendChild(org);

  const meta = document.createElement("div");
  meta.className = "job-meta";
  const parts = [];
  if (job.publication_date) parts.push(formatPosted(job.publication_date));
  if (job.close_date) parts.push(formatCloses(job.close_date));
  meta.textContent = parts.join(" · ");
  const titleParts = [];
  if (job.publication_date) titleParts.push(`Posted: ${job.publication_date}`);
  if (job.close_date) titleParts.push(`Closes: ${job.close_date}`);
  if (titleParts.length) meta.title = titleParts.join("\n");

  top.appendChild(titleWrap);
  top.appendChild(meta);
  el.appendChild(top);

  const sources = splitSources(job);
  if (sources.length) {
    const sourceRow = document.createElement("div");
    sourceRow.className = "job-tags";
    for (const source of sources) {
      const badge = document.createElement("span");
      badge.className = "chip source-chip";
      badge.textContent = source;
      sourceRow.appendChild(badge);
    }
    el.appendChild(sourceRow);
  }

  if (job.salary_range) {
    const salary = document.createElement("div");
    salary.className = "job-salary";
    salary.textContent = job.salary_range;
    el.appendChild(salary);
  }

  if (job.description) {
    const desc = document.createElement("p");
    desc.className = "job-desc";
    desc.textContent = job.description;
    el.appendChild(desc);

    const toggle = document.createElement("button");
    toggle.className = "job-desc-toggle";
    toggle.textContent = "Show more";
    toggle.addEventListener("click", () => {
      el.classList.toggle("expanded");
      toggle.textContent = el.classList.contains("expanded") ? "Show less" : "Show more";
    });
    el.appendChild(toggle);
  }

  const tags = splitTags(job);
  if (tags.length) {
    const tagRow = document.createElement("div");
    tagRow.className = "job-tags";
    const hasOverflow = tags.length > MAX_VISIBLE_TAGS;
    const visibleTags = hasOverflow ? tags.slice(0, MAX_VISIBLE_TAGS) : tags;
    const hiddenTags = hasOverflow ? tags.slice(MAX_VISIBLE_TAGS) : [];

    for (const tag of visibleTags) {
      tagRow.appendChild(tagChip(tag));
    }

    if (hasOverflow) {
      for (const tag of hiddenTags) {
        const chip = tagChip(tag);
        chip.hidden = true;
        chip.dataset.overflow = "true";
        tagRow.appendChild(chip);
      }
      const more = document.createElement("button");
      more.className = "chip more-toggle";
      more.textContent = `+${hiddenTags.length} more`;
      more.addEventListener("click", () => {
        const expanded = tagRow.classList.toggle("expanded");
        for (const chip of tagRow.querySelectorAll('[data-overflow="true"]')) {
          chip.hidden = !expanded;
        }
        more.textContent = expanded ? "Show less" : `+${hiddenTags.length} more`;
      });
      tagRow.appendChild(more);
    }

    el.appendChild(tagRow);
  }

  return el;
}

function render() {
  const term = searchEl.value.trim().toLowerCase();
  const filtered = jobs.filter(
    (j) => matchesSearch(j, term) && matchesActiveTags(j) && matchesActiveSources(j)
  );
  const sorted = sortJobs(filtered, sortEl.value);

  renderSourceFilters();
  renderActiveTags();
  countEl.textContent = `${sorted.length} job${sorted.length === 1 ? "" : "s"}`;
  jobsEl.innerHTML = "";
  emptyEl.hidden = sorted.length > 0;
  for (const job of sorted) {
    jobsEl.appendChild(jobCard(job));
  }
}

async function init() {
  countEl.textContent = "Loading…";
  const res = await fetch("/api/jobs");
  jobs = await res.json();
  render();
}

searchEl.addEventListener("input", render);
sortEl.addEventListener("change", render);

init();
