// The command line as a whole: arguments, messages, search, locks, the database, errors that stop a run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, rmSync, appendFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { sandbox, TESTS, ROOT } from "./helpers.mjs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { homedir, userInfo, tmpdir } from "node:os";

const FAST = ["--delay", "0", "--page-delay", "0"]; // sync
const DL = ["--delay", "0"]; // download, fetch (no paging)
const EXTRA = join(TESTS, "fixtures", "world-extra.json");
const one = (S, sql, ...p) => S.q(sql, ...p)[0];
const W = (name) => join(TESTS, "fixtures", name);
const md = async (html) => (await fragmentToMarkdown(`<div id="js_content">${html}</div>`)).markdown;
const pad4 = (n) => String(n).padStart(4, "0");
async function downloaded(S, id = "MP_WXS_1002_ok0001", extra = {}) {
  await S.run(["watch", "add", id.slice(0, 11)], extra);
  await S.run(["sync", ...FAST], extra);
  const r = await S.run(["download", id, ...DL], extra);
  assert.equal(r.code, 0, r.all);
  return one(S, "select status, body_chars, md_path, pub_time, doc_url, title from articles where review_id=?", id);
}
const FAKE_ALT = [
  'import { readFileSync, writeFileSync, existsSync } from "node:fs";',
  'const a = process.argv.slice(2).filter((x) => x !== "--json");',
  "const counter = process.env.FAKE_COUNTER;",
  "const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };",
  'const die = (o) => { process.stderr.write(JSON.stringify(o) + "\\n"); process.exit(1); };',
  'if (a[0] === "review" && a[1] === "single") out({ reviewId: a[2], review: { reviewId: a[2], belongBookId: "MP_WXS_1001", mpInfo: { doc_url: "https://mp.weixin.qq.com/s?__biz=MTAwMQ==&mid=" + a[2], title: "t", time: 1700000000, mp_name: "x" } } });',
  'if (a[0] === "public-accounts" && a[1] === "read-article") {',
  '  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;',
  "  writeFileSync(counter, String(n + 1));",
  '  die({ error: "upstream request failed", errCode: n % 2 ? 9002 : 9001 });',
  "}",
  'die({ error: "unsupported" });',
].join("\n");
// read-article answers: "ok" gives a readable article; a number fails with that code (-2013 / -2003 are
// known per-article answers, others are unexplained); -2041 is risk control.
const FAKE_SEQ = [
  'import { readFileSync, writeFileSync, existsSync } from "node:fs";',
  'const a = process.argv.slice(2).filter((x) => x !== "--json");',
  "const counter = process.env.FAKE_COUNTER;",
  'const seq = process.env.FAKE_SEQ.split(",");',
  "const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };",
  'const die = (o) => { process.stderr.write(JSON.stringify(o) + "\\n"); process.exit(1); };',
  'if (a[0] === "review" && a[1] === "single") out({ reviewId: a[2], review: { reviewId: a[2], belongBookId: "MP_WXS_1001", mpInfo: { doc_url: "https://mp.weixin.qq.com/s?__biz=MTAwMQ==&mid=" + a[2], title: "t", time: 1700000000, mp_name: "x" } } });',
  'if (a[0] === "public-accounts" && a[1] === "read-article") {',
  '  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;',
  "  writeFileSync(counter, String(n + 1));",
  "  const step = seq[n] ?? \"ok\";",
  '  if (step === "ok") out({ reviewId: "x", sourceSha256: "0".repeat(64), markdown: "## t\\n\\n" + "正文内容。".repeat(80), status: "readable" });',
  '  die({ error: "simulated " + step, errCode: Number(step) });',
  "}",
  'die({ error: "unsupported" });',
].join("\n");
async function withFake(S, seq) {
  await S.run(["watch", "add", "MP_WXS_1001"]);
  await S.run(["sync", ...FAST]);
  const fake = join(S.dir, "fake.mjs");
  writeFileSync(fake, FAKE_SEQ);
  return { WXMP_WEREAD_CLI: fake, FAKE_COUNTER: join(S.dir, "n.txt"), FAKE_SEQ: seq };
}
const ID = "MP_WXS_1002_ok0001";
// resolve-article answers follow FAKE_SEQ: "ok" resolves to MP_WXS_1001_r<n>, a number fails with that code.
const FAKE_RESOLVE = [
  'import { readFileSync, writeFileSync, existsSync } from "node:fs";',
  'const a = process.argv.slice(2).filter((x) => x !== "--json");',
  "const counter = process.env.FAKE_COUNTER;",
  'const seq = process.env.FAKE_SEQ.split(",");',
  "const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };",
  'const die = (o) => { process.stderr.write(JSON.stringify(o) + "\\n"); process.exit(1); };',
  'if (a[0] === "public-accounts" && a[1] === "resolve-article") {',
  '  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;',
  "  writeFileSync(counter, String(n + 1));",
  '  if ((seq[n] ?? "ok") === "ok") out({ url: a[2], reviewId: "MP_WXS_1001_r" + n });',
  '  die({ error: "simulated " + seq[n], errCode: Number(seq[n]) });',
  "}",
  'die({ error: "unsupported" });',
].join("\n");

test("search account: --max-idx bypasses the cache and never overwrites the first-page cache", async () => {
  const S = sandbox();
  try {
    await S.run(["search", "account", "示例"]);
    const n = S.calls().length;
    const paged = await S.run(["search", "account", "示例", "--max-idx", "1"]);
    assert.equal(S.calls().length, n + 1, "a paged search goes to weread");
    assert.doesNotMatch(paged.out, /缓存/);
    const again = await S.run(["search", "account", "示例"]);
    assert.match(again.out, /缓存/);
    assert.match(again.out, /MP_WXS_1001/, "first page is still cached");
    assert.equal(S.calls().length, n + 1);
  } finally {
    S.cleanup();
  }
});

test("--account: same name on two watched accounts is ambiguous; trailing spaces are trimmed", async () => {
  const S = sandbox();
  try {
    await S.run(["search", "account", "同名号"]);
    await S.run(["watch", "add", "MP_WXS_1004"]);
    await S.run(["watch", "add", "MP_WXS_1005"]);
    const r = await S.run(["list", "--account", "同名号"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /有 2 个号叫「同名号」/);
    const t = await S.run(["list", "--account", "MP_WXS_1004 "]);
    assert.equal(t.code, 0, t.all);
  } finally {
    S.cleanup();
  }
});

test("bad input is rejected: non-WeChat URLs, empty values, extra arguments, conflicting options, bad --review IDs", async () => {
  const S = sandbox();
  try {
    const cases = [
      ["watch", "add", "https://example.com/x?__biz=MTAwMg=="],
      ["watch", "add", "MP_WXS_1001", "extra"],
      ["list", "--since", ""],
      ["download", "--status", ","],
      ["sync", "--since", "2026-11-01", "--days", "2"],
      ["download", "--limit", "3.5"],
      ["list", "--top", "3.5"],
      ["download", "--review", "NOTEXIST_1"],
      ["download", "--review", "../../x"],
      ["search", "article", "x", "--max-idx", "-1"],
      ["list", "--nosuch"],
      ["status", "extra"],
    ];
    for (const args of cases) {
      const r = await S.run(args);
      assert.equal(r.code, 1, `${args.join(" ")} → ${r.all}`);
      assert.match(r.err, /^参数错误：/, args.join(" "));
      assert.doesNotMatch(r.err, /Unknown option|ambiguous|at .*\.mjs:\d+/, args.join(" "));
    }
    assert.equal((await S.run(["download", "--delay", "0.5"])).code, 0, "fractional seconds are fine for --delay");
    const rm = await S.run(["watch", "rm", "MP_WXS_1234"]);
    assert.match(rm.out, /本来就没有关注/);
    assert.equal(S.q("select count(*) n from articles")[0].n, 0, "nothing was written by rejected commands");
  } finally {
    S.cleanup();
  }
});

test("a dead weread-omni (garbage / hang) stops the batch instead of failing every article", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1001"]);
    await S.run(["sync", ...FAST]);
    for (const [fail, extra] of [["GARBAGE", {}], ["HANG", { WXMP_TIMEOUT_MS: "1500" }]]) {
      const r = await S.run(["download", "--limit", "3", ...DL], { WXMP_MOCK_FAIL: fail, WXMP_MOCK_FAIL_ON: "read-article", ...extra });
      assert.equal(r.code, 2, `${fail}: ${r.all}`);
      assert.match(r.err, /wxmp doctor/);
    }
    assert.equal(one(S, "select count(*) n from articles where status='failed'").n, 0);
  } finally {
    S.cleanup();
  }
});

test("search article hits stay out of download/list/export/status until asked for", async () => {
  const S = sandbox();
  try {
    await S.run(["search", "article", "周报"]);
    assert.equal(S.q("select count(*) n from articles")[0].n, 20, "hits are remembered");
    assert.match((await S.run(["download", ...DL])).out, /没有符合条件/);
    assert.match((await S.run(["list"])).out, /没有符合条件/);
    const out = join(S.dir, "e.csv");
    await S.run(["export", "--out", out]);
    assert.equal(readFileSync(out, "utf8").split("\r\n").filter(Boolean).length, 1, "header only");
    const rid = S.q("select review_id from articles limit 1")[0].review_id;
    const d = await S.run(["download", "--review", rid, ...DL]);
    assert.equal(d.code, 0, d.all);
    assert.equal(one(S, "select status from articles where review_id=?", rid).status, "ok");
  } finally {
    S.cleanup();
  }
});

test("parallel networked runs on one data dir: one runs, the others refuse; nothing crashes on SQLite locks", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1001"]);
    await S.run(["sync", ...FAST]);
    const runs = await Promise.all([1, 2, 3].map(() => S.run(["download", "--limit", "15", ...DL])));
    for (const r of runs) {
      assert.doesNotMatch(r.all, /database is locked/);
      if (r.code !== 0) assert.match(r.err, /另一个 wxmp 正在使用这个数据目录/, r.all);
    }
    assert.ok(runs.some((r) => r.code === 0), "one of them ran");
    // read-only commands never take the lock
    const reads = await Promise.all([1, 2, 3].map(() => S.run(["status"])));
    for (const r of reads) assert.equal(r.code, 0, r.all);
  } finally {
    S.cleanup();
  }
});

test("read-only database still works for list/status/export; corrupt database explains what to do", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    const db = join(S.env.WXMP_HOME, "wxmp.db");
    chmodSync(db, 0o444);
    try {
      const l = await S.run(["list", "--top", "2"]);
      assert.equal(l.code, 0, l.all);
      assert.equal((await S.run(["status"])).code, 0);
    } finally {
      chmodSync(db, 0o666);
    }
    const T = sandbox();
    try {
      mkdirSync(T.env.WXMP_HOME, { recursive: true });
      writeFileSync(join(T.env.WXMP_HOME, "wxmp.db"), "this is definitely not sqlite ".repeat(200));
      const r = await T.run(["list"]);
      assert.equal(r.code, 1);
      assert.match(r.err, /数据库文件损坏.*改名备份/);
    } finally {
      T.cleanup();
    }
  } finally {
    S.cleanup();
  }
});

test("accounts without a name show their full ID; fetch with only bad links exits 1", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: EXTRA });
  try {
    await S.run(["sync", "--account", "MP_WXS_2002", ...FAST]);
    const l = await S.run(["list", "--account", "MP_WXS_2002"]);
    assert.match(l.out, /MP_WXS_2002/);
    assert.doesNotMatch(l.out, /MP_WXS…/);
    const st = await S.run(["status"]);
    assert.match(st.out, /MP_WXS_2002/);
    const f = await S.run(["fetch", "https://example.com/a", "", ...DL]);
    assert.equal(f.code, 1);
  } finally {
    S.cleanup();
  }
});

test("doctor gives the fix for risk-control failures", async () => {
  const S = sandbox();
  try {
    const r = await S.run(["doctor"], { WXMP_MOCK_FAIL: "-2041" });
    assert.equal(r.code, 1);
    assert.match(r.out, /\[FAIL\] 微信读书连接.*微信读书 App/);
  } finally {
    S.cleanup();
  }
});

test("stored paths are relative: a moved data dir keeps working", async () => {
  const { cpSync } = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    await S.run(["download", "--review", "MP_WXS_1002_ok0001", ...DL]);
    const rel = one(S, "select md_path from articles where review_id='MP_WXS_1002_ok0001'").md_path;
    assert.match(rel, /^articles\/示例新闻社\/.+\.md$/, rel);
    const moved = join(S.dir, "moved");
    cpSync(S.env.WXMP_HOME, moved, { recursive: true });
    const r = await S.run(["refix", "--review", "MP_WXS_1002_ok0001"], { WXMP_HOME: moved });
    assert.equal(r.code, 0, r.all);
    const check = new DatabaseSync(join(moved, "wxmp.db"), { readOnly: true });
    const row = check.prepare("select md_path, raw_path, status from articles where review_id='MP_WXS_1002_ok0001'").get();
    check.close();
    assert.equal(row.md_path, rel);
    assert.equal(row.raw_path, "raw/MP_WXS_1002/MP_WXS_1002_ok0001.html.gz");
    assert.equal(row.status, "fixed");
    assert.ok(existsSync(join(moved, rel)));
  } finally {
    S.cleanup();
  }
});

test("output that is not the expected shape stops the run instead of looking like an empty sync", async () => {
  const S = sandbox();
  try {
    const fake = join(S.dir, "fake-cli.mjs");
    writeFileSync(fake, 'process.stdout.write(JSON.stringify({ foo: 1 }));\n');
    await S.run(["watch", "add", "MP_WXS_1001"]);
    const r = await S.run(["sync", ...FAST], { WXMP_WEREAD_CLI: fake });
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /输出格式不对/);
    assert.equal(one(S, "select last_sync from accounts where account_id='MP_WXS_1001'").last_sync, null);
  } finally {
    S.cleanup();
  }
});

test("one networked run per data dir: a live lock refuses, a stale lock is taken over", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    const lock = join(S.env.WXMP_HOME, "wxmp.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: "2026-11-07T09:00:00+08:00", cmd: "download" }));
    const busy = await S.run(["download", "--limit", "1", ...DL]);
    assert.equal(busy.code, 1);
    assert.match(busy.err, new RegExp(`另一个 wxmp 正在使用这个数据目录（pid ${process.pid}`));
    assert.equal((await S.run(["list", "--top", "1"])).code, 0, "read-only commands ignore the lock");
    writeFileSync(lock, JSON.stringify({ pid: 999999, cmd: "download" }));
    const stale = await S.run(["download", "--limit", "1", ...DL]);
    assert.notEqual(stale.code, 2);
    assert.doesNotMatch(stale.err, /另一个 wxmp/);
    assert.ok(!existsSync(lock), "the lock is removed when the run ends");
  } finally {
    S.cleanup();
  }
});

test("messages: read-only DB on write is explained in Chinese; per-article failures have no English upstream text", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    const d = await S.run(["download", "--account", "MP_WXS_1002", ...DL]);
    assert.doesNotMatch(d.out, /article source content was insufficient|review not found/);
    assert.match(d.out, /原文页面没有可用正文/);
    const db = join(S.env.WXMP_HOME, "wxmp.db");
    chmodSync(db, 0o444);
    try {
      const w = await S.run(["watch", "add", "MP_WXS_1001"]);
      assert.equal(w.code, 1);
      assert.match(w.err, /数据库是只读的/);
      assert.doesNotMatch(w.err, /attempt to write/);
    } finally {
      chmodSync(db, 0o666);
    }
  } finally {
    S.cleanup();
  }
});

test("search article shows abstracts; doctor counts only library articles; status tells same-name accounts apart", async () => {
  const S = sandbox();
  try {
    const s = await S.run(["search", "article", "周报", "--top", "2"]);
    assert.match(s.out, /摘要：/);
    assert.match((await S.run(["doctor"])).out, /库里 0 篇/);
    await S.run(["search", "account", "同名号"]);
    await S.run(["watch", "add", "MP_WXS_1004"]);
    await S.run(["watch", "add", "MP_WXS_1005"]);
    const st = await S.run(["status"]);
    assert.match(st.out, /同名号\(1004\)/);
    assert.match(st.out, /同名号\(1005\)/);
  } finally {
    S.cleanup();
  }
});

test("unknown weread-omni errors: Chinese with the original text, and three in a row stop the batch", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1001"]);
    await S.run(["sync", ...FAST]);
    const r = await S.run(["download", "--limit", "6", ...DL], { WXMP_MOCK_FAIL: "-2001", WXMP_MOCK_FAIL_ON: "read-article" });
    assert.equal(r.code, 2, r.all);
    assert.match(r.out, /微信读书接口报错（代码 -2001），原始信息/);
    assert.match(r.err, /连续 3 篇返回无法识别的错误/);
    assert.equal((r.out.match(/^\[\d+\/6\]/gm) || []).length, 3, "stopped after the third");
  } finally {
    S.cleanup();
  }
});

test("output shape: list items without an ID and resolve answers without an ID stop the run", async () => {
  const S = sandbox();
  try {
    const fake = join(S.dir, "fake.mjs");
    writeFileSync(
      fake,
      [
        "const a = process.argv.slice(2);",
        "const out = (o) => process.stdout.write(JSON.stringify(o));",
        'if (a[1] === "articles") out({ articles: [{ mpInfo: { title: "x" }, createTime: 1 }], returnedCount: 1 });',
        'else if (a[1] === "resolve-article") out({ url: a[2] });',
        "else out({});",
      ].join("\n"),
    );
    await S.run(["watch", "add", "MP_WXS_1001"]);
    const s = await S.run(["sync", ...FAST], { WXMP_WEREAD_CLI: fake });
    assert.equal(s.code, 2, s.all);
    assert.match(s.err, /缺少文章 ID/);
    const f = await S.run(["fetch", "https://mp.weixin.qq.com/s?__biz=MTAwMQ==&mid=1&idx=1&sn=abc", ...DL], { WXMP_WEREAD_CLI: fake });
    assert.equal(f.code, 2, f.all);
    assert.match(f.err, /没有文章 ID/);
  } finally {
    S.cleanup();
  }
});

test("first opens of a new data dir in parallel all succeed", async () => {
  const S = sandbox();
  try {
    const runs = await Promise.all([1, 2, 3, 4].map(() => S.run(["watch", "ls"])));
    for (const r of runs) {
      assert.equal(r.code, 0, r.all);
      assert.doesNotMatch(r.all, /duplicate column/);
    }
  } finally {
    S.cleanup();
  }
});

test("usage details: unsupported options, doctor arguments, placeholders in messages, path conflicts, lock directory", async () => {
  const S = sandbox();
  try {
    const st = await S.run(["status", "--since", "2026-01-01"]);
    assert.equal(st.code, 1);
    assert.match(st.err, /status 不支持 --since/);
    assert.equal((await S.run(["doctor", "extra"])).code, 1);
    const rv = await S.run(["download", "--review"]);
    assert.equal(rv.code, 1);
    assert.doesNotMatch(rv.err, /<value>/);
    const bad = await S.run(["download", "not-an-id"]);
    assert.match(bad.err, /不是有效的文章 ID：not-an-id/);
    writeFileSync(join(S.dir, "exp"), "a file");
    const e = await S.run(["export", "--out", join(S.dir, "exp", "all.csv")]);
    assert.equal(e.code, 1);
    assert.match(e.err, /路径冲突/);
    mkdirSync(join(S.env.WXMP_HOME, "wxmp.lock"), { recursive: true });
    const l = await S.run(["search", "account", "示例"]);
    assert.equal(l.code, 1);
    assert.match(l.err, /锁文件的位置被一个目录占用/);
  } finally {
    S.cleanup();
  }
});

test("unknown errors whose text varies (request numbers) still stop the batch after three", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1001"]);
    await S.run(["sync", ...FAST]);
    const r = await S.run(["download", "--limit", "6", ...DL], { WXMP_MOCK_FAIL: "-2001", WXMP_MOCK_FAIL_ON: "read-article", WXMP_MOCK_FAIL_VARY: "1" });
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /连续 3 篇返回无法识别的错误/);
    assert.equal((r.out.match(/^\[\d+\/6\]/gm) || []).length, 3);
  } finally {
    S.cleanup();
  }
});

test("an unknown error in Chinese still shows its code", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1001"]);
    await S.run(["sync", ...FAST]);
    const r = await S.run(["download", "--limit", "1", ...DL], { WXMP_MOCK_FAIL: "-9999", WXMP_MOCK_FAIL_ON: "read-article", WXMP_MOCK_FAIL_MSG: "服务端返回未知错误" });
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /微信读书接口报错（代码 -9999），原始信息：服务端返回未知错误/);
  } finally {
    S.cleanup();
  }
});

test("an error reported on stdout with exit code 0 is still that error (here: risk control)", async () => {
  const S = sandbox();
  try {
    const r = await S.run(["search", "account", "示例"], { WXMP_MOCK_FAIL: "-2041", WXMP_MOCK_FAIL_STDOUT: "1" });
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /人机验证/);
  } finally {
    S.cleanup();
  }
});

test("fetch stops after three links fail with the same unknown error", async () => {
  const S = sandbox();
  try {
    const urls = [1, 2, 3, 4].map((n) => `https://mp.weixin.qq.com/s?__biz=MTAwMQ==&mid=${n}&idx=1&sn=x`);
    const r = await S.run(["fetch", ...urls, ...DL], { WXMP_MOCK_FAIL: "-2001", WXMP_MOCK_FAIL_ON: "resolve-article", WXMP_MOCK_FAIL_VARY: "1" });
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /连续 3 个链接返回无法识别的错误/);
    assert.equal(S.calls().filter((c) => c[1] === "resolve-article").length, 3);
  } finally {
    S.cleanup();
  }
});

test("a folder where the database or an article file should be is explained with its real path", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    await S.run(["download", "MP_WXS_1002_ok0001", ...DL]);
    const mdPath = S.file(one(S, "select md_path from articles where review_id='MP_WXS_1002_ok0001'").md_path);
    rmSync(mdPath);
    mkdirSync(mdPath);
    const r = await S.run(["download", "MP_WXS_1002_ok0001", "--force", ...DL]);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /路径冲突：.*\.md 是一个目录/);
  } finally {
    S.cleanup();
  }
  const T = sandbox();
  try {
    mkdirSync(join(T.env.WXMP_HOME, "wxmp.db"), { recursive: true });
    const r = await T.run(["list"]);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /打不开数据库文件/);
  } finally {
    T.cleanup();
  }
});

test("details: offline writers wait for the lock; lock directory; unknown account; stray options", async () => {
  const S = sandbox();
  try {
    await S.run(["status"]); // creates the data dir and DB
    writeFileSync(join(S.env.WXMP_HOME, "wxmp.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), cmd: "download" }));
    for (const args of [["refix"], ["import", W("world.json")]]) {
      const r = await S.run(args);
      assert.equal(r.code, 1, r.all);
      assert.match(r.err, /另一个 wxmp 正在使用这个数据目录/);
    }
    rmSync(join(S.env.WXMP_HOME, "wxmp.lock"));
    const st = await S.run(["status", "--account", "MP_WXS_123456"]);
    assert.equal(st.code, 1);
    assert.match(st.out, /库里没有这个号/);
    for (const args of [["watch", "ls", "--name", "x"], ["search", "article", "示例", "--refresh"], ["download", "MP_WXS_1002_ok0001", "--account", "MP_WXS_1002"]]) {
      const r = await S.run(args);
      assert.equal(r.code, 1, `${args.join(" ")} → ${r.all}`);
      assert.match(r.err, /^参数错误：/);
    }
    mkdirSync(join(S.env.WXMP_HOME, "wxmp.lock"));
    const l = await S.run(["download", ...DL]);
    assert.equal(l.code, 1);
    assert.match(l.err, /锁文件的位置被一个目录占用/);
    assert.doesNotMatch(l.err, /已有任务在运行/);
  } finally {
    S.cleanup();
  }
});

test("unexplained errors with alternating codes still stop a batch after three", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1001"]);
    await S.run(["sync", ...FAST]);
    const fake = join(S.dir, "fake.mjs");
    writeFileSync(fake, FAKE_ALT);
    const r = await S.run(["download", "--limit", "6", ...DL], { WXMP_WEREAD_CLI: fake, FAKE_COUNTER: join(S.dir, "n.txt") });
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /已停止（download）：微信读书接口连续 3 篇返回无法识别的错误/);
    assert.equal((r.out.match(/^\[\d+\/6\]/gm) || []).length, 3);
    assert.match(r.out, /下载结果：失败 3 篇/, "the finished part is summarized before stopping");
  } finally {
    S.cleanup();
  }
});

test("a stop inside fetch names fetch", async () => {
  const S = sandbox();
  try {
    const urls = [];
    for (const n of [0, 1, 2, 3]) urls.push((await S.mock(["review", "single", `MP_WXS_1001_gen${pad4(n)}`])).review.mpInfo.doc_url);
    const r = await S.run(["fetch", ...urls, ...DL], { WXMP_MOCK_FAIL: "-2001", WXMP_MOCK_FAIL_ON: "read-article" });
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /已停止（fetch）/);
  } finally {
    S.cleanup();
  }
});

test("a read-only database stops a download before any request is made or any file replaced", async () => {
  const S = sandbox();
  try {
    const row = await downloaded(S);
    const md = readFileSync(S.file(row.md_path), "utf8");
    const dbPath = join(S.env.WXMP_HOME, "wxmp.db");
    const before = S.calls().length;
    chmodSync(dbPath, 0o444);
    try {
      const r = await S.run(["download", "MP_WXS_1002_ok0001", "--force", ...DL], { WXMP_MOCK_WORLD: W("world-thin.json") });
      assert.equal(r.code, 1, r.all);
      assert.match(r.err, /数据库是只读的/);
      assert.equal(S.calls().length, before, "no request was made");
      assert.equal(readFileSync(S.file(row.md_path), "utf8"), md, "the Markdown is untouched");
    } finally {
      chmodSync(dbPath, 0o644);
    }
  } finally {
    S.cleanup();
  }
});

test("path conflicts name the file that is in the way; --account rejects an article ID", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    writeFileSync(join(S.env.WXMP_HOME, "articles"), "a file where the articles folder should be");
    const r = await S.run(["download", "MP_WXS_1002_ok0001", ...DL]);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /路径冲突：.*[\\/]articles 是一个文件/);
    const a = await S.run(["list", "--account", "MP_WXS_1002_ok0001"]);
    assert.equal(a.code, 1);
    assert.match(a.err, /是文章 ID/);
  } finally {
    S.cleanup();
  }
});

test("search account says when only part of the results is shown", async () => {
  const S = sandbox();
  try {
    const r = await S.run(["search", "account", "示例", "--top", "1"]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /这里显示前 1 个（--top 可调）/);
  } finally {
    S.cleanup();
  }
});

test("known per-article errors in between do not keep an unexplained run going", async () => {
  const S = sandbox();
  try {
    const env = await withFake(S, "9001,-2013,9002,-2003,9003,9004");
    const r = await S.run(["download", "--limit", "6", ...DL], env);
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /连续 3 篇返回无法识别的错误/);
    assert.equal((r.out.match(/^\[\d+\/6\]/gm) || []).length, 5, "stopped at the third unexplained error");
  } finally {
    S.cleanup();
  }
});

test("a batch stopped by risk control part-way first says what it finished", async () => {
  const S = sandbox();
  try {
    const env = await withFake(S, "ok,-2041");
    const r = await S.run(["download", "--limit", "3", ...DL], env);
    assert.equal(r.code, 2, r.all);
    assert.match(r.out, /下载结果：成功 1 篇（第 2 篇处中断）/);
    assert.match(r.err, /人机验证/);
  } finally {
    S.cleanup();
  }
});

test("search account from the cache also says when only part of it is shown", async () => {
  const S = sandbox();
  try {
    await S.run(["search", "account", "示例"]);
    const r = await S.run(["search", "account", "示例", "--top", "1"]);
    assert.match(r.out, /缓存.*这里显示前 1 个（--top 可调）/);
  } finally {
    S.cleanup();
  }
});

test("the release packer checks every shipped file and file name", async () => {
  const S = sandbox();
  try {
    const pkg = join(S.dir, "pkg");
    for (const f of ["SKILL.md", "README.md", "CHANGELOG.md", "LICENSE", "package.json", ".gitignore", ".gitattributes", "wxmp", "wxmp.cmd", "scripts", "tests"]) {
      cpSync(join(ROOT, f), join(pkg, f), { recursive: true });
    }
    const pack = () => spawnSync(process.execPath, [join(pkg, "scripts", "package-release.mjs"), join(S.dir, "out")], { encoding: "utf8" });
    appendFileSync(join(pkg, ".gitattributes"), `# ${homedir()}\n`);
    const a = pack();
    assert.notEqual(a.status, 0, "a home path in .gitattributes is refused");
    assert.match(a.stderr, /\.gitattributes/);
    writeFileSync(join(pkg, ".gitattributes"), readFileSync(join(ROOT, ".gitattributes")));
    const user = userInfo().username;
    if (user.length > 2) {
      mkdirSync(join(pkg, "tests", "fixtures"), { recursive: true });
      const named = join(pkg, "tests", "fixtures", `${user}-notes.csv`);
      writeFileSync(named, "a,b\n");
      const b = pack();
      assert.notEqual(b.status, 0, "a user name in a file name is refused");
      assert.match(b.stderr, /\(file name\)/);
      rmSync(named);
      const wide = join(pkg, "tests", "fixtures", "notes16.txt");
      writeFileSync(wide, Buffer.from(`owner ${user}\n`, "utf16le"));
      const c = pack();
      assert.notEqual(c.status, 0, "a user name in a UTF-16 file is refused");
      assert.match(c.stderr, /notes16\.txt \(UTF-16\)/);
      rmSync(wide);
    }
    // Windows often spells the user folder in its 8.3 short form inside the temp path
    const short = tmpdir().split(/[\\/]+/).find((s) => /~\d/.test(s));
    if (short && /^[a-z]:[\\/]+users[\\/]+/i.test(tmpdir())) {
      writeFileSync(join(pkg, "tests", "fixtures", "short.txt"), `see ${short} notes\n`);
      const d = pack();
      assert.notEqual(d.status, 0, "the 8.3 short name of the user folder is refused");
      assert.match(d.stderr, /short\.txt/);
    }
  } finally {
    S.cleanup();
  }
});

test("fetch that stops while resolving links lists the ones it already resolved", async () => {
  const S = sandbox();
  try {
    const fake = join(S.dir, "fake.mjs");
    writeFileSync(fake, FAKE_RESOLVE);
    const env = { WXMP_WEREAD_CLI: fake, FAKE_COUNTER: join(S.dir, "n.txt"), FAKE_SEQ: "ok,9001,9002,9003" };
    const urls = [1, 2, 3, 4].map((n) => `https://mp.weixin.qq.com/s?__biz=MTAwMQ==&mid=${n}&idx=1&sn=s${n}`);
    const r = await S.run(["fetch", ...urls, ...DL], env);
    assert.equal(r.code, 2, r.all);
    assert.match(r.out, /停下前已解析好 1 个链接，还没下载；问题解决后运行：wxmp download MP_WXS_1001_r0/);
    assert.match(r.err, /已停止（fetch）/);
  } finally {
    S.cleanup();
  }
});

test("names of built-in object properties are unknown commands, and nothing is created for them", async () => {
  const S = sandbox();
  try {
    for (const cmd of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const r = await S.run([cmd]);
      assert.equal(r.code, 1, `${cmd}: ${r.all}`);
      assert.match(r.err, new RegExp(`未知命令：${cmd.replace(/_/g, "_")}`), cmd);
    }
    assert.equal((await S.run(["constructor", "--top", "3"])).code, 1);
    assert.equal(existsSync(join(S.env.WXMP_HOME, "wxmp.db")), false, "no data dir work for an unknown command");
  } finally {
    S.cleanup();
  }
});

test("sync refuses the download options without --download instead of ignoring them", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1001"]);
    for (const extra of [["--limit", "1"], ["--images"], ["--force"]]) {
      const r = await S.run(["sync", ...extra, ...FAST]);
      assert.equal(r.code, 1, r.all);
      assert.match(r.err, new RegExp(`${extra[0]}.*只在加了 --download 时有用`));
    }
    assert.equal(S.calls().length, 0, "nothing was requested");
    const ok = await S.run(["sync", "--download", "--limit", "1", ...FAST]);
    assert.equal(ok.code, 0, ok.all);
  } finally {
    S.cleanup();
  }
});

test("fetch says a link cut at its first & is incomplete, without asking WeRead", async () => {
  const S = sandbox();
  try {
    const r = await S.run(["fetch", "https://mp.weixin.qq.com/s?__biz=MTAwMQ==", ...DL]);
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /链接不完整/);
    assert.match(r.out, /node scripts\/wxmp\.mjs fetch/);
    assert.equal(S.calls().length, 0);
  } finally {
    S.cleanup();
  }
});
