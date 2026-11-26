// sync: paging the list by push, first look-back, increments, resumes, gaps and deletions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, TESTS, WXMP } from "./helpers.mjs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { toBjIso } from "../scripts/lib/util.mjs";

const FAST = ["--delay", "0", "--page-delay", "0"]; // sync
const DL = ["--delay", "0"]; // download, fetch (no paging)
const one = (S, sql, ...p) => S.q(sql, ...p)[0];
const FX = join(TESTS, "fixtures");
const INC_A = join(FX, "world-inc-a.json");
const INC_B = join(FX, "world-inc-b.json");
const count3001 = (S) => one(S, "select count(*) n from articles where account_id='MP_WXS_3001'").n;
const W = (name) => join(TESTS, "fixtures", name);
const ids3001 = (S) => new Set(S.q("select review_id from articles where account_id='MP_WXS_3001'").map((r) => r.review_id));
const count4001 = (S) => one(S, "select count(*) n from articles where account_id='MP_WXS_4001'").n;
const sinceDays = (d) => new Date(Date.now() + 8 * 3600e3 - d * 86400e3).toISOString().slice(0, 10);
const pad4 = (n) => String(n).padStart(4, "0");
const ids4001 = (S) => S.q("select review_id from articles where account_id='MP_WXS_4001'").map((x) => x.review_id);
const ID = "MP_WXS_1002_ok0001";
const OLD_TITLE = "示例快讯：工具只拿到标题";
const NEW_TITLE = "示例快讯：标题改过了";
const frontTitle = (S, rel) => JSON.parse(readFileSync(S.file(rel), "utf8").match(/^title: (.*)$/m)[1]);
const listCalls = (S) => S.calls().filter((c) => c[0] === "public-accounts" && c[1] === "articles");
// world-hole.json: 120 pushes of one article; the 21st push lost its article but keeps its place,
// so the first page (50 pushes) comes back with 49 articles. 119 articles exist.
const HOLE = { WXMP_MOCK_WORLD: W("world-hole.json") };
const ACC = "MP_WXS_5001";

test("sync: a bad watched ID fails on its own, the others still sync, no ghost rows", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_9999", "--name", "幽灵"]);
    await S.run(["watch", "add", "MP_WXS_1002"]);
    const r = await S.run(["sync", ...FAST]);
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /幽灵\s+同步失败：微信读书说找不到这个号/);
    assert.match(r.out, /新增 10 篇/);
    const ghost = await S.run(["sync", "--account", "MP_WXS_7777", ...FAST]);
    assert.equal(ghost.code, 1);
    assert.equal(S.q("select count(*) n from accounts where account_id='MP_WXS_7777'")[0].n, 0, "no row for an account WeRead does not know");
  } finally {
    S.cleanup();
  }
});

test("sync: an interrupted first sync and a page-capped sync are resumed by the next plain sync", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1001"]);
    const stopped = await S.run(["sync", ...FAST], { WXMP_MOCK_FAIL: "-2010", WXMP_MOCK_FAIL_ON: "--offset 50" });
    assert.equal(stopped.code, 2, stopped.all);
    assert.equal(one(S, "select last_sync from accounts where account_id='MP_WXS_1001'").last_sync, null, "incomplete scan must not advance last_sync");
    const resumed = await S.run(["sync", ...FAST]);
    assert.equal(resumed.code, 0, resumed.all);
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
    const n = one(S, "select count(*) n from articles where account_id='MP_WXS_1001' and list_time>=?", cutoff).n;
    assert.ok(n >= 61, `resumed sync must fill the 30-day window, got ${n}`);

    const T = sandbox();
    try {
      await T.run(["watch", "add", "MP_WXS_1001"]);
      const capped = await T.run(["sync", "--max-pages", "1", ...FAST]);
      assert.match(capped.out, /已翻满 1 页，还没到截止日/);
      await T.run(["sync", ...FAST]);
      const m = one(T, "select count(*) n from articles where account_id='MP_WXS_1001' and list_time>=?", cutoff).n;
      assert.ok(m >= 61, `capped sync must be resumed, got ${m}`);
    } finally {
      T.cleanup();
    }
  } finally {
    S.cleanup();
  }
});

test("sync --download fetches every pending article of the synced accounts", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1001"]);
    await S.run(["sync", ...FAST]);
    const r = await S.run(["sync", "--download", "--limit", "5", ...FAST]);
    assert.match(r.out, /开始下载未下载的文章（共 62 篇）/);
    assert.match(r.out, /共 62 篇待下载，本次只下 5 篇/);
    assert.equal(one(S, "select count(*) n from articles where status='ok'").n, 5);
  } finally {
    S.cleanup();
  }
});

test("an interrupted incremental sync is resumed: the backlog between the stop and the last sync is fetched", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: INC_A });
  try {
    await S.run(["watch", "add", "MP_WXS_3001"]);
    assert.equal((await S.run(["sync", ...FAST])).code, 0);
    assert.equal(count3001(S), 10);
    assert.ok(one(S, "select last_sync from accounts where account_id='MP_WXS_3001'").last_sync);
    // 120 new articles arrive; the next sync is stopped by rate limiting on page 2
    const stopped = await S.run(["sync", ...FAST], { WXMP_MOCK_WORLD: INC_B, WXMP_MOCK_FAIL: "-2010", WXMP_MOCK_FAIL_ON: "--offset 50" });
    assert.equal(stopped.code, 2, stopped.all);
    assert.equal(count3001(S), 60);
    // a plain sync must not stop at page 1 (all known) — it resumes from page 2
    const resumed = await S.run(["sync", ...FAST], { WXMP_MOCK_WORLD: INC_B });
    assert.equal(resumed.code, 0, resumed.all);
    assert.equal(count3001(S), 130);
    assert.equal(one(S, "select pending_cutoff from accounts where account_id='MP_WXS_3001'").pending_cutoff, null);
  } finally {
    S.cleanup();
  }
});

test("repeated page-capped syncs keep making progress", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: INC_B });
  try {
    await S.run(["watch", "add", "MP_WXS_3001"]);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await S.run(["sync", "--max-pages", "1", ...FAST]);
      seen.push(count3001(S));
    }
    assert.deepEqual(seen, [50, 100, 130, 130]);
  } finally {
    S.cleanup();
  }
});

test("sync details: names come from the first page, -2003 on a later page does not blame the ID, status --account filters", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", " MP_WXS_1001 "]);
    assert.equal(S.q("select watch from accounts where account_id='MP_WXS_1001'")[0].watch, 1, "watch add trims the ID");
    const r = await S.run(["sync", "--since", "2026-01-01", ...FAST], { WXMP_MOCK_FAIL: "-2003", WXMP_MOCK_FAIL_ON: "--offset 50" });
    assert.match(r.out, /读取第 2 页失败（-2003）/);
    assert.doesNotMatch(r.out, /找不到这个号/);
    assert.match((await S.run(["watch", "ls"])).out, /示例研究所/, "name was filled from page 1");
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", "--account", "MP_WXS_1002", ...FAST]);
    const st = await S.run(["status", "--account", "MP_WXS_1002"]);
    assert.match(st.out, /示例新闻社/);
    assert.doesNotMatch(st.out, /示例研究所/);
  } finally {
    S.cleanup();
  }
});

test("an article deleted above the resume point does not make the next article disappear", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-inc-b.json") });
  try {
    await S.run(["watch", "add", "MP_WXS_3001"]);
    await S.run(["sync", "--max-pages", "2", ...FAST]); // 100 stored, resume at 100
    assert.equal(ids3001(S).size, 100);
    const r = await S.run(["sync", ...FAST], { WXMP_MOCK_WORLD: W("world-inc-b-del.json") });
    assert.equal(r.code, 0, r.all);
    const have = ids3001(S);
    for (let i = 0; i < 120; i++) {
      const id = `MP_WXS_3001_new${String(i).padStart(4, "0")}`;
      assert.ok(have.has(id), `${id} missing`);
    }
    assert.equal(one(S, "select pending_cutoff from accounts where account_id='MP_WXS_3001'").pending_cutoff, null);
  } finally {
    S.cleanup();
  }
});

test("a quick --days sync on a new account does not replace the 30-day first sync", async () => {
  const S = sandbox();
  try {
    await S.run(["sync", "--account", "MP_WXS_1001", "--days", "4", ...FAST]);
    const quick = one(S, "select count(*) n from articles where account_id='MP_WXS_1001'").n;
    assert.ok(quick >= 7 && quick <= 9, `about 8 articles in 4 days, got ${quick}`);
    await S.run(["watch", "add", "MP_WXS_1001"]);
    const r = await S.run(["sync", ...FAST]);
    assert.equal(r.code, 0, r.all);
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
    const n = one(S, "select count(*) n from articles where account_id='MP_WXS_1001' and list_time>=?", cutoff).n;
    assert.ok(n >= 61, `the first plain sync fills 30 days, got ${n}`);
    assert.equal(one(S, "select initial_done from accounts where account_id='MP_WXS_1001'").initial_done, 1);
    const again = await S.run(["sync", ...FAST]);
    assert.match(again.out, /新增 0 篇（翻了 1 页/, "after that, plain syncs are incremental");
  } finally {
    S.cleanup();
  }
});

test("a page cap spent on new arrivals says so and keeps the old resume point", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-inc-a.json") });
  try {
    await S.run(["watch", "add", "MP_WXS_3001"]);
    await S.run(["sync", ...FAST]);
    await S.run(["sync", "--max-pages", "1", ...FAST], { WXMP_MOCK_WORLD: W("world-inc-b.json") }); // 50 of 120 new, resume 50
    const resume = one(S, "select resume_offset from accounts where account_id='MP_WXS_3001'").resume_offset;
    assert.equal(resume, 50);
    const r = await S.run(["sync", "--max-pages", "1", ...FAST], { WXMP_MOCK_WORLD: W("world-inc-c.json") }); // 60 more arrive
    assert.match(r.out, /这次的 1 页都用在追新文章上了/);
    assert.equal(one(S, "select resume_offset from accounts where account_id='MP_WXS_3001'").resume_offset, 50, "the backlog position is kept");
    const done = await S.run(["sync", ...FAST], { WXMP_MOCK_WORLD: W("world-inc-c.json") });
    assert.equal(done.code, 0, done.all);
    assert.equal(ids3001(S).size, 190, "10 old + 120 new + 60 newer");
  } finally {
    S.cleanup();
  }
});

test("an account WeRead does not know gets no pending scan", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_9999"]);
    const r = await S.run(["sync", ...FAST]);
    assert.equal(r.code, 1);
    assert.equal(one(S, "select pending_cutoff from accounts where account_id='MP_WXS_9999'").pending_cutoff, null);
  } finally {
    S.cleanup();
  }
});

test("accounts that send several articles per push: the first sync skips no pushes between pages", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-pushes.json") });
  try {
    await S.run(["watch", "add", "MP_WXS_4001"]);
    const r = await S.run(["sync", ...FAST]);
    assert.equal(r.code, 0, r.all);
    assert.equal(count4001(S), 180, "60 pushes x 3 articles in 30 days");
    const times = S.q("select distinct list_time t from articles where account_id='MP_WXS_4001' order by t desc").map((x) => x.t);
    assert.equal(times.length, 60);
    for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] - times[i] <= 12 * 3600 + 5, `pushes missing after push ${i}`);
  } finally {
    S.cleanup();
  }
});

test("a page-capped backfill of a multi-article-push account resumes without gaps", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-pushes.json") });
  try {
    const since = new Date(Date.now() + 8 * 3600e3 - 80 * 86400e3).toISOString().slice(0, 10);
    const first = await S.run(["sync", "--account", "MP_WXS_4001", "--since", since, "--max-pages", "1", ...FAST]);
    assert.equal(first.code, 0, first.all);
    assert.equal(count4001(S), 150, "one page = 50 pushes = 150 articles");
    const pendingNow = () => one(S, "select pending_cutoff p from accounts where account_id='MP_WXS_4001'").p;
    for (let i = 0; i < 8 && pendingNow() != null; i++) await S.run(["sync", "--account", "MP_WXS_4001", "--max-pages", "1", ...FAST]);
    assert.equal(pendingNow(), null, "the backfill finished");
    assert.equal(count4001(S), 450, "all 150 pushes");
  } finally {
    S.cleanup();
  }
});

test("more pushes deleted above the resume point than the overlap: the resume steps back instead of skipping", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-pushes.json") });
  try {
    await S.run(["sync", "--account", "MP_WXS_4001", "--since", sinceDays(80), "--max-pages", "2", ...FAST]);
    assert.equal(count4001(S), 300, "pushes 0..99");
    const r = await S.run(["sync", "--account", "MP_WXS_4001", ...FAST], { WXMP_MOCK_WORLD: W("world-pushes-del11.json") });
    assert.equal(r.code, 0, r.all);
    const have = new Set(S.q("select review_id from articles where account_id='MP_WXS_4001'").map((x) => x.review_id));
    const missing = [];
    for (let i = 0; i < 450; i++) if (!have.has(`MP_WXS_4001_p${pad4(i)}`)) missing.push(i);
    assert.deepEqual(missing, []);
    assert.equal(one(S, "select pending_cutoff p from accounts where account_id='MP_WXS_4001'").p, null);
  } finally {
    S.cleanup();
  }
});

test("articles of one push with different timestamps do not push the offset past a page", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-jitter.json") });
  try {
    await S.run(["watch", "add", "MP_WXS_4001"]);
    const r = await S.run(["sync", ...FAST]);
    assert.equal(r.code, 0, r.all);
    assert.equal(count4001(S), 180, "60 pushes x 3 in 30 days");
    const offsets = S.calls()
      .filter((c) => c[1] === "articles")
      .map((c) => (c.includes("--offset") ? Number(c[c.indexOf("--offset") + 1]) : 0));
    assert.deepEqual(offsets, [0, 50]);
  } finally {
    S.cleanup();
  }
});

test("a run killed outright in the middle of a backfill leaves a resumable record", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-pushes.json") });
  try {
    const env = { ...S.env, WXMP_MOCK_FAIL: "HANG", WXMP_MOCK_FAIL_ON: "--offset 100", WXMP_TIMEOUT_MS: "60000", WXMP_MOCK_HANG_MS: "4000" };
    const child = spawn(process.execPath, ["--no-warnings", WXMP, "sync", "--account", "MP_WXS_4001", "--since", sinceDays(80), ...FAST], { env, windowsHide: true });
    for (let i = 0; i < 300 && !S.calls().some((c) => c.includes("100")); i++) await new Promise((res) => setTimeout(res, 100));
    child.kill("SIGKILL"); // no finally block runs
    await new Promise((res) => child.on("close", res));
    const acc = one(S, "select pending_cutoff p, resume_offset r from accounts where account_id='MP_WXS_4001'");
    assert.notEqual(acc.p, null, "the unfinished backfill is remembered");
    assert.equal(acc.r, 100);
    const done = await S.run(["sync", "--account", "MP_WXS_4001", ...FAST]);
    assert.equal(done.code, 0, done.all);
    assert.equal(count4001(S), 450);
  } finally {
    S.cleanup();
  }
});

test("a list that shrank below the resume point is read back from earlier pages, not taken as finished", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-pushes.json") });
  try {
    await S.run(["sync", "--account", "MP_WXS_4001", "--since", sinceDays(80), "--max-pages", "2", ...FAST]);
    assert.equal(ids4001(S).length, 300);
    const env = { WXMP_MOCK_WORLD: W("world-pushes-del60.json") };
    const pendingNow = () => one(S, "select pending_cutoff p from accounts where account_id='MP_WXS_4001'").p;
    for (let i = 0; i < 10 && pendingNow() != null; i++) await S.run(["sync", "--account", "MP_WXS_4001", "--max-pages", "1", ...FAST], env);
    assert.equal(pendingNow(), null, "the scan finished");
    const have = new Set(ids4001(S));
    const missing = [];
    for (let i = 180; i < 450; i++) if (!have.has(`MP_WXS_4001_p${pad4(i)}`)) missing.push(i);
    assert.deepEqual(missing, [], "every article still listed upstream is stored");
  } finally {
    S.cleanup();
  }
});

test("jittered pushes with many deletions: one-page resumes finish instead of going back and forth", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-jitter.json") });
  try {
    await S.run(["sync", "--account", "MP_WXS_4001", "--since", sinceDays(80), "--max-pages", "2", ...FAST]);
    const env = { WXMP_MOCK_WORLD: W("world-jitter-del70.json") };
    const pendingNow = () => one(S, "select pending_cutoff p from accounts where account_id='MP_WXS_4001'").p;
    let runs = 0;
    for (; runs < 6 && pendingNow() != null; runs++) await S.run(["sync", "--account", "MP_WXS_4001", "--max-pages", "1", ...FAST], env);
    assert.equal(pendingNow(), null, `finished (after ${runs} runs)`);
    assert.ok(runs <= 3, `within 3 runs, took ${runs}`);
    const have = new Set(S.q("select review_id from articles where account_id='MP_WXS_4001'").map((x) => x.review_id));
    const missing = [];
    for (let i = 210; i < 450; i++) if (!have.has(`MP_WXS_4001_p${pad4(i)}`)) missing.push(i);
    assert.deepEqual(missing, []);
  } finally {
    S.cleanup();
  }
});

test("sync updates the title of an article not downloaded yet, but not of a downloaded one", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    assert.equal(one(S, "select title from articles where review_id=?", ID).title, OLD_TITLE);
    await S.run(["sync", "--days", "30", ...FAST], { WXMP_MOCK_WORLD: W("world-retitled.json") });
    assert.equal(one(S, "select title from articles where review_id=?", ID).title, NEW_TITLE, "not downloaded: the newer title");
    assert.equal((await S.run(["download", ID, ...DL], { WXMP_MOCK_WORLD: W("world-retitled.json") })).code, 0);
    const row = one(S, "select title, md_path from articles where review_id=?", ID);
    assert.equal(frontTitle(S, row.md_path), NEW_TITLE);
    const r = await S.run(["sync", "--days", "30", ...FAST]); // the listing shows the other title again
    assert.equal(r.code, 0, r.all);
    assert.equal(one(S, "select title from articles where review_id=?", ID).title, NEW_TITLE, "downloaded: matches its file");
    assert.equal(frontTitle(S, row.md_path), NEW_TITLE);
  } finally {
    S.cleanup();
  }
});

test("pushes that all share a timestamp: one-page-budget resumes still move forward and finish", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-ties.json") });
  try {
    const since = new Date(Date.now() + 8 * 3600e3 - 80 * 86400e3).toISOString().slice(0, 10);
    await S.run(["sync", "--account", "MP_WXS_4002", "--since", since, "--max-pages", "2", ...FAST]);
    const env = { WXMP_MOCK_WORLD: W("world-ties-del30.json") };
    const pendingNow = () => one(S, "select pending_cutoff p from accounts where account_id='MP_WXS_4002'").p;
    const articlesCalls = () => S.calls().filter((c) => c[0] === "public-accounts" && c[1] === "articles").length;
    let runs = 0;
    // Every article is stored within the first runs; the later ones only walk the short pages at the
    // end of the list (a few pushes each, as these pushes cannot be told apart) up to the empty page
    // that ends it. A short page alone does not count as the end.
    for (; runs < 16 && pendingNow() != null; runs++) {
      const before = articlesCalls();
      const r = await S.run(["sync", "--account", "MP_WXS_4002", "--max-pages", "3", ...FAST], env);
      assert.equal(r.code, 0, r.all);
      const used = articlesCalls() - before;
      assert.ok(used >= 1 && used <= 7, `1 to 2 x 3 + 1 list requests in a run, got ${used}`);
    }
    assert.equal(pendingNow(), null, `finished (after ${runs} runs)`);
    const have = new Set(S.q("select review_id from articles where account_id='MP_WXS_4002'").map((x) => x.review_id));
    const missing = [];
    for (let i = 30; i < 150; i++) if (!have.has(`MP_WXS_4002_t${String(i).padStart(4, "0")}`)) missing.push(i);
    assert.deepEqual(missing, []);
  } finally {
    S.cleanup();
  }
});

test("a page one article short of 50 is not taken as the end of the list", async () => {
  const S = sandbox(HOLE);
  try {
    const r = await S.run(["sync", "--account", ACC, "--since", "2012-01-01", "--max-pages", "30", ...FAST]);
    assert.equal(r.code, 0, r.all);
    assert.equal(one(S, "select count(*) n from articles where account_id=?", ACC).n, 119, "every article behind the short page is listed");
    const acc = one(S, "select pending_cutoff p, last_sync from accounts where account_id=?", ACC);
    assert.equal(acc.p, null, "the scan is complete");
    assert.ok(acc.last_sync);
    // 49 + 50 + 20 articles, then the empty page that ends the list
    assert.equal(listCalls(S).length, 4);
    assert.equal(listCalls(S).at(-1).at(-1), "120", "the list ends with an empty page, not with a short one");
  } finally {
    S.cleanup();
  }
});

test("one-page-budget resumes finish after a short page instead of re-reading it for ever", async () => {
  const S = sandbox(HOLE);
  try {
    await S.run(["sync", "--account", ACC, "--since", "2012-01-01", "--max-pages", "1", ...FAST]);
    const pendingNow = () => one(S, "select pending_cutoff p from accounts where account_id=?", ACC).p;
    assert.notEqual(pendingNow(), null, "one page of a longer list leaves the scan pending");
    let runs = 0;
    for (; runs < 6 && pendingNow() != null; runs++) {
      const before = listCalls(S).length;
      const r = await S.run(["sync", "--account", ACC, "--max-pages", "1", ...FAST]);
      assert.equal(r.code, 0, r.all);
      const used = listCalls(S).length - before;
      assert.ok(used >= 1 && used <= 3, `at most 1 + 1 pages and one refunded empty page in a run, got ${used}`);
    }
    assert.equal(pendingNow(), null, `finished (after ${runs} runs)`);
    assert.equal(one(S, "select count(*) n from articles where account_id=?", ACC).n, 119);
  } finally {
    S.cleanup();
  }
});

test("a plain sync after the backfill is incremental again: one page, nothing new", async () => {
  const S = sandbox(HOLE);
  try {
    await S.run(["sync", "--account", ACC, "--since", "2012-01-01", ...FAST]);
    const before = listCalls(S).length;
    const r = await S.run(["sync", "--account", ACC, ...FAST]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /新增 0 篇（翻了 1 页/);
    assert.equal(listCalls(S).length - before, 1);
    assert.equal(/列表是空的/.test(r.out), false, "an account with articles gets no empty-list hint");
  } finally {
    S.cleanup();
  }
});

test("an empty list for an account with nothing stored says the ID may be wrong", async () => {
  // WeRead answers a list request for an account ID it does not know with an empty list, not an error.
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-empty.json") });
  try {
    const r = await S.run(["sync", "--account", "MP_WXS_5002", ...FAST]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /新增 0 篇（翻了 1 页/);
    assert.match(r.out, /微信读书给出的文章列表是空的：号 ID 可能不对/);
    assert.equal(listCalls(S).length, 1);
  } finally {
    S.cleanup();
  }
});

test("a plain sync after a short --days window still fills the gap since the last full sync", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1001"]);
    await S.run(["sync", ...FAST]);
    const total = one(S, "select count(*) n from articles where account_id='MP_WXS_1001'").n;
    // pretend the last full sync was 10 days ago and nothing listed since then is stored yet
    const tenDaysAgo = Math.floor(Date.now() / 1000) - 10 * 86400;
    const db = new DatabaseSync(join(S.env.WXMP_HOME, "wxmp.db"));
    const gone = db.prepare("delete from articles where account_id='MP_WXS_1001' and list_time > ?").run(tenDaysAgo).changes;
    db.prepare("update accounts set last_sync=? where account_id='MP_WXS_1001'").run(toBjIso(tenDaysAgo * 1000));
    db.close();
    assert.ok(gone >= 10, `${gone} articles in the gap`);
    const quick = await S.run(["sync", "--account", "MP_WXS_1001", "--days", "1", ...FAST]);
    assert.equal(quick.code, 0, quick.all);
    const before = one(S, "select last_sync from accounts where account_id='MP_WXS_1001'").last_sync;
    assert.equal(before, toBjIso(tenDaysAgo * 1000), "a one-day window does not move last_sync");
    const plain = await S.run(["sync", ...FAST]);
    assert.equal(plain.code, 0, plain.all);
    assert.equal(one(S, "select count(*) n from articles where account_id='MP_WXS_1001'").n, total, "every article is back");
    assert.notEqual(one(S, "select last_sync from accounts where account_id='MP_WXS_1001'").last_sync, before, "the plain sync moves it");
  } finally {
    S.cleanup();
  }
});
