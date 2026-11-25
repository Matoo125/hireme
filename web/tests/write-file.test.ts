import { test, expect } from "bun:test";
import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { writeFileAtomic } from "../lib/write-file";

test("writes the data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "write-file-"));
  const file = path.join(dir, "a.json");
  await writeFileAtomic(file, '{"a":1}');
  expect(await Bun.file(file).json()).toEqual({ a: 1 });
  await writeFileAtomic(file, new Uint8Array([1, 2, 3]));
  expect(new Uint8Array(await Bun.file(file).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  expect(await readdir(dir)).toEqual(["a.json"]);
  await rm(dir, { recursive: true });
});

test("a reader in another process never sees a partial file", async () => {
  // In one process Bun finishes each write before a read runs, so the race
  // (seen as a 500 from GET /api/preferences mid-PUT) needs a second reader.
  const dir = await mkdtemp(path.join(tmpdir(), "write-file-"));
  const file = path.join(dir, "prefs.json");
  const big = (n: number) => JSON.stringify({ n, liked: Array.from({ length: 200000 }, (_, i) => `job-${i}`) });
  await writeFileAtomic(file, big(0));
  const readerSrc = `const f = ${JSON.stringify(file)}; let bad = 0; const end = Date.now() + 1000;
    while (Date.now() < end) { try { JSON.parse(require("fs").readFileSync(f, "utf8")); } catch { bad++; } }
    console.log(bad);`;
  const reader = Bun.spawn(["bun", "-e", readerSrc], { stdout: "pipe" });
  const end = Date.now() + 1000;
  for (let i = 1; Date.now() < end; i++) await writeFileAtomic(file, big(i));
  expect((await new Response(reader.stdout).text()).trim()).toBe("0");
  expect(await readdir(dir)).toEqual(["prefs.json"]);
  await rm(dir, { recursive: true });
}, 10000);
