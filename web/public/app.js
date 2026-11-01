// ── Auth ─────────────────────────────────────────────────────────────────────

const AUTH_URL = "https://api.altfresh.sk";
const TOKEN_KEY = "hireme.token";
const USER_KEY = "hireme.user";

let cachedJwt = null;
let jwtExpiresAt = 0;

function getSessionToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function getUser() {
  return localStorage.getItem(USER_KEY);
}

function isLoggedIn() {
  return Boolean(getSessionToken());
}

async function getJwt() {
  if (cachedJwt && Date.now() < jwtExpiresAt) return cachedJwt;
  const token = getSessionToken();
  if (!token) throw new Error("Not logged in");
  const res = await fetch(`${AUTH_URL}/auth/token`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Session expired");
  const data = await res.json();
  cachedJwt = data.token;
  jwtExpiresAt = Date.now() + 14 * 60 * 1000;
  return cachedJwt;
}

function handleAuthCallback() {
  const hash = window.location.hash;
  if (!hash.includes("token=")) return;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get("token");
  const user = params.get("user");
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    if (user) localStorage.setItem(USER_KEY, user);
    // Clear the fragment without triggering a reload
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

function login() {
  window.location.href = `${AUTH_URL}/?redirect=${encodeURIComponent(window.location.origin)}`;
}

function logout() {
  const token = getSessionToken();
  if (token) {
    fetch(`${AUTH_URL}/auth/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  isAdmin = false;
  fitScores.clear();
  fitSortOption.hidden = true;
  if (sortEl.value === "fit_desc") sortEl.value = "posted_desc";
  cachedJwt = null;
  jwtExpiresAt = 0;
  updateAuthUI();
}

function updateAuthUI() {
  const loginBtn = document.getElementById("loginBtn");
  const userInfo = document.getElementById("userInfo");
  const userName = document.getElementById("userName");
  const cvSection = document.getElementById("cvSection");
  const pageSection = document.getElementById("pageSection");
  const addJobSection = document.getElementById("addJobSection");
  const feedSection = document.getElementById("feedSection");
  const digestSection = document.getElementById("digestSection");

  if (isLoggedIn()) {
    loginBtn.hidden = true;
    userInfo.hidden = false;
    userName.textContent = getUser() || "User";
    cvSection.hidden = false;
    pageSection.hidden = false;
    feedSection.hidden = false;
    digestSection.hidden = false;
    addJobSection.hidden = false;
    loadCvInfo();
    loadPageInfo();
    loadFeedInfo();
    loadDigestInfo();
  } else {
    loginBtn.hidden = false;
    userInfo.hidden = true;
    cvSection.hidden = true;
    pageSection.hidden = true;
    feedSection.hidden = true;
    digestSection.hidden = true;
    addJobSection.hidden = true;
  }
}

// ── CV ───────────────────────────────────────────────────────────────────────

async function loadCvInfo() {
  const cvInfo = document.getElementById("cvInfo");
  const cvFilename = document.getElementById("cvFilename");
  const cvDate = document.getElementById("cvDate");
  const cvStatus = document.getElementById("cvStatus");

  try {
    const jwt = await getJwt();
    const res = await fetch("/api/cv", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (res.status === 404) {
      cvInfo.hidden = true;
      document.getElementById("cvAdvice").hidden = true;
      return;
    }
    if (!res.ok) throw new Error("Failed to load CV info");
    const meta = await res.json();
    cvFilename.textContent = meta.filename;
    cvDate.textContent = `uploaded ${new Date(meta.uploadedAt).toLocaleDateString()}`;
    cvInfo.hidden = false;
    loadAdvice();
  } catch (err) {
    cvInfo.hidden = true;
    if (err.message === "Session expired") {
      logout();
    }
  }
}

async function uploadCv() {
  const fileInput = document.getElementById("cvFile");
  const cvStatus = document.getElementById("cvStatus");
  const file = fileInput.files[0];
  if (!file) return;

  cvStatus.hidden = false;
  cvStatus.textContent = "Uploading...";
  cvStatus.className = "cv-status";

  try {
    const jwt = await getJwt();
    const res = await fetch(`/api/cv?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/pdf",
      },
      body: file,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Upload failed");
    }
    cvStatus.textContent = "CV uploaded.";
    fileInput.value = "";
    document.getElementById("cvUploadBtn").disabled = true;
    setTimeout(() => { cvStatus.hidden = true; }, 2500);
    await loadCvInfo();
    loadPageInfo();
  } catch (err) {
    cvStatus.textContent = err.message;
    cvStatus.className = "cv-status cv-status--error";
  }
}

async function downloadCv(e) {
  e.preventDefault();
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/cv/file", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) throw new Error("Download failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const disposition = res.headers.get("Content-Disposition");
    const match = disposition?.match(/filename="(.+)"/);
    a.download = match ? match[1] : "cv.pdf";
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(err.message);
  }
}

async function deleteCv() {
  if (!confirm("Delete your CV?")) return;
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/cv", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) throw new Error("Delete failed");
    document.getElementById("cvInfo").hidden = true;
    document.getElementById("cvAdvice").hidden = true;
    loadPageInfo();
  } catch (err) {
    alert(err.message);
  }
}

// ── CV advice ────────────────────────────────────────────────────────────────
// Suggestions for the CV, from comparing it with the jobs the user likes,
// tracks or fits best. Made in the background on request; the user edits the PDF.

let advicePolls = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function showAdvice(data) {
  const box = document.getElementById("cvAdvice");
  const btn = document.getElementById("cvAdviceBtn");
  const info = document.getElementById("cvAdviceInfo");
  const body = document.getElementById("cvAdviceBody");

  box.hidden = data.status === "no-cv";
  if (box.hidden) return;
  const generating = data.status === "generating";
  btn.disabled = generating;
  btn.textContent = data.advice ? "Suggest again" : "Suggest improvements";

  info.className = data.error ? "cv-status cv-status--error" : "cv-status";
  info.textContent = data.error
    ?? (generating ? "Reading your CV next to your jobs… this takes up to a minute or two."
      : data.status === "stale" ? "These suggestions are for your previous CV. Ask again for your current one."
      : data.generatedAt ? `Suggested ${new Date(data.generatedAt).toLocaleDateString()}.` : "");
  info.hidden = !info.textContent;

  body.replaceChildren();
  body.hidden = !data.advice;
  if (data.advice) {
    const { summary, keep, suggestions } = data.advice;
    body.append(el("p", "cv-advice-summary", summary));
    if (suggestions.length) {
      body.append(el("h4", "", "What to change"));
      const list = el("ol");
      for (const s of suggestions) {
        const item = el("li");
        const head = el("strong", "", s.title);
        item.append(head);
        if (s.where) item.append(" ", el("span", "cv-advice-where", `(${s.where})`));
        item.append(el("p", "", s.change), el("p", "cv-advice-why", s.why));
        const titles = s.job_ids.map((id) => data.jobTitles[id]).filter(Boolean);
        if (titles.length) item.append(el("div", "cv-advice-jobs", `Helps with: ${titles.join("; ")}`));
        list.append(item);
      }
      body.append(list);
    }
    if (keep.length) {
      body.append(el("h4", "", "Keep"));
      const list = el("ul");
      for (const k of keep) list.append(el("li", "", k));
      body.append(list);
    }
  }

  if (generating) {
    if (advicePolls++ < 60) setTimeout(loadAdvice, 3000);
  } else {
    advicePolls = 0;
  }
}

async function loadAdvice() {
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/cv/advice", { headers: { Authorization: `Bearer ${jwt}` } });
    if (!res.ok) throw new Error("Failed to load suggestions");
    showAdvice(await res.json());
  } catch (err) {
    if (err.message === "Session expired") logout();
  }
}

async function requestAdvice() {
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/cv/advice", { method: "POST", headers: { Authorization: `Bearer ${jwt}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't start");
    advicePolls = 0;
    showAdvice(data);
  } catch (err) {
    if (err.message === "Session expired") return logout();
    const info = document.getElementById("cvAdviceInfo");
    info.hidden = false;
    info.textContent = err.message;
    info.className = "cv-status cv-status--error";
  }
}

// ── Portfolio page ───────────────────────────────────────────────────────────

const PAGE_STATUS_TEXT = {
  off: "Your page is off. Turn it on to publish one built from your CV.",
  "no-cv": "Upload a CV first. Your page is made from it.",
  generating: "Making your page from your CV…",
  pending: "Your page is being updated…",
};

let pagePolls = 0;

function showPage(page) {
  const pageEnabled = document.getElementById("pageEnabled");
  const pageSlug = document.getElementById("pageSlug");
  const pageInfo = document.getElementById("pageInfo");

  pageEnabled.checked = page.enabled;
  if (!pageSlug.matches(":focus")) pageSlug.value = page.slug;
  pageInfo.className = "cv-status";
  pageInfo.hidden = false;
  if (page.status === "ready") {
    pageInfo.innerHTML = "";
    const link = document.createElement("a");
    link.href = page.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = page.url;
    pageInfo.append("Your page is live at ", link);
  } else {
    pageInfo.textContent = PAGE_STATUS_TEXT[page.status] ?? "";
  }

  // The page is made in the background: check back until it's ready (about a minute at most).
  if (page.status === "generating" || page.status === "pending") {
    if (pagePolls++ < 20) setTimeout(loadPageInfo, 3000);
  } else {
    pagePolls = 0;
  }
}

function showPageError(message) {
  const pageInfo = document.getElementById("pageInfo");
  pageInfo.hidden = false;
  pageInfo.textContent = message;
  pageInfo.className = "cv-status cv-status--error";
}

async function loadPageInfo() {
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/page", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) throw new Error("Failed to load your page");
    showPage(await res.json());
  } catch (err) {
    if (err.message === "Session expired") logout();
  }
}

async function savePage(e) {
  e?.preventDefault();
  const pageEnabled = document.getElementById("pageEnabled");
  const pageSlug = document.getElementById("pageSlug");
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/page", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: pageEnabled.checked, slug: pageSlug.value.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Save failed");
    pagePolls = 0;
    showPage(data);
  } catch (err) {
    // Show what the server has, then say why the change didn't go through.
    await loadPageInfo();
    showPageError(err.message);
  }
}

// ── Job feed ─────────────────────────────────────────────────────────────────
// A private RSS link of new jobs that fit the CV; the link itself is the secret.

function showFeed(feed) {
  const feedInfo = document.getElementById("feedInfo");
  document.getElementById("feedEnabled").checked = feed.enabled;
  document.getElementById("feedLinkRow").hidden = !feed.enabled;
  document.getElementById("feedUrl").value = feed.url ?? "";
  feedInfo.className = "cv-status";
  feedInfo.hidden = false;
  if (!feed.enabled) {
    feedInfo.textContent = "Off. Turn it on for a private link to add to your feed reader.";
  } else if (!feed.scored) {
    feedInfo.textContent = "Your account has no fit scores yet, so the feed stays empty until it does.";
  } else {
    feedInfo.textContent = `New jobs from the last 30 days with fit ${feed.minFit} or more, open to Europe. Keep the link private: anyone with it can read the feed.`;
  }
}

function showFeedError(message) {
  const feedInfo = document.getElementById("feedInfo");
  feedInfo.hidden = false;
  feedInfo.textContent = message;
  feedInfo.className = "cv-status cv-status--error";
}

async function loadFeedInfo() {
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/feed", { headers: { Authorization: `Bearer ${jwt}` } });
    if (!res.ok) throw new Error("Failed to load your feed");
    showFeed(await res.json());
  } catch (err) {
    if (err.message === "Session expired") logout();
  }
}

async function saveFeed(body) {
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/feed", {
      method: "PUT",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Save failed");
    showFeed(data);
  } catch (err) {
    await loadFeedInfo();
    showFeedError(err.message);
  }
}

async function copyFeedUrl() {
  const input = document.getElementById("feedUrl");
  try {
    await navigator.clipboard.writeText(input.value);
    document.getElementById("feedCopy").textContent = "Copied";
    setTimeout(() => (document.getElementById("feedCopy").textContent = "Copy link"), 1500);
  } catch {
    input.select();
  }
}

// ── Email digest ─────────────────────────────────────────────────────────────
// One email after each daily scrape that found new jobs fitting the CV, to an
// address confirmed from an emailed link.

function showDigest(digest) {
  const input = document.getElementById("digestEmail");
  const info = document.getElementById("digestInfo");
  if (!input.matches(":focus")) input.value = digest.email;
  document.getElementById("digestStop").hidden = digest.status === "off";
  info.className = "cv-status";
  info.hidden = false;
  if (!digest.available) {
    info.textContent = "Email digests aren't set up on this server yet.";
    document.getElementById("digestForm").querySelector("button[type=submit]").disabled = true;
  } else if (digest.status === "pending") {
    info.textContent = `Check ${digest.email} for a confirmation link. Nothing is sent until you confirm.`;
  } else if (digest.status === "on") {
    info.textContent = digest.scored
      ? `On: an email after each daily update that finds new jobs with fit ${digest.minFit} or more, open to Europe.`
      : "On, but your account has no fit scores yet, so nothing is sent until it does.";
  } else {
    info.textContent = "Off.";
  }
}

function showDigestError(message) {
  const info = document.getElementById("digestInfo");
  info.hidden = false;
  info.textContent = message;
  info.className = "cv-status cv-status--error";
}

async function digestRequest(method, body) {
  const jwt = await getJwt();
  const res = await fetch("/api/digest", {
    method,
    headers: { Authorization: `Bearer ${jwt}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

async function loadDigestInfo() {
  try {
    showDigest(await digestRequest("GET"));
  } catch (err) {
    if (err.message === "Session expired") logout();
  }
}

async function saveDigest(e) {
  e.preventDefault();
  try {
    showDigest(await digestRequest("PUT", { email: document.getElementById("digestEmail").value.trim() }));
  } catch (err) {
    showDigestError(err.message);
  }
}

async function stopDigest() {
  try {
    showDigest(await digestRequest("DELETE"));
  } catch (err) {
    showDigestError(err.message);
  }
}

// Auth event listeners
handleAuthCallback();
document.getElementById("loginBtn").addEventListener("click", login);
document.getElementById("logoutBtn").addEventListener("click", logout);
document.getElementById("cvUploadBtn").addEventListener("click", uploadCv);
document.getElementById("cvDownload").addEventListener("click", downloadCv);
document.getElementById("cvDelete").addEventListener("click", deleteCv);
document.getElementById("cvAdviceBtn").addEventListener("click", requestAdvice);
document.getElementById("cvFile").addEventListener("change", (e) => {
  document.getElementById("cvUploadBtn").disabled = !e.target.files.length;
});
document.getElementById("pageEnabled").addEventListener("change", savePage);
document.getElementById("pageForm").addEventListener("submit", savePage);
document.getElementById("feedEnabled").addEventListener("change", (e) => saveFeed({ enabled: e.target.checked }));
document.getElementById("digestForm").addEventListener("submit", saveDigest);
document.getElementById("digestStop").addEventListener("click", stopDigest);
document.getElementById("feedCopy").addEventListener("click", copyFeedUrl);
document.getElementById("feedRotate").addEventListener("click", () => {
  if (confirm("Make a new link? The current one stops working.")) saveFeed({ enabled: true, rotate: true });
});

// ── Job board ────────────────────────────────────────────────────────────────

const jobsEl = document.getElementById("jobs");
const searchEl = document.getElementById("search");
const sortEl = document.getElementById("sort");
const viewEl = document.getElementById("view");
const countEl = document.getElementById("count");
const emptyEl = document.getElementById("empty");
const activeTagsEl = document.getElementById("activeTags");
const sourceFiltersEl = document.getElementById("sourceFilters");
const detailToggleEls = document.querySelectorAll(".detail-toggle");
const layoutEl = document.getElementById("layout");
const sheetEl = document.getElementById("sheet");
const detailTogglesEl = document.getElementById("detailToggles");
const downloadCsvEl = document.getElementById("downloadCsv");
const clearGridFiltersEl = document.getElementById("clearGridFilters");

let jobs = [];
const activeTags = new Set();

// Admins (ADMIN_USER_IDS on the server) can correct scraped values in the
// grid. Corrections go to overrides.toml (scrapers/overrides.py), so the next
// scrape keeps them.
let isAdmin = false;

async function loadAdmin() {
  if (!isLoggedIn()) return;
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/admin", { headers: { Authorization: `Bearer ${jwt}` } });
    const admin = res.ok && (await res.json()).admin === true;
    if (admin !== isAdmin) {
      isAdmin = admin;
      render();
    }
  } catch {}
}

/** Save {field: value, or null to undo} for a job; returns its new row. */
async function saveCorrection(jobId, patch) {
  const jwt = await getJwt();
  const res = await fetch(`/api/overrides/${encodeURIComponent(jobId)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const activeSources = new Set();

// Liked/hidden state persists in localStorage and, when logged in,
// syncs to the server so it follows the user across devices.
const LIKED_KEY = "jobBoard.liked";
const HIDDEN_KEY = "jobBoard.hidden";

function loadIdSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return new Set();
  }
}

function saveIdSet(key, set) {
  localStorage.setItem(key, JSON.stringify([...set]));
}

const likedJobs = loadIdSet(LIKED_KEY);
const hiddenJobs = loadIdSet(HIDDEN_KEY);

// ── New since your last visit ───────────────────────────────────────────────
//
// A job is new when the scrape first found it (first_seen) after the last
// day you visited before today. Days rather than times, because first_seen
// is a date: the badges stay put all day and move on the next. Kept like
// liked/hidden: in localStorage, and synced with the preferences when
// logged in, so a visit on your phone counts on your laptop too.

const VISITS_KEY = "jobBoard.visits";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC, like the scrape's first_seen dates. */
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/** {last, previous} with today's visit counted: previous is the last day before today. */
function rollVisits(visits, today = todayUTC()) {
  const last = DATE_RE.test(visits?.last) ? visits.last : null;
  const previous = DATE_RE.test(visits?.previous) ? visits.previous : null;
  if (!last) return { last: today, previous: null };
  if (last < today) return { last: today, previous: last };
  return { last, previous };
}

/** Two devices' visits as one: the latest earlier-day visit on either. */
function mergeVisits(a, b) {
  const x = rollVisits(a);
  const y = rollVisits(b);
  const previous = [x.previous, y.previous].filter(Boolean).sort().pop() || null;
  return { last: x.last > y.last ? x.last : y.last, previous };
}

function loadVisits() {
  try {
    return rollVisits(JSON.parse(localStorage.getItem(VISITS_KEY) || "null"));
  } catch {
    return rollVisits(null);
  }
}

function saveVisits() {
  localStorage.setItem(VISITS_KEY, JSON.stringify(visits));
}

let visits = loadVisits();
saveVisits();

function isNew(job) {
  return Boolean(visits.previous && job.first_seen && job.first_seen > visits.previous);
}

// ── Open to Europe ───────────────────────────────────────────────────────────
//
// Jobs someone living in Europe can't take (europe "no", read from the full
// posting by scrapers/europe.py) are left out unless asked for, remembered
// per browser. The liked, hidden and tracked views show them anyway: you put
// them there.

const EUROPE_KEY = "jobBoard.includeNotEurope";
const europeToggleEl = document.getElementById("europeToggle");
let includeNotEurope = localStorage.getItem(EUROPE_KEY) === "1";

function europeFilterApplies() {
  return !["liked", "hidden", "tracked"].includes(viewEl.value);
}

function matchesEurope(job) {
  return includeNotEurope || job.europe !== "no" || !europeFilterApplies();
}

// ── Application tracker state ───────────────────────────────────────────────

const APPS_KEY = "jobBoard.applications";
const VALID_STATUSES = ["interested", "applied", "interviewing", "offered", "rejected", "withdrawn"];
const STATUS_LABELS = {
  interested: "Interested",
  applied: "Applied",
  interviewing: "Interviewing",
  offered: "Offered",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

function loadAppsFromStorage() {
  try {
    const raw = JSON.parse(localStorage.getItem(APPS_KEY) || "{}");
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

function saveAppsToStorage() {
  localStorage.setItem(APPS_KEY, JSON.stringify(Object.fromEntries(applications)));
}

const applications = loadAppsFromStorage();

// ── Fit scores ───────────────────────────────────────────────────────────────

// jobId → {score, reason}, from fit_scores.py via GET /api/fit. Only for
// accounts it scores; others never see the sort option or the badges.
const fitScores = new Map();
const fitSortOption = document.querySelector('#sort option[value="fit_desc"]');

// Below this, a job folds into "Probably not for you" when sorting by fit:
// the "poor match" band of fit_scores.py's scale.
const LOW_FIT = 40;
// Set once you pick a sort yourself; until then best fit is the default
// for an account with scores.
let sortChosen = false;
// The folded jobs are shown (and built) only once asked for.
let showLowFit = false;

function fitBand(score) {
  return score >= 70 ? "high" : score >= LOW_FIT ? "mid" : "low";
}

/** Folded when sorting by fit, unless you've liked or tracked it. */
function isLowFit(job) {
  const fit = fitScores.get(job.id);
  return Boolean(fit && fit.score < LOW_FIT && !likedJobs.has(job.id) && !applications.has(job.id));
}

async function loadFit() {
  if (!isLoggedIn()) return;
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/fit", { headers: { Authorization: `Bearer ${jwt}` } });
    if (!res.ok) return;
    const { scores } = await res.json();
    fitScores.clear();
    for (const [id, entry] of Object.entries(scores || {})) fitScores.set(id, entry);
    fitSortOption.hidden = fitScores.size === 0;
    if (fitScores.size && !sortChosen) sortEl.value = "fit_desc";
    render();
  } catch {}
}

// ── Rich-text notes and letters ──────────────────────────────────────────────
//
// An application's notes and motivation letter are Markdown, edited in the
// editor shared with bookmarks (@research/editor), which the server bundles
// and serves at /editor.js. It's fetched the first time a tracked card shows;
// until it arrives — or if it can't — the plain textarea works on its own and
// saves the same text.

const NOTES_TOOLBAR = "compact";
const LETTER_TOOLBAR = [
  "Bold", "Italic", "Strikethrough", "Link", "Heading", "Subheading",
  "Bulleted list", "Numbered list", "Quote", "Undo", "Redo",
];

let editorModule = null;
function loadEditor() {
  editorModule ??= import("/editor.js").catch((err) => {
    console.warn("Rich-text editor unavailable, using plain text:", err);
    return null;
  });
  return editorModule;
}

/** Fields with an edit in flight; render() saves and closes them before rebuilding the cards. */
const liveFields = new Set();

function closeLiveFields() {
  for (const field of [...liveFields]) field.close();
}

/**
 * Autosave a notes or letter textarea into the application, and upgrade it to
 * the editor once that has loaded. Saves 500ms after the last edit, reading
 * the text then rather than on every keystroke.
 */
function attachTextField(textarea, jobId, key, toolbar) {
  let editor = null;
  let dirty = false;
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    updateApplication(jobId, key, editor ? editor.getData() : textarea.value);
  };
  const changed = () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  const field = {
    close() {
      save();
      editor?.destroy();
      liveFields.delete(field);
    },
  };
  liveFields.add(field);
  textarea.addEventListener("input", changed);

  loadEditor().then(async (module) => {
    if (!module || !liveFields.has(field)) return;
    const created = await module.createNoteEditor(textarea, changed, { toolbar });
    // The card was rebuilt while the editor loaded.
    if (!liveFields.has(field)) return void created.destroy();
    editor = created;
  }).catch((err) => console.warn("Rich-text editor unavailable, using plain text:", err));
}

async function saveApplication(jobId, data) {
  applications.set(jobId, data);
  saveAppsToStorage();
  if (!isLoggedIn()) return;
  try {
    const jwt = await getJwt();
    fetch(`/api/applications/${encodeURIComponent(jobId)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  } catch {}
}

async function deleteApplication(jobId) {
  applications.delete(jobId);
  saveAppsToStorage();
  if (!isLoggedIn()) return;
  try {
    const jwt = await getJwt();
    fetch(`/api/applications/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });
  } catch {}
}

async function loadApplications() {
  if (!isLoggedIn()) return;
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/applications", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (res.ok) {
      const data = await res.json();
      applications.clear();
      for (const [id, entry] of Object.entries(data)) applications.set(id, entry);
      saveAppsToStorage();
      render();
    } else if (res.status === 404 && applications.size) {
      // Push local state up to the server
      for (const [id, entry] of applications) {
        const jwt2 = await getJwt();
        fetch(`/api/applications/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${jwt2}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(entry),
        });
      }
    }
  } catch {}
}

function toggleTracked(jobId) {
  if (applications.has(jobId)) {
    deleteApplication(jobId);
  } else {
    const now = new Date().toISOString();
    saveApplication(jobId, {
      status: "interested",
      notes: "",
      motivationLetter: "",
      createdAt: now,
      updatedAt: now,
    });
  }
  render();
}

function updateApplication(jobId, field, value) {
  const entry = applications.get(jobId);
  if (!entry) return;
  entry[field] = value;
  entry.updatedAt = new Date().toISOString();
  saveApplication(jobId, entry);
}

// ── Custom (user-added) jobs ─────────────────────────────────────────────────
//
// Logged-in users can add a job by pasting its link. The server fetches the
// page to fill in a title (falling back to the hostname), stores it per-user
// (so it survives the next scrape overwriting jobs.csv), and we merge it into
// `jobs` client-side so it sorts/filters/likes/tracks like any other listing.

async function loadCustomJobs() {
  if (!isLoggedIn()) return;
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/custom-jobs", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return;
    const customJobs = await res.json();
    jobs = [...jobs.filter((j) => j.source !== "custom"), ...customJobs];
    render();
  } catch {}
}

async function addCustomJob(link, title) {
  const jwt = await getJwt();
  const res = await fetch("/api/custom-jobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ link, title }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not add that link");
  if (!jobs.some((j) => j.id === data.id)) jobs = [...jobs, data];
  render();
}

async function removeCustomJob(jobId) {
  jobs = jobs.filter((j) => j.id !== jobId);
  render();
  try {
    const jwt = await getJwt();
    await fetch(`/api/custom-jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });
  } catch {}
}

const addJobForm = document.getElementById("addJobForm");
const addJobLinkEl = document.getElementById("addJobLink");
const addJobTitleEl = document.getElementById("addJobTitle");
const addJobStatusEl = document.getElementById("addJobStatus");

addJobForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const link = addJobLinkEl.value.trim();
  if (!link) return;
  const submitBtn = addJobForm.querySelector("button");
  submitBtn.disabled = true;
  addJobStatusEl.hidden = true;
  try {
    await addCustomJob(link, addJobTitleEl.value.trim());
    addJobForm.reset();
  } catch (err) {
    addJobStatusEl.textContent = err.message || "Could not add that link";
    addJobStatusEl.className = "cv-status cv-status--error";
    addJobStatusEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

// Granular, global control over which detail sections cards show:
// job board tags (source badges), salary, description, and topic tags.
// Every card respects the same settings - there's no per-card override.
const DETAIL_SETTINGS_KEY = "jobBoard.detailSettings";
const DETAIL_KEYS = ["sources", "salary", "description", "tags"];

function loadDetailSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(DETAIL_SETTINGS_KEY) || "{}");
  } catch {
    saved = {};
  }
  const settings = {};
  for (const key of DETAIL_KEYS) settings[key] = Boolean(saved[key]);
  return settings;
}

const detailSettings = loadDetailSettings();

function saveDetailSettings() {
  localStorage.setItem(DETAIL_SETTINGS_KEY, JSON.stringify(detailSettings));
}

function renderDetailToggles() {
  for (const btn of detailToggleEls) {
    btn.classList.toggle("active", detailSettings[btn.dataset.detail]);
  }
}

for (const btn of detailToggleEls) {
  btn.addEventListener("click", () => {
    const key = btn.dataset.detail;
    detailSettings[key] = !detailSettings[key];
    saveDetailSettings();
    renderDetailToggles();
    render();
  });
}
renderDetailToggles();

async function savePreferences() {
  if (!isLoggedIn()) return;
  try {
    const jwt = await getJwt();
    fetch("/api/preferences", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        liked: [...likedJobs],
        hidden: [...hiddenJobs],
        visits,
      }),
    });
  } catch {}
}

async function loadPreferences() {
  if (!isLoggedIn()) return;
  try {
    const jwt = await getJwt();
    const res = await fetch("/api/preferences", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (res.ok) {
      const data = await res.json();
      likedJobs.clear();
      hiddenJobs.clear();
      for (const id of data.liked || []) likedJobs.add(id);
      for (const id of data.hidden || []) hiddenJobs.add(id);
      saveIdSet(LIKED_KEY, likedJobs);
      saveIdSet(HIDDEN_KEY, hiddenJobs);
      const merged = mergeVisits(visits, data.visits);
      visits = merged;
      saveVisits();
      if (JSON.stringify(merged) !== JSON.stringify(data.visits)) savePreferences();
      render();
    } else if (res.status === 404) {
      savePreferences();
    }
  } catch {}
}

function toggleLiked(id) {
  if (likedJobs.has(id)) likedJobs.delete(id);
  else likedJobs.add(id);
  saveIdSet(LIKED_KEY, likedJobs);
  savePreferences();
  render();
}

function toggleHidden(id) {
  if (hiddenJobs.has(id)) hiddenJobs.delete(id);
  else hiddenJobs.add(id);
  saveIdSet(HIDDEN_KEY, hiddenJobs);
  savePreferences();
  render();
}

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

function matchesView(job, mode) {
  switch (mode) {
    case "liked":
      return likedJobs.has(job.id) && !hiddenJobs.has(job.id);
    case "hidden":
      return hiddenJobs.has(job.id);
    case "tracked":
      return applications.has(job.id);
    case "new":
      return isNew(job) && !hiddenJobs.has(job.id);
    case "all":
    default:
      return !hiddenJobs.has(job.id);
  }
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
    case "fit_desc":
      // Unscored jobs (added by link, or not scored yet) last, newest first.
      sorted.sort((a, b) =>
        (fitScores.get(b.id)?.score ?? -1) - (fitScores.get(a.id)?.score ?? -1) ||
        (b.publication_date || "").localeCompare(a.publication_date || ""));
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

function buildSourceRow(job) {
  const sources = splitSources(job);
  if (!sources.length) return null;
  const row = document.createElement("div");
  row.className = "job-tags";
  for (const source of sources) {
    const badge = document.createElement("span");
    badge.className = "chip source-chip";
    badge.textContent = source;
    row.appendChild(badge);
  }
  return row;
}

function buildSalaryRow(job) {
  if (!job.salary_range) return null;
  const salary = document.createElement("div");
  salary.className = "job-salary";
  salary.textContent = job.salary_range;
  return salary;
}

function buildDescriptionBlock(job) {
  if (!job.description) return null;
  const wrap = document.createElement("div");
  wrap.className = "job-desc-wrap";

  const desc = document.createElement("p");
  desc.className = "job-desc";
  desc.textContent = job.description;
  wrap.appendChild(desc);

  const toggle = document.createElement("button");
  toggle.className = "job-desc-toggle";
  toggle.textContent = "Show more";
  // Hidden until the deferred overflow check (see updateDescriptionToggles)
  // confirms the text actually needs clamping.
  toggle.hidden = true;
  toggle.addEventListener("click", () => {
    const expanded = wrap.classList.toggle("expanded");
    toggle.textContent = expanded ? "Show less" : "Show more";
  });
  wrap.appendChild(toggle);

  return wrap;
}

function buildTagsRow(job, { collapse }) {
  const tags = splitTags(job);
  if (!tags.length) return null;
  const tagRow = document.createElement("div");
  tagRow.className = "job-tags";
  const hasOverflow = collapse && tags.length > MAX_VISIBLE_TAGS;
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

  return tagRow;
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
  const isLiked = likedJobs.has(job.id);
  const isHidden = hiddenJobs.has(job.id);
  const isTracked = applications.has(job.id);
  el.className = "job" + (isLiked ? " is-liked" : "") + (isHidden ? " is-hidden" : "") + (isTracked ? " is-tracked" : "");

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
  if (isNew(job)) {
    const badge = document.createElement("span");
    badge.className = "new-badge";
    badge.textContent = "New";
    badge.title = `First seen ${job.first_seen}, since your last visit on ${visits.previous}`;
    title.append(" ", badge);
  }
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

  const fit = fitScores.get(job.id);
  if (fit) {
    const fitEl = document.createElement("p");
    fitEl.className = "job-fit";
    const badge = document.createElement("span");
    badge.className = `fit-score fit-${fitBand(fit.score)}`;
    badge.textContent = fit.score;
    badge.title = "How well this job fits your CV (0–100)";
    fitEl.append(badge, ` ${fit.reason}`);
    titleWrap.appendChild(fitEl);
  }
  if (job.europe === "no") {
    const europeEl = document.createElement("p");
    europeEl.className = "job-europe";
    europeEl.textContent = `Not open to Europe${job.europe_reason ? `: ${job.europe_reason}` : ""}`;
    titleWrap.appendChild(europeEl);
  }

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

  const actions = document.createElement("div");
  actions.className = "job-actions";

  const likeBtn = document.createElement("button");
  likeBtn.className = "action-btn like-btn" + (isLiked ? " active" : "");
  likeBtn.textContent = isLiked ? "★ Liked" : "☆ Like";
  likeBtn.title = isLiked ? "Remove from liked" : "Mark as liked";
  likeBtn.addEventListener("click", () => toggleLiked(job.id));
  actions.appendChild(likeBtn);

  const hideBtn = document.createElement("button");
  hideBtn.className = "action-btn hide-btn" + (isHidden ? " active" : "");
  hideBtn.textContent = isHidden ? "↺ Restore" : "✕ Not relevant";
  hideBtn.title = isHidden ? "Restore to list" : "Hide as not relevant";
  hideBtn.addEventListener("click", () => toggleHidden(job.id));
  actions.appendChild(hideBtn);

  if (isLoggedIn()) {
    const trackBtn = document.createElement("button");
    trackBtn.className = "action-btn track-btn" + (isTracked ? " active" : "");
    trackBtn.textContent = isTracked ? "◉ Tracked" : "○ Track";
    trackBtn.title = isTracked ? "Remove from tracked" : "Track this application";
    trackBtn.addEventListener("click", () => toggleTracked(job.id));
    actions.appendChild(trackBtn);
  }

  if (job.source === "custom") {
    const removeBtn = document.createElement("button");
    removeBtn.className = "action-btn remove-btn";
    removeBtn.textContent = "🗑 Remove";
    removeBtn.title = "Remove this job you added";
    removeBtn.addEventListener("click", () => removeCustomJob(job.id));
    actions.appendChild(removeBtn);
  }

  const rightCol = document.createElement("div");
  rightCol.className = "job-top-right";
  rightCol.appendChild(meta);
  rightCol.appendChild(actions);

  top.appendChild(titleWrap);
  top.appendChild(rightCol);
  el.appendChild(top);

  const sections = {
    sources: buildSourceRow(job),
    salary: buildSalaryRow(job),
    description: buildDescriptionBlock(job),
    tags: buildTagsRow(job, { collapse: true }),
  };

  let cardExpanded = false;
  let hasHiddenContent = false;
  for (const key of DETAIL_KEYS) {
    const section = sections[key];
    if (!section) continue;
    section.hidden = !detailSettings[key];
    if (!detailSettings[key]) hasHiddenContent = true;
    el.appendChild(section);
  }

  if (hasHiddenContent) {
    el.classList.add("expandable");
    el.addEventListener("click", (e) => {
      if (e.target.closest("a, button, select, textarea, .app-panel")) return;
      cardExpanded = !cardExpanded;
      el.classList.toggle("card-expanded", cardExpanded);
      for (const key of DETAIL_KEYS) {
        const section = sections[key];
        if (!section || detailSettings[key]) continue;
        section.hidden = !cardExpanded;
        if (key === "description" && cardExpanded) {
          // Revealed via the card-level override, not the global
          // "Description" setting - show it in full, no clamp/toggle.
          section.classList.add("expanded");
          const toggle = section.querySelector(".job-desc-toggle");
          if (toggle) toggle.hidden = true;
        }
      }
    });
  }

  if (isTracked && viewEl.value === "tracked") {
    const appData = applications.get(job.id);
    const panel = document.createElement("div");
    panel.className = "app-panel";

    // Status row: badge + select
    const statusRow = document.createElement("div");
    statusRow.className = "app-status-row";

    const badge = document.createElement("span");
    badge.className = `app-badge app-badge--${appData.status}`;
    badge.textContent = STATUS_LABELS[appData.status] || appData.status;
    statusRow.appendChild(badge);

    const statusSelect = document.createElement("select");
    statusSelect.className = "app-status-select";
    for (const s of VALID_STATUSES) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = STATUS_LABELS[s];
      if (s === appData.status) opt.selected = true;
      statusSelect.appendChild(opt);
    }
    statusSelect.addEventListener("change", () => {
      updateApplication(job.id, "status", statusSelect.value);
      badge.className = `app-badge app-badge--${statusSelect.value}`;
      badge.textContent = STATUS_LABELS[statusSelect.value];
    });
    statusRow.appendChild(statusSelect);
    panel.appendChild(statusRow);

    // Notes
    const notesLabel = document.createElement("label");
    notesLabel.className = "app-label";
    notesLabel.textContent = "Notes";
    panel.appendChild(notesLabel);

    const notesArea = document.createElement("textarea");
    notesArea.className = "app-textarea";
    notesArea.rows = 3;
    notesArea.value = appData.notes || "";
    notesArea.placeholder = "Add notes about this application…";
    notesArea.setAttribute("aria-label", "Notes");
    panel.appendChild(notesArea);
    attachTextField(notesArea, job.id, "notes", NOTES_TOOLBAR);

    // Motivation letter
    const letterLabel = document.createElement("label");
    letterLabel.className = "app-label";
    letterLabel.textContent = "Motivation letter";
    panel.appendChild(letterLabel);

    const letterArea = document.createElement("textarea");
    letterArea.className = "app-textarea app-textarea--letter";
    letterArea.rows = 8;
    letterArea.value = appData.motivationLetter || "";
    letterArea.placeholder = "Draft your motivation letter…";
    letterArea.setAttribute("aria-label", "Motivation letter");
    panel.appendChild(letterArea);
    attachTextField(letterArea, job.id, "motivationLetter", LETTER_TOOLBAR);

    // Tracked-since timestamp
    if (appData.createdAt) {
      const meta = document.createElement("p");
      meta.className = "app-meta";
      meta.textContent = `Tracked since ${new Date(appData.createdAt).toLocaleDateString()}`;
      panel.appendChild(meta);
    }

    el.appendChild(panel);
  }

  return el;
}

function renderViewOptions() {
  const likedCount = jobs.filter((j) => likedJobs.has(j.id) && !hiddenJobs.has(j.id)).length;
  const hiddenCount = jobs.filter((j) => hiddenJobs.has(j.id)).length;
  const trackedCount = jobs.filter((j) => applications.has(j.id)).length;
  const newCount = jobs.filter((j) => isNew(j) && !hiddenJobs.has(j.id)).length;
  const option = (value) => viewEl.querySelector(`option[value="${value}"]`);
  option("liked").textContent = `Liked (${likedCount})`;
  option("hidden").textContent = `Not relevant (${hiddenCount})`;
  option("tracked").textContent = `Tracked (${trackedCount})`;
  // Offered from the second day you visit: before that nothing can be new.
  option("new").textContent = `New since your last visit (${newCount})`;
  option("new").hidden = !visits.previous;
}

function updateDescriptionToggles() {
  // Batched on purpose: reading scrollHeight forces layout, so doing
  // it once after every card is in the DOM (rather than per-card as
  // each is built) avoids a reflow per job.
  const wraps = jobsEl.querySelectorAll(".job-desc-wrap:not([hidden]):not(.expanded)");
  for (const wrap of wraps) {
    const desc = wrap.querySelector(".job-desc");
    const toggle = wrap.querySelector(".job-desc-toggle");
    if (!desc || !toggle) continue;
    toggle.hidden = desc.scrollHeight <= desc.clientHeight + 1;
  }
}

// ── Table layout ─────────────────────────────────────────────────────────────
//
// The same filtered list as the cards, as a spreadsheet: one row per job, a
// column per field, sortable by clicking a header, and downloadable as CSV.
// (It replaced the public Airtable view, which the free plan's API quota
// couldn't keep in sync.) The layout choice is remembered per browser, and
// ?layout=table links straight to it.

const LAYOUT_KEY = "jobBoard.layout";
layoutEl.value =
  new URLSearchParams(location.search).get("layout") === "table" ||
  localStorage.getItem(LAYOUT_KEY) === "table"
    ? "table"
    : "cards";

/** Set by clicking a column header; the sort dropdown clears it. */
let tableSort = null; // { key, dir: 1 | -1 }

function textLink(href, text) {
  if (!href) return document.createTextNode(text);
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a;
}

function sheetButton(label, title, active, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sheet-btn" + (active ? " active" : "");
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * The table's columns. `value` is the plain text a column sorts and exports
 * by; `cell` (optional) builds what's shown instead of that text.
 */
// The columns the scrape derives from tags and salary text (see
// scrapers/tag_fields.py and scrapers/salary.py): ";"-separated values.
const TYPED_COLUMNS = [
  ["job_type", "Type", 100],
  ["experience", "Experience", 120],
  ["location", "Location", 140],
  ["cause_area", "Cause area", 170],
  ["skills", "Skills", 170],
  ["education", "Education", 150],
];
const EUROPE_VERDICTS = ["yes", "no", "unclear"];
const PERIOD_LABELS = {
  year: "per year", month: "per month", week: "per week", day: "per day",
  hour: "per hour", total: "one-off", unpaid: "unpaid",
};

function splitList(value) {
  return (value || "").split(";").map((v) => v.trim()).filter(Boolean);
}

// Grid column → the jobs.csv column a correction to it sets.
const CORRECTABLE = {
  title: "title",
  organization: "organization_name",
  posted: "publication_date",
  closes: "close_date",
  europe: "europe",
  ...Object.fromEntries(TYPED_COLUMNS.map(([name]) => [name, name])),
  salary: "salary_range",
  salary_min: "salary_min",
  salary_max: "salary_max",
  salary_currency: "salary_currency",
  salary_period: "salary_period",
  other_tags: "other_tags",
  description: "description",
};

const periodLabel = (job) => PERIOD_LABELS[job.salary_period] || job.salary_period || "";
const formatPay = (value) => (value === "" || value == null ? "" : Number(value).toLocaleString("en-US"));

function sheetColumns() {
  const columns = [
    {
      key: "liked", label: "★", className: "col-actions", export: false,
      value: (j) => (likedJobs.has(j.id) ? "1" : ""),
      cell: (j) => {
        const wrap = document.createElement("span");
        wrap.append(
          sheetButton(likedJobs.has(j.id) ? "★" : "☆", likedJobs.has(j.id) ? "Remove from liked" : "Mark as liked",
            likedJobs.has(j.id), () => toggleLiked(j.id)),
          sheetButton(hiddenJobs.has(j.id) ? "↺" : "✕", hiddenJobs.has(j.id) ? "Restore to list" : "Hide as not relevant",
            false, () => toggleHidden(j.id)),
        );
        return wrap;
      },
    },
    { key: "title", label: "Title", className: "col-title", value: (j) => j.title || "", cell: (j) => textLink(j.link, j.title || "Untitled role") },
    { key: "organization_name", label: "Organization", value: (j) => j.organization_name || "", cell: (j) => textLink(j.organization_url, j.organization_name || "") },
    { key: "source", label: "Board", value: (j) => splitSources(j).join(", ") },
    { key: "publication_date", label: "Posted", className: "col-date", value: (j) => j.publication_date || "" },
    { key: "close_date", label: "Closes", className: "col-date", value: (j) => j.close_date || "" },
    { key: "europe", label: "Europe", value: (j) => j.europe || "" },
    ...TYPED_COLUMNS.map(([key, label]) => ({ key, label, className: "col-tags", value: (j) => splitList(j[key]).join(", ") })),
    { key: "salary_range", label: "Salary", value: (j) => j.salary_range || "" },
    { key: "salary_min", label: "Min", className: "col-date", value: (j) => j.salary_min || "" },
    { key: "salary_max", label: "Max", className: "col-date", value: (j) => j.salary_max || "" },
    { key: "salary_currency", label: "Currency", value: (j) => j.salary_currency || "" },
    { key: "salary_period", label: "Period", value: periodLabel },
    { key: "other_tags", label: "Other tags", className: "col-tags", value: (j) => splitList(j.other_tags).join(", ") },
    { key: "description", label: "Description", className: "col-long", value: (j) => j.description || "" },
  ];
  if (isLoggedIn() || applications.size) {
    columns.splice(2, 0, {
      key: "status", label: "Status",
      value: (j) => STATUS_LABELS[applications.get(j.id)?.status] || "",
    });
  }
  if (fitScores.size) {
    columns.splice(2, 0, {
      key: "fit", label: "Fit", className: "col-date",
      value: (j) => String(fitScores.get(j.id)?.score ?? ""),
    });
  }
  return columns;
}

function sortRows(list, columns) {
  if (!tableSort) return list;
  const column = columns.find((c) => c.key === tableSort.key);
  if (!column) return list;
  // Empty cells sort last either way, as in a spreadsheet.
  return [...list].sort((a, b) => {
    const x = column.value(a);
    const y = column.value(b);
    if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1);
    return x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" }) * tableSort.dir;
  });
}

function renderTable(list) {
  const columns = sheetColumns();
  const rows = sortRows(list, columns);

  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const column of columns) {
    const th = document.createElement("th");
    th.className = column.className || "";
    th.scope = "col";
    const sorted = tableSort?.key === column.key;
    th.setAttribute("aria-sort", sorted ? (tableSort.dir === 1 ? "ascending" : "descending") : "none");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = column.label + (sorted ? (tableSort.dir === 1 ? " ▲" : " ▼") : "");
    btn.title = `Sort by ${column.key === "liked" ? "liked" : column.label.toLowerCase()}`;
    btn.addEventListener("click", () => {
      tableSort = sorted ? { key: column.key, dir: -tableSort.dir } : { key: column.key, dir: 1 };
      render();
    });
    th.appendChild(btn);
    head.appendChild(th);
  }

  const body = table.createTBody();
  for (const job of rows) {
    const tr = body.insertRow();
    tr.className = (likedJobs.has(job.id) ? "is-liked" : "") + (hiddenJobs.has(job.id) ? " is-hidden" : "");
    for (const column of columns) {
      const td = tr.insertCell();
      td.className = column.className || "";
      if (column.cell) td.appendChild(column.cell(job));
      else td.textContent = column.value(job);
    }
    // Clicking a row (not a link or button in it) shows its long cells in full.
    tr.addEventListener("click", (e) => {
      if (e.target.closest("a, button")) return;
      tr.classList.toggle("expanded");
    });
  }

  sheetEl.classList.remove("sheet--grid");
  sheetEl.replaceChildren(table);
  return rows;
}

// ── Spreadsheet grid (Jspreadsheet) ─────────────────────────────────────────
//
// The table layout upgrades to an editable grid once /sheet.js (Jspreadsheet
// CE, served by server.ts) has loaded: Excel-style selection, copy/paste,
// fill and keyboard editing, column sorting and filters. Only the columns
// that are ours are editable: liked, not relevant and, when logged in, the
// application's status and notes. Everything the scraper fills in is
// read-only, since the next scrape would overwrite it. Edits go through the
// same state and saves as the cards. Until the library arrives, or if it
// can't, renderTable's read-only table is what shows.

let sheetLib = null;
function loadSheetLib() {
  sheetLib ??= new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/sheet.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "/sheet.js";
    script.onload = () => (window.jspreadsheet ? resolve(window.jspreadsheet) : reject(new Error("jspreadsheet missing")));
    script.onerror = () => reject(new Error("could not load /sheet.js"));
    document.head.appendChild(script);
  }).catch((err) => {
    console.warn("Spreadsheet unavailable, showing the read-only table:", err);
    return null;
  });
  return sheetLib;
}

/** The grid's worksheet while one is shown, else null. */
let grid = null;
let gridEl = null;
let sheetRenders = 0;

function destroyGrid() {
  if (gridEl && window.jspreadsheet) window.jspreadsheet.destroy(gridEl);
  grid = null;
  gridEl = null;
}

function renderSheet(list) {
  const render = ++sheetRenders;
  if (window.jspreadsheet) return buildGrid(window.jspreadsheet, list);
  destroyGrid();
  shownRows = renderTable(list);
  loadSheetLib().then((lib) => {
    // A newer render (or a switch to cards) superseded this one meanwhile.
    if (lib && render === sheetRenders && layoutEl.value === "table") buildGrid(lib, list);
  });
}

const BOOL = (value) => value === true || value === "true" || value === 1 || value === "1";

// ── Grid column filters ──────────────────────────────────────────────────────
//
// The grid's filter row, but filtering done here rather than by Jspreadsheet,
// whose CE filter keeps one column at a time and offers whole cell values:
// "80,000 Hours, Probably Good" rather than each board. Here a column filter
// is a set of single values (one board, one tag), a job passes when any of
// its values is picked (OR), and filters on different columns combine (AND).
// They're applied in render() with the page's other filters, so the count,
// the CSV export and the grid itself all agree. Table layout only.

/** Column name → picked values. "" stands for a blank cell. */
const gridFilters = new Map();
const FILTERABLE = new Set([
  "liked", "hidden", "title", "status", "organization", "board", "posted", "closes", "europe",
  ...TYPED_COLUMNS.map(([name]) => name), "salary", "salary_currency", "salary_period", "other_tags",
]);
const yesNo = (on) => (on ? "Yes" : "No");
const orBlank = (values) => (values.length ? values : [""]);

/** A job's values in a filterable column. */
function filterValues(job, name) {
  switch (name) {
    case "liked": return [yesNo(likedJobs.has(job.id))];
    case "hidden": return [yesNo(hiddenJobs.has(job.id))];
    case "title": return [job.title || ""];
    case "status": return [STATUS_LABELS[applications.get(job.id)?.status] || ""];
    case "organization": return [job.organization_name || ""];
    case "board": return orBlank(splitSources(job));
    case "posted": return [job.publication_date || ""];
    case "closes": return [job.close_date || ""];
    case "europe": return [job.europe || ""];
    case "salary": return [job.salary_range || ""];
    case "salary_currency": return [job.salary_currency || ""];
    case "salary_period": return [periodLabel(job)];
    case "other_tags": return orBlank(splitList(job.other_tags));
    default:
      return TYPED_COLUMNS.some(([typed]) => typed === name) ? orBlank(splitList(job[name])) : [];
  }
}

function matchesGridFilters(job, except) {
  for (const [name, picked] of gridFilters) {
    if (name !== except && !filterValues(job, name).some((v) => picked.has(v))) return false;
  }
  return true;
}

/** The jobs the page's other filters keep: what a column's options are counted from. */
let gridBase = [];

/** Open a column's filter: its values among the jobs the other filters keep, with counts. */
function openGridFilter(td, name) {
  const counts = new Map();
  for (const job of gridBase) {
    if (!matchesGridFilters(job, name)) continue;
    for (const v of new Set(filterValues(job, name))) counts.set(v, (counts.get(v) || 0) + 1);
  }
  // A picked value nothing has any more stays listed, so it can be unpicked.
  for (const v of gridFilters.get(name) || []) if (!counts.has(v)) counts.set(v, 0);
  const data = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, n]) => ({ id: value, name: `${value || "(Blank)"} (${n})` }));

  const holder = document.createElement("div");
  td.replaceChildren(holder);
  td.classList.add("filter-open");
  window.jSuites.dropdown(holder, {
    data,
    multiple: true,
    autocomplete: true,
    opened: true,
    width: "100%",
    position: true,
    value: [...(gridFilters.get(name) || [])],
    onclose(el) {
      const picked = (el.dropdown.getValue(true) || []).map(String);
      if (picked.length) gridFilters.set(name, new Set(picked));
      else gridFilters.delete(name);
      render();
    },
  });
}

/** Label the grid's filter row with what's picked, and take its clicks over from Jspreadsheet. */
function wireGridFilters(columns) {
  const row = grid?.filter;
  if (!row) return;
  for (const td of row.querySelectorAll("td.jss_column_filter")) {
    const name = columns[Number(td.dataset.x)]?.name;
    const picked = gridFilters.get(name);
    if (picked) {
      td.textContent = [...picked].map((v) => v || "(Blank)").join(", ");
      td.title = td.textContent;
      td.classList.add("filter-active");
    }
    if (!FILTERABLE.has(name)) td.classList.add("filter-none");
  }
  // Capture phase, so Jspreadsheet's own (document-level) filter never opens.
  row.addEventListener("mousedown", (e) => {
    if (e.target.closest(".jdropdown")) return; // a click inside an open filter
    const td = e.target.closest("td.jss_column_filter");
    if (!td) return;
    e.stopPropagation();
    e.preventDefault();
    const name = columns[Number(td.dataset.x)]?.name;
    if (FILTERABLE.has(name)) openGridFilter(td, name);
  }, true);
}

let prefsTimer = null;
/** A paste can flip hundreds of checkboxes: send the preferences once. */
function savePreferencesSoon() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(savePreferences, 400);
}

function buildGrid(lib, list) {
  destroyGrid();
  sheetEl.classList.add("sheet--grid");
  const byId = new Map(list.map((job) => [job.id, job]));
  const loggedIn = isLoggedIn();
  const admin = isAdmin;
  const linkCell = (field, textField) => (cell, value, x, y, instance) => {
    const job = byId.get(instance.getValueFromCoords(0, y));
    const href = job?.[field];
    if (!href) return;
    cell.textContent = "";
    cell.appendChild(textLink(href, String(value ?? "")));
  };
  // Long cells stay one line high; hovering shows the whole text.
  const fullTextTitle = (cell, value) => {
    cell.title = String(value ?? "");
  };
  const payCell = (cell, value) => {
    cell.textContent = formatPay(value);
  };
  const europeCell = (cell, value, x, y, instance) => {
    const job = byId.get(instance.getValueFromCoords(0, y));
    if (job?.europe_reason) cell.title = job.europe_reason;
  };
  // The score in its band's colours, the reason on hover.
  const fitCell = (cell, value, x, y, instance) => {
    cell.classList.remove("fit-high", "fit-mid", "fit-low");
    cell.removeAttribute("title");
    if (value === "" || value == null) return;
    cell.classList.add("fit-cell", `fit-${fitBand(Number(value))}`);
    const fit = fitScores.get(instance.getValueFromCoords(0, y));
    if (fit) cell.title = fit.reason;
  };
  // A hand-corrected cell gets a corner mark (for admins, right-click undoes it).
  const markCorrected = (render) => (cell, value, x, y, instance) => {
    cell.removeAttribute("title");
    render?.(cell, value, x, y, instance);
    const job = byId.get(instance.getValueFromCoords(0, y));
    const corrected = Boolean(job && splitList(job.corrected).includes(CORRECTABLE[columns[x].name]));
    cell.classList.toggle("cell--corrected", corrected);
    if (corrected) {
      const note = admin ? "Corrected by hand (right-click to undo)" : "Corrected by hand";
      cell.title = cell.title ? `${cell.title}\n\n${note}` : note;
    }
  };
  // Every value a column has, for the admins' dropdowns.
  const valuesOf = (name) => [...new Set(jobs.flatMap((job) => splitList(job[name])))]
    .sort((a, b) => a.localeCompare(b));

  const columns = [
    { name: "id", type: "hidden" },
    { name: "liked", title: "★", type: "checkbox", width: 36 },
    { name: "hidden", title: "✕", type: "checkbox", width: 36 },
    { name: "title", title: "Title", readOnly: true, width: 280, render: linkCell("link") },
    ...(fitScores.size ? [{ name: "fit", title: "Fit", readOnly: true, width: 56, align: "right", render: fitCell }] : []),
    ...(loggedIn ? [
      {
        name: "status", title: "Status", type: "dropdown", width: 120,
        source: [{ id: "", name: "" }, ...VALID_STATUSES.map((s) => ({ id: s, name: STATUS_LABELS[s] }))],
      },
      { name: "notes", title: "Notes", width: 220 },
    ] : []),
    { name: "organization", title: "Organization", readOnly: true, width: 180, render: linkCell("organization_url") },
    { name: "board", title: "Board", readOnly: true, width: 150 },
    { name: "posted", title: "Posted", readOnly: true, width: 92 },
    { name: "closes", title: "Closes", readOnly: true, width: 92 },
    // yes / no / unclear, the reason on hover; admins correct it from a dropdown.
    {
      name: "europe", title: "Europe", width: 84, render: europeCell,
      ...(admin ? { type: "dropdown", source: ["", ...EUROPE_VERDICTS] } : { readOnly: true }),
    },
    ...TYPED_COLUMNS.map(([name, title, width]) => (admin
      ? { name, title, width, type: "dropdown", multiple: true, autocomplete: true, source: valuesOf(name) }
      : { name, title, readOnly: true, width, render: fullTextTitle })),
    { name: "salary", title: "Salary", readOnly: true, width: 150, render: fullTextTitle },
    // Shown with thousands separators; sorting() below reads them as numbers.
    // (Not type "numeric": Jspreadsheet sorts those as Number(value), which
    // turns a blank into 0.)
    { name: "salary_min", title: "Min", readOnly: true, width: 90, align: "right", render: payCell },
    { name: "salary_max", title: "Max", readOnly: true, width: 90, align: "right", render: payCell },
    { name: "salary_currency", title: "Currency", readOnly: true, width: 76 },
    {
      name: "salary_period", title: "Period", readOnly: true, width: 86, type: "dropdown",
      source: [{ id: "", name: "" }, ...Object.entries(PERIOD_LABELS).map(([id, name]) => ({ id, name }))],
    },
    { name: "other_tags", title: "Other tags", readOnly: true, width: 170, render: fullTextTitle },
    { name: "description", title: "Description", readOnly: true, width: 360, render: fullTextTitle },
  ];
  for (const column of columns) {
    column.align ??= column.type === "checkbox" ? "center" : "left";
    if (CORRECTABLE[column.name]) {
      column.readOnly = !admin;
      column.render = markCorrected(column.render);
    }
  }
  const col = Object.fromEntries(columns.map((c, i) => [c.name, i]));

  const rowOf = (job) => {
    const app = applications.get(job.id);
    const row = {
      id: job.id,
      liked: likedJobs.has(job.id),
      hidden: hiddenJobs.has(job.id),
      title: job.title || "Untitled role",
      fit: fitScores.get(job.id)?.score ?? "",
      status: app?.status || "",
      notes: app?.notes || "",
      organization: job.organization_name || "",
      board: splitSources(job).join(", "),
      posted: job.publication_date || "",
      closes: job.close_date || "",
      europe: job.europe || "",
      salary: job.salary_range || "",
      salary_min: job.salary_min === "" || job.salary_min == null ? "" : Number(job.salary_min),
      salary_max: job.salary_max === "" || job.salary_max == null ? "" : Number(job.salary_max),
      salary_currency: job.salary_currency || "",
      salary_period: job.salary_period || "",
      // Admins edit these as text, where ", " would be ambiguous ("Washington, DC").
      other_tags: splitList(job.other_tags).join(admin ? "; " : ", "),
      description: job.description || "",
    };
    // A multiple dropdown's value is its picks joined by ";".
    for (const [name] of TYPED_COLUMNS) row[name] = splitList(job[name]).join(admin ? ";" : ", ");
    return columns.map((c) => row[c.name]);
  };
  const data = list.map(rowOf);

  // Set while the grid itself writes a cell, so onchange doesn't treat it as an edit.
  let writing = false;

  // Show a job's row as it now is: after a correction the server re-derives
  // the salary numbers and typed columns too.
  const refreshRow = (instance, id) => {
    const job = byId.get(id);
    const rows = instance.options.data.length;
    let y = 0;
    while (y < rows && instance.getValueFromCoords(0, y) !== id) y++;
    if (!job || y === rows) return;
    const values = rowOf(job);
    writing = true;
    try {
      columns.forEach((c, x) => {
        if (CORRECTABLE[c.name]) instance.setValueFromCoords(x, y, values[x], true);
      });
    } finally {
      writing = false;
    }
  };
  const correct = async (instance, id, patch) => {
    try {
      Object.assign(byId.get(id), await saveCorrection(id, patch));
    } catch (err) {
      alert(`The correction wasn't saved: ${err.message}`);
    }
    refreshRow(instance, id);
  };
  // Jobs added by link aren't scraped, so there's nothing to correct: they're
  // edited by removing and adding them again.
  const isCustom = (id) => byId.get(id)?.source === "custom";

  gridEl = document.createElement("div");
  sheetEl.replaceChildren(gridEl);
  const wide = window.innerWidth > 600;
  [grid] = lib(gridEl, {
    worksheets: [{
      data,
      columns,
      tableOverflow: true,
      tableWidth: `${sheetEl.clientWidth}px`,
      tableHeight: `${Math.max(320, window.innerHeight - 40)}px`,
      // id, ★, ✕ and Title stay in view while scrolling sideways.
      freezeColumns: wide ? 4 : 0,
      columnSorting: true,
      filters: true,
      allowInsertRow: false,
      allowManualInsertRow: false,
      allowInsertColumn: false,
      allowManualInsertColumn: false,
      allowDeleteRow: false,
      allowDeleteColumn: false,
      allowRenameColumn: false,
      columnDrag: false,
      rowDrag: false,
      allowComments: false,
    }],
    // Never evaluate a cell as a formula: a title could start with "=".
    parseFormulas: false,
    // Blank cells last whichever way a column is sorted, numbers (including
    // "120,000" as displayed) by value, other text in natural order.
    sorting(order) {
      const asNumber = (v) => {
        if (typeof v === "number") return v;
        const plain = String(v).replace(/,/g, "");
        return /^-?\d+(\.\d+)?$/.test(plain) ? Number(plain) : null;
      };
      return ([, a], [, b]) => {
        const blankA = a === "" || a == null;
        const blankB = b === "" || b == null;
        if (blankA || blankB) return blankA - blankB;
        const x = asNumber(a);
        const y = asNumber(b);
        const cmp = x !== null && y !== null
          ? x - y
          : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
        return order ? -cmp : cmp;
      };
    },
    about: false,
    allowExport: false,
    onbeforechange(instance, cell, x, y, value) {
      if (writing) return undefined;
      if (CORRECTABLE[columns[x].name] && isCustom(instance.getValueFromCoords(0, y))) {
        return instance.getValueFromCoords(x, y);
      }
      if (Number(x) !== col.status || value) return undefined;
      // Clearing the status untracks the job, which would throw away its
      // notes and letter; that's done from the card, where they're visible.
      const app = applications.get(instance.getValueFromCoords(0, y));
      if (app && (app.notes || app.motivationLetter)) {
        setTimeout(() => alert("This application has notes or a letter. Untrack it from its card in the Tracked view."));
        return instance.getValueFromCoords(x, y);
      }
      return undefined;
    },
    onchange(instance, cell, x, y, value) {
      if (writing) return;
      const id = instance.getValueFromCoords(0, y);
      switch (Number(x)) {
        case col.liked:
        case col.hidden: {
          const set = Number(x) === col.liked ? likedJobs : hiddenJobs;
          if (BOOL(value)) set.add(id);
          else set.delete(id);
          saveIdSet(Number(x) === col.liked ? LIKED_KEY : HIDDEN_KEY, set);
          savePreferencesSoon();
          break;
        }
        case col.status: {
          const app = applications.get(id);
          if (!value) {
            if (app) deleteApplication(id);
          } else if (app) {
            updateApplication(id, "status", value);
          } else {
            const now = new Date().toISOString();
            saveApplication(id, { status: value, notes: "", motivationLetter: "", createdAt: now, updatedAt: now });
          }
          break;
        }
        case col.notes: {
          const text = String(value ?? "");
          if (applications.has(id)) {
            updateApplication(id, "notes", text);
          } else if (text) {
            // Notes on an untracked job start tracking it, as on a card.
            const now = new Date().toISOString();
            saveApplication(id, { status: "interested", notes: text, motivationLetter: "", createdAt: now, updatedAt: now });
            writing = true;
            instance.setValueFromCoords(col.status, y, "interested");
            writing = false;
          }
          break;
        }
        default: {
          const field = CORRECTABLE[columns[x].name];
          if (field && admin && !isCustom(id)) correct(instance, id, { [field]: String(value ?? "") });
          return;
        }
      }
      renderViewOptions();
    },
    contextMenu(instance, x, y, e, items) {
      const field = x == null ? undefined : CORRECTABLE[columns[x]?.name];
      const id = y == null ? null : instance.getValueFromCoords(0, y);
      const job = byId.get(id);
      if (admin && field && job && splitList(job.corrected).includes(field)) {
        items.unshift(
          { title: "Undo hand correction", onclick: () => correct(instance, id, { [field]: null }) },
          { type: "line" },
        );
      }
      return items;
    },
  });
  wireGridFilters(columns);
}

/** The rows on screen, in the order shown, as a CSV file. */
let shownRows = [];

function csvField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function downloadCsv() {
  const columns = sheetColumns().filter((c) => c.export !== false);
  const header = ["Liked", "Not relevant", ...columns.map((c) => c.label), "Link", "Organization URL"];
  const lines = [header.map(csvField).join(",")];
  // The grid may have been re-sorted in place: export in its order. (Its
  // column filters are already applied: shownRows is what passed them.)
  const byId = new Map(shownRows.map((job) => [job.id, job]));
  const rows = grid ? grid.getData().map((row) => byId.get(row[0])).filter(Boolean) : shownRows;
  for (const job of rows) {
    lines.push([
      likedJobs.has(job.id) ? "yes" : "",
      hiddenJobs.has(job.id) ? "yes" : "",
      ...columns.map((c) => c.value(job)),
      job.link || "",
      job.organization_url || "",
    ].map(csvField).join(","));
  }
  // A BOM so Excel reads the file as UTF-8.
  const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hireme-jobs-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function render() {
  const term = searchEl.value.trim().toLowerCase();
  const table = layoutEl.value === "table";
  const unfiltered = jobs.filter(
    (j) =>
      matchesSearch(j, term) &&
      matchesActiveTags(j) &&
      matchesActiveSources(j) &&
      matchesView(j, viewEl.value)
  );
  const base = unfiltered.filter(matchesEurope);
  const notEurope = unfiltered.filter((j) => j.europe === "no").length;
  europeToggleEl.hidden = !notEurope || !europeFilterApplies();
  europeToggleEl.setAttribute("aria-pressed", String(includeNotEurope));
  europeToggleEl.textContent = `${includeNotEurope ? "Hide" : "Show"} ${notEurope} not open to Europe`;
  gridBase = table ? base : [];
  const filtered = table && gridFilters.size ? base.filter((j) => matchesGridFilters(j)) : base;
  const sorted = sortJobs(filtered, sortEl.value);

  renderSourceFilters();
  renderActiveTags();
  renderViewOptions();
  countEl.textContent = `${sorted.length} job${sorted.length === 1 ? "" : "s"}`;
  // The cards are rebuilt from scratch: save what's being typed first.
  closeLiveFields();
  jobsEl.innerHTML = "";
  emptyEl.hidden = sorted.length > 0;

  document.body.classList.toggle("layout-table", table);
  jobsEl.hidden = table;
  sheetEl.hidden = !table || !sorted.length;
  detailTogglesEl.hidden = table;
  downloadCsvEl.hidden = !table || !sorted.length;
  // Shown even when the filters leave no rows (and so no grid to undo them in).
  clearGridFiltersEl.hidden = !table || !gridFilters.size;
  clearGridFiltersEl.textContent = `Clear column filters (${gridFilters.size})`;
  if (table) {
    shownRows = sorted;
    if (sorted.length) renderSheet(sorted);
    else destroyGrid();
    return;
  }
  destroyGrid();
  sheetEl.replaceChildren();
  // Sorted by fit, poor matches fold away below the rest ("For you").
  const fold = sortEl.value === "fit_desc";
  const low = fold ? sorted.filter(isLowFit) : [];
  for (const job of fold ? sorted.filter((j) => !isLowFit(j)) : sorted) {
    jobsEl.appendChild(jobCard(job));
  }
  if (low.length) {
    const shown = sorted.length - low.length;
    countEl.textContent = `${shown} job${shown === 1 ? "" : "s"} + ${low.length} probably not`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "low-fit-toggle";
    toggle.setAttribute("aria-expanded", String(showLowFit));
    toggle.textContent = `${showLowFit ? "▾" : "▸"} Probably not for you (${low.length}): scored below ${LOW_FIT}`;
    toggle.addEventListener("click", () => {
      showLowFit = !showLowFit;
      render();
    });
    jobsEl.appendChild(toggle);
    if (showLowFit) for (const job of low) jobsEl.appendChild(jobCard(job));
  }
  requestAnimationFrame(updateDescriptionToggles);
}

async function init() {
  updateAuthUI();
  countEl.textContent = "Loading…";
  const res = await fetch("/api/jobs");
  jobs = await res.json();
  render();
  loadPreferences();
  loadApplications();
  loadFit();
  loadCustomJobs();
  loadAdmin();
}

searchEl.addEventListener("input", render);
sortEl.addEventListener("change", () => {
  tableSort = null;
  sortChosen = true;
  render();
});
viewEl.addEventListener("change", render);
europeToggleEl.addEventListener("click", () => {
  includeNotEurope = !includeNotEurope;
  try {
    localStorage.setItem(EUROPE_KEY, includeNotEurope ? "1" : "0");
  } catch {}
  render();
});
layoutEl.addEventListener("change", () => {
  localStorage.setItem(LAYOUT_KEY, layoutEl.value);
  // Keep a ?layout=table link pointing at the layout actually shown.
  const url = new URL(location.href);
  if (layoutEl.value === "table") url.searchParams.set("layout", "table");
  else url.searchParams.delete("layout");
  history.replaceState(null, "", url);
  render();
});
downloadCsvEl.addEventListener("click", downloadCsv);
clearGridFiltersEl.addEventListener("click", () => {
  gridFilters.clear();
  render();
});

init();
