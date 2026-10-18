// Browser tests for the web app: bun tests/browser/run.ts [name ...]
//
// Starts the server on fixture data (fixture/scraped.json, built into a
// jobs.csv in a temp dir by `python3 -m scrapers.overrides rebuild`), a
// stand-in for altfresh's auth (a JWKS, and tokens for an admin and a plain
// user), and headless Chromium. Each *.js file here is one test: the body of
// an async function run in the page once the table layout is up, with these
// in scope:
//
//   check(name, ok, detail)   record a PASS/FAIL line
//   wait(ms)
//   signIn("admin" | "user")  log in as that account (and load the admin flag)
//   TOKENS                    { admin, user } JWTs, for direct API calls
//   cx(name)                  the grid's column index for a column name
//   rowOf(id)                 the grid's row index for a job id (-1 if not shown)
//   openFilter(name)          open a column's filter; returns its jSuites dropdown
//   filterOptions()           the open filter's options, as shown ("Remote (12)")
//   exportCsv()               click "Download CSV" and return the file's text
//
// A first-line comment `// @block <url part>` makes the page fail to load
// matching URLs (e.g. /sheet.js). The data is rebuilt before every test, so
// tests can make corrections without affecting each other. Exits non-zero if
// any check fails. CHROMIUM picks the browser binary (default: chromium).

import { mkdtemp, readdir, rm, copyFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const HERE = import.meta.dir;
const WEB = path.join(HERE, "..", "..");
const REPO = path.join(WEB, "..");

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  server.stop(true);
  return port;
}

const only = process.argv.slice(2);
const tests = (await readdir(HERE))
  .filter((f) => f.endsWith(".js"))
  .map((f) => f.slice(0, -3))
  .filter((name) => !only.length || only.includes(name))
  .sort();
if (!tests.length) {
  console.error(`No tests match ${only.join(", ")}`);
  process.exit(2);
}

// ── Data ─────────────────────────────────────────────────────────────────────

const dir = await mkdtemp(path.join(tmpdir(), "hireme-browser-"));
const files = {
  scraped: path.join(dir, "scraped.json"),
  overrides: path.join(dir, "overrides.toml"),
  jobs: path.join(dir, "jobs.csv"),
};
await copyFile(path.join(HERE, "fixture", "scraped.json"), files.scraped);

async function resetData() {
  await Bun.write(files.overrides, "# Browser tests.\n");
  const proc = Bun.spawn(
    ["python3", "-m", "scrapers.overrides", "rebuild",
      "--scraped", files.scraped, "--overrides", files.overrides, "--jobs", files.jobs],
    { cwd: REPO, stdout: "ignore", stderr: "pipe" }
  );
  if ((await proc.exited) !== 0) throw new Error(`rebuild failed: ${await new Response(proc.stderr).text()}`);
}

// ── Auth stand-in ────────────────────────────────────────────────────────────

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "ES256" };
const auth = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ keys: [jwk] }) });
const issuer = `http://127.0.0.1:${auth.port}`;
const sign = (sub: string) =>
  new SignJWT({ username: `user${sub}` })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setIssuer(issuer).setSubject(sub).setExpirationTime("1h")
    .sign(privateKey);
const TOKENS = { admin: await sign("2"), user: await sign("7") };

// ── Server ───────────────────────────────────────────────────────────────────

await resetData();
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: WEB,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    JOBS_CSV: files.jobs,
    OVERRIDES_PATH: files.overrides,
    SCRAPED_JSON: files.scraped,
    ADMIN_USER_IDS: "2",
    OVERRIDES_COMMIT: "0",
    AUTH_ISSUER: issuer,
  },
  stdout: "ignore",
  stderr: "inherit",
});

// ── Browser ──────────────────────────────────────────────────────────────────

const cdpPort = await freePort();
const browser = Bun.spawn(
  [process.env.CHROMIUM ?? "chromium", "--headless", "--no-sandbox", "--disable-gpu",
    "--window-size=1400,900", `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${path.join(dir, "chromium")}`, "about:blank"],
  { stdout: "ignore", stderr: "ignore" }
);

async function cleanup() {
  browser.kill();
  server.kill();
  auth.stop(true);
  await rm(dir, { recursive: true, force: true });
}

async function poll<T>(what: string, fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

let failed = 0;
try {
  await poll("server", async () => (await fetch(`${base}/api/jobs`)).ok);
  const target = await poll("browser", async () =>
    ((await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as any[]).find((t) => t.type === "page"));

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let nextId = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const send = (method: string, params = {}) =>
    new Promise<any>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression: string) => {
    const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const { exception, text } = result.exceptionDetails;
      throw new Error(exception?.description ?? text);
    }
    return result.result.value;
  };

  await send("Page.enable");
  await send("Network.enable");

  const prelude = `
    const out = [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const check = (name, ok, detail = "") => out.push([Boolean(ok), name, String(detail ?? "")]);
    const TOKENS = ${JSON.stringify(TOKENS)};
    const cx = (name) => grid.options.columns.findIndex((c) => c.name === name);
    const rowOf = (id) => {
      for (let y = 0; y < grid.options.data.length; y++) if (grid.getValueFromCoords(0, y) === id) return y;
      return -1;
    };
    const openFilter = async (name) => {
      const td = [...grid.filter.querySelectorAll("td.jss_column_filter")].find((t) => t.dataset.x === String(cx(name)));
      td.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      await wait(150);
      return [...document.querySelectorAll(".jdropdown")].map((e) => e.dropdown).find(Boolean);
    };
    const filterOptions = () => [...document.querySelectorAll(".jdropdown-item")].map((i) => i.textContent.trim());
    const exportCsv = async () => {
      let csv = null;
      URL.createObjectURL = (blob) => { blob.text().then((t) => (csv = t)); return "blob:test"; };
      HTMLAnchorElement.prototype.click = function () {};
      document.getElementById("downloadCsv").click();
      for (let i = 0; i < 50 && csv === null; i++) await wait(20);
      return csv.replace(/^\uFEFF/, "");
    };
    const signIn = async (who) => {
      localStorage.setItem("hireme.token", "test");
      cachedJwt = TOKENS[who];
      jwtExpiresAt = Date.now() + 3600e3;
      await loadAdmin();
      render();
      await wait(300);
    };`;

  for (const name of tests) {
    const source = await Bun.file(path.join(HERE, `${name}.js`)).text();
    const blocked = [...source.matchAll(/^\/\/ @block (\S+)/gm)].map((m) => `*${m[1]}*`);
    await resetData();
    await send("Network.setBlockedURLs", { urls: blocked });
    // A fresh origin state: no likes, tokens or layout left from the last test.
    await send("Page.navigate", { url: `${base}/` });
    await poll("page", () => evaluate("document.readyState === 'complete'"));
    await evaluate("localStorage.clear()");
    await send("Page.navigate", { url: `${base}/?layout=table` });
    let results: [boolean, string, string][];
    try {
      await poll("the table", () => evaluate(
        "Boolean(grid || document.querySelector('#sheet tbody tr'))"));
      // The grid's library loads after the plain table, unless it's blocked.
      if (!blocked.length) await poll("the grid", () => evaluate("Boolean(grid)"));
      results = await evaluate(`(async () => { ${prelude}\n await (async () => {\n${source}\n})(); return out; })()`);
    } catch (err) {
      results = [[false, "test ran to the end", String(err)]];
    }
    const bad = results.filter(([ok]) => !ok);
    failed += bad.length;
    console.log(`${bad.length ? "FAIL" : "ok  "} ${name} (${results.length - bad.length}/${results.length})`);
    for (const [, check, detail] of bad) console.log(`       ✗ ${check}${detail ? `: ${detail}` : ""}`);
  }
  ws.close();
} catch (err) {
  console.error(err);
  failed = failed || 1;
} finally {
  await cleanup();
}
process.exit(failed ? 1 : 0);
