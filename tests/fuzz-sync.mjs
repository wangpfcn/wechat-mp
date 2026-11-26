#!/usr/bin/env node
// Randomised check of the article-list scan: node tests/fuzz-sync.mjs [first seed] [number of seeds]
// Not part of `npm test` (it is slow and its worlds are random); run it after touching syncAccount.
//
// Each seed builds a made-up account: pushes of 1 to 8 articles at mixed intervals, some pushes or
// single articles missing but keeping their place in the list ("holes"). A backfill starts with a small
// page budget; then some pushes are deleted upstream (the list closes up) and plain syncs with small
// budgets go on until the scan reports it is complete. Every article still listed at the end must be
// in the database, and the scan must finish within a bounded number of runs.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandbox } from "./helpers.mjs";

const first = Number(process.argv[2] ?? 1);
const seeds = Number(process.argv[3] ?? 20);
const ACC = "MP_WXS_6001";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildWorld(seed) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const streams = int(1, 3);
  const generate = [];
  const ids = [];
  for (let s = 0; s < streams; s++) {
    const perPush = pick([1, 1, 1, 2, 3, 5, 8]);
    const pushes = int(20, 140);
    const count = pushes * perPush;
    const idPrefix = `f${s}x`;
    generate.push({ account: ACC, count, perPush, stepHours: pick([6, 12, 24, 24, 48]), startHoursAgo: 1 + s * 2 + r() * 3, titlePrefix: `随机${s}第`, html: "ok.html", idPrefix });
    for (let i = 0; i < count; i++) ids.push(`${ACC}_${idPrefix}${String(i).padStart(4, "0")}`);
  }
  const holeRate = pick([0, 0.02, 0.05, 0.15]);
  const holes = ids.filter(() => r() < holeRate);
  const base = { accounts: [{ id: ACC, name: "随机测试号", intro: "虚构" }], generate, holes };
  // deleted between the first run and the rest: whole articles, anywhere in the list
  const deleteRate = pick([0, 0, 0.03, 0.1]);
  const skip = ids.filter((id) => !holes.includes(id) && r() < deleteRate);
  return { r, int, ids, holes, skip, first: base, later: { ...base, skip } };
}

const one = (S, sql, ...p) => S.q(sql, ...p)[0];
let failures = 0;
let requests = 0;
const started = Date.now();
for (let seed = first; seed < first + seeds; seed++) {
  const w = buildWorld(seed);
  const dir = mkdtempSync(join(tmpdir(), "wxmp-fuzz-"));
  const w1 = join(dir, "first.json");
  const w2 = join(dir, "later.json");
  // the html fixtures are looked up next to the world file's folder: keep the worlds in tests/fixtures
  const fixtures = new URL("./fixtures/", import.meta.url);
  const p1 = new URL(`fuzz-${process.pid}-${seed}-a.json`, fixtures);
  const p2 = new URL(`fuzz-${process.pid}-${seed}-b.json`, fixtures);
  writeFileSync(p1, JSON.stringify(w.first));
  writeFileSync(p2, JSON.stringify(w.later));
  const S = sandbox({ WXMP_MOCK_WORLD: fileURLToPath(p1) });
  const world2 = { WXMP_MOCK_WORLD: fileURLToPath(p2) };
  let problem;
  let runs = 0;
  try {
    const k1 = w.int(1, 3);
    const a = await S.run(["sync", "--account", ACC, "--since", "2012-01-01", "--max-pages", String(k1), "--page-delay", "0"]);
    if (a.code !== 0) problem = `first sync exit ${a.code}: ${a.all.trim().slice(0, 200)}`;
    const pending = () => one(S, "select pending_cutoff p from accounts where account_id=?", ACC)?.p;
    const k2 = w.int(1, 3);
    while (!problem && pending() != null && runs < 80) {
      runs += 1;
      const b = await S.run(["sync", "--account", ACC, "--max-pages", String(k2), "--page-delay", "0"], world2);
      if (b.code !== 0) problem = `sync run ${runs} exit ${b.code}: ${b.all.trim().slice(0, 200)}`;
    }
    if (!problem && pending() != null) problem = `not finished after ${runs} runs (budget ${k2} page(s) a run)`;
    if (!problem) {
      const gone = new Set([...w.holes, ...w.skip]);
      const expected = w.ids.filter((id) => !gone.has(id));
      const have = new Set(S.q("select review_id from articles where account_id=?", ACC).map((x) => x.review_id));
      const missing = expected.filter((id) => !have.has(id));
      if (missing.length) problem = `${missing.length} of ${expected.length} listed articles missing, e.g. ${missing.slice(0, 3).join(", ")}`;
    }
    const used = S.calls().filter((c) => c[1] === "articles").length;
    requests += used;
    const shape = w.first.generate.map((g) => `${g.count / g.perPush}×${g.perPush}@${g.stepHours}h`).join(" + ");
    console.log(`${problem ? "FAIL" : "ok  "} seed ${seed}: ${shape}; holes ${w.holes.length}, deleted ${w.skip.length}; ${runs + 1} runs, ${used} list requests${problem ? `\n     ${problem}` : ""}`);
    if (problem) failures += 1;
  } finally {
    S.cleanup();
    rmSync(dir, { recursive: true, force: true });
    rmSync(p1, { force: true });
    rmSync(p2, { force: true });
  }
}
console.log(`\n${seeds} seeds, ${failures} failed, ${requests} list requests, ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failures ? 1 : 0);
