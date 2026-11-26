// End-to-end tests through the mock weread CLI. Offline; every test uses a throw-away sandbox.
// Run: node --test tests/
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sandbox, imageServer, bjText } from "./helpers.mjs";
import { ridTag } from "../scripts/lib/util.mjs";

const FAST = ["--delay", "0", "--page-delay", "0"]; // sync
const DL = ["--delay", "0"]; // download, fetch (no paging)
let S;
let img;
before(async () => {
  img = await imageServer();
  S = sandbox({ WXMP_MOCK_PORT: String(img.port) });
});
after(async () => {
  await img.close();
  S.cleanup();
});
const fm = (md, key) => md.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1];
const statusOf = (rid) => S.q("select status from articles where review_id=?", rid)[0]?.status;

test("help, version and doctor work against the mock", async () => {
  const h = await S.run(["help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /search account/);
  assert.match((await S.run(["--version"])).out, /^wxmp \d+\.\d+\.\d+/);
  const d = await S.run(["doctor"]);
  assert.equal(d.code, 0, d.all);
  assert.match(d.out, /\[ OK \] 微信读书连接/);
  assert.match(d.out, /\[ OK \] 正文转换/);
  const bad = await S.run(["doctor"], { WXMP_MOCK_FAIL: "AUTH" });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /\[FAIL\] 微信读书连接.*wxmp login/);
});

test("search account: live, then cached, then --refresh", async () => {
  const r1 = await S.run(["search", "account", "示例"]);
  assert.equal(r1.code, 0, r1.all);
  assert.match(r1.out, /MP_WXS_1001\s+示例研究所/);
  assert.match(r1.out, /MP_WXS_1002\s+示例新闻社/);
  const n = S.calls().length;
  const r2 = await S.run(["search", "account", "示例"]);
  assert.match(r2.out, /缓存：北京时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.equal(S.calls().length, n, "cached search must not call weread");
  await S.run(["search", "account", "示例", "--refresh"]);
  assert.equal(S.calls().length, n + 1);
});

test("search article stores hits with abstracts and hints at more pages", async () => {
  const r = await S.run(["search", "article", "周报"]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /共 120 个结果，这里显示前 10 个（--top 可调）（还有更多：--max-idx 20）/);
  const rows = S.q("select count(*) n from articles where abstract like '%摘要'");
  assert.equal(rows[0].n, 20);
});

test("watch: add by ID and by article URL, list, ambiguous names rejected", async () => {
  assert.equal((await S.run(["watch", "add", "MP_WXS_1001"])).code, 0);
  const viaUrl = await S.run(["watch", "add", "https://mp.weixin.qq.com/s?__biz=MTAwMg==&mid=1&idx=1"]);
  assert.match(viaUrl.out, /已关注 MP_WXS_1002/);
  const ls = await S.run(["watch", "ls"]);
  assert.match(ls.out, /MP_WXS_1001/);
  assert.match(ls.out, /MP_WXS_1002/);
  assert.equal((await S.run(["watch", "add", "not-an-id"])).code, 1);
  await S.run(["search", "account", "同名号"]);
  const amb = await S.run(["list", "--account", "同名号"]);
  assert.equal(amb.code, 1);
  assert.match(amb.err, /有 2 个号叫「同名号」/);
  const byName = await S.run(["list", "--account", "示例研究所", "--top", "1"]);
  assert.equal(byName.code, 0, byName.all);
  const none = await S.run(["list", "--account", "不存在的号"]);
  assert.equal(none.code, 1);
});

test("sync: 30-day window, paging stops at the cutoff, second sync finds nothing", async () => {
  const before = S.calls().length;
  const r = await S.run(["sync", ...FAST]);
  assert.equal(r.code, 0, r.all);
  const listCalls = S.calls().slice(before).filter((c) => c[1] === "articles");
  assert.equal(listCalls.filter((c) => c[2] === "MP_WXS_1001").length, 2, "1001 needs 2 pages to reach the 30-day cutoff");
  assert.equal(listCalls.filter((c) => c[2] === "MP_WXS_1002").length, 2, "1002's 10 articles fit in one short page; the empty page after it confirms the end");
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  const n1001 = S.q("select count(*) n from articles where account_id='MP_WXS_1001' and list_time>=?", cutoff)[0].n;
  assert.ok(n1001 >= 61 && n1001 <= 62, `expected 62 articles within 30 days, got ${n1001}`);
  assert.equal(S.q("select count(*) n from articles where account_id='MP_WXS_1002'")[0].n, 10);
  const again = await S.run(["sync", ...FAST]);
  assert.match(again.out, /示例研究所\s+新增 0 篇（翻了 1 页/);
  assert.match(again.out, /示例新闻社\s+新增 0 篇（翻了 1 页/);
});

test("sync --since with --max-pages stops at the page cap", async () => {
  const before = S.calls().length;
  const r = await S.run(["sync", "--account", "MP_WXS_1001", "--since", "2020-01-01", "--max-pages", "3", ...FAST]);
  assert.equal(r.code, 0, r.all);
  const pages = S.calls().slice(before).filter((c) => c[1] === "articles").length;
  assert.equal(pages, 3);
  assert.equal(S.q("select count(*) n from articles where account_id='MP_WXS_1001'")[0].n, 122);
});

test("download: every status lands where it should and the run continues past per-article failures", async () => {
  const r = await S.run(["download", "--account", "示例新闻社", ...DL]);
  assert.equal(r.code, 1, "some articles failed → exit 1");
  const expect = {
    MP_WXS_1002_ok0001: "fixed",
    MP_WXS_1002_images1: "fixed",
    MP_WXS_1002_short01: "short",
    MP_WXS_1002_nocont1: "ok",
    MP_WXS_1002_entity1: "ok",
    MP_WXS_1002_weird01: "ok",
    MP_WXS_1002_weird02: "ok",
    MP_WXS_1002_insuf01: "failed",
    MP_WXS_1002_nourl01: "failed",
    MP_WXS_1002_ent2013: "failed",
  };
  for (const [rid, st] of Object.entries(expect)) assert.equal(statusOf(rid), st, rid);
  assert.match(S.q("select error from articles where review_id='MP_WXS_1002_ent2013'")[0].error, /无权限/);
  assert.match(S.q("select error from articles where review_id='MP_WXS_1002_nourl01'")[0].error, /原文链接/);
});

test("article files: body recovered, Beijing times in the header, safe file names", async () => {
  const row = S.q("select * from articles where review_id='MP_WXS_1002_ok0001'")[0];
  const md = readFileSync(S.file(row.md_path), "utf8");
  assert.match(md, /第一部分/);
  assert.match(md, /第四部分/);
  assert.doesNotMatch(md, /预览时标签不可点|不喜欢/);
  assert.equal(fm(md, "published"), `${bjText(row.pub_time)} (北京时间)`);
  assert.match(fm(md, "fetched"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(北京时间\)$/);
  assert.match(row.fetched_at, /\+08:00$/);
  const files = readdirSync(join(S.env.WXMP_HOME, "articles", "示例新闻社")).filter((f) => f.endsWith(".md"));
  for (const f of files) assert.doesNotMatch(f, /[<>:"/\\|?*]/, f);
  assert.ok(files.some((f) => f.endsWith(`__CON_${ridTag("MP_WXS_1002_weird01")}.md`)), "reserved name CON must be prefixed");
  const long = files.find((f) => f.includes("标题里有非法字符"));
  assert.ok(long && [...long].length < 90, long);
  const ent = readFileSync(S.file(S.q("select md_path from articles where review_id='MP_WXS_1002_entity1'")[0].md_path), "utf8");
  assert.match(ent, /“引号”/);
  assert.match(ent, /中文/);
  assert.doesNotMatch(ent, /&ldquo;|&#x4e2d;/);
  assert.ok(ent.includes("\\<尖括号>"), "a literal < is escaped so renderers do not eat it as a tag");
});

test("images: --images saves each unique picture once and refix keeps local links", async () => {
  const hitsBefore = img.hits();
  const r = await S.run(["download", "--review", "MP_WXS_1002_images1", "--images", ...DL]);
  assert.equal(r.code, 0, r.all);
  assert.equal(img.hits() - hitsBefore, 2, "two unique image URLs");
  const row = S.q("select md_path, images from articles where review_id='MP_WXS_1002_images1'")[0];
  assert.equal(row.images, 3);
  let md = readFileSync(S.file(row.md_path), "utf8");
  assert.equal((md.match(/\]\(assets\//g) || []).length, 3);
  const assets = readdirSync(join(S.env.WXMP_HOME, "articles", "示例新闻社", "assets"));
  assert.equal(assets.length, 2);
  assert.ok(assets.some((a) => a.endsWith(".png")) && assets.some((a) => a.endsWith(".jpg")));
  await S.run(["refix", "--review", "MP_WXS_1002_images1"]);
  md = readFileSync(S.file(row.md_path), "utf8");
  assert.equal((md.match(/\]\(assets\//g) || []).length, 3, "refix without --images keeps local links");
  assert.equal(img.hits() - hitsBefore, 2, "refix is offline");
});

test("partial and table articles", async () => {
  await S.run(["download", "--review", "MP_WXS_1001_paid001", "--review", "MP_WXS_1001_table01", ...DL]);
  assert.equal(statusOf("MP_WXS_1001_paid001"), "partial");
  const md = readFileSync(S.file(S.q("select md_path from articles where review_id='MP_WXS_1001_table01'")[0].md_path), "utf8");
  assert.match(md, /\| 指标 \| 数值 \|/);
  assert.match(md, /\| 均值 \| 3\.14 \|/);
});

test("risk control stops the run with exit 2 and leaves articles untouched", async () => {
  for (const [fail, hint] of [["-2041", /人机验证/], ["-2010", /限流/], ["CHALLENGE", /反爬|验证/]]) {
    const r = await S.run(["download", "--account", "MP_WXS_1001", "--limit", "3", ...DL], { WXMP_MOCK_FAIL: fail, WXMP_MOCK_FAIL_ON: "read-article" });
    assert.equal(r.code, 2, `${fail}: ${r.all}`);
    assert.match(r.err, /已停止/);
    assert.match(r.err, hint);
  }
  assert.equal(S.q("select count(*) n from articles where account_id='MP_WXS_1001' and status='failed'")[0].n, 0);
  const auth = await S.run(["sync", ...FAST], { WXMP_MOCK_FAIL: "AUTH" });
  assert.equal(auth.code, 2);
  assert.match(auth.err, /wxmp login/);
  const s = await S.run(["search", "account", "全新关键词"], { WXMP_MOCK_FAIL: "-2041" });
  assert.equal(s.code, 2);
  assert.match(s.err, /人机验证/);
});

test("broken or hanging weread output fails cleanly", async () => {
  const g = await S.run(["search", "article", "周报"], { WXMP_MOCK_FAIL: "GARBAGE" });
  assert.equal(g.code, 2, "a broken weread-omni stops the run");
  assert.match(g.err, /输出格式不对：返回的不是完整的 JSON/);
  assert.doesNotMatch(g.err, /this is not json/, "the raw output is not echoed");
  const h = await S.run(["search", "article", "周报"], { WXMP_MOCK_FAIL: "HANG", WXMP_TIMEOUT_MS: "2000" });
  assert.equal(h.code, 2);
  assert.match(h.err, /没有响应/);
  const missing = await S.run(["search", "article", "周报"], { WXMP_WEREAD_CLI: join(S.dir, "nope.mjs") });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /不存在/);
  assert.match(missing.err, /WXMP_WEREAD_CLI/, "the hint names the env var that was set");
});

test("fetch by URL, skip non-article links, report unknown articles", async () => {
  const rv = await S.mock(["review", "single", "MP_WXS_1001_gen0005"]);
  const url = rv.review.mpInfo.doc_url;
  const r = await S.run(["fetch", url, "https://example.com/x", "https://mp.weixin.qq.com/s?__biz=MTAwMQ==&mid=99999&idx=1&sn=0", ...DL]);
  assert.equal(r.code, 1, "two of the three links were not processed → exit 1");
  assert.match(r.out, /跳过（不是公众号文章链接，要以 https:\/\/mp\.weixin\.qq\.com\/s 开头）/);
  assert.match(r.out, /没有收录/);
  assert.equal(statusOf("MP_WXS_1001_gen0005"), "ok");
});

test("list, export and status", async () => {
  const l = await S.run(["list", "--account", "示例新闻社", "--top", "3"]);
  assert.equal(l.code, 0, l.all);
  const lines = l.out.trim().split("\n").filter((x) => /^\d{4}-\d{2}-\d{2} /.test(x));
  assert.equal(lines.length, 3);
  const times = lines.map((x) => x.slice(0, 16));
  assert.deepEqual([...times].sort().reverse(), times, "newest first");
  const out = join(S.dir, "x.csv");
  const e = await S.run(["export", "--account", "示例新闻社", "--out", out]);
  assert.equal(e.code, 0, e.all);
  const csv = readFileSync(out, "utf8");
  assert.equal(csv.charCodeAt(0), 0xfeff, "UTF-8 BOM for Excel");
  assert.match(csv.split("\r\n")[0], /"发布时间\(北京\)","收录时间\(北京\)","抓取时间\(北京\)"/);
  assert.ok(csv.endsWith("\r\n"), "every line ends with CRLF");
  assert.equal(csv.split("\r\n").filter(Boolean).length - 1, 10, "header + one row per article of the account");
  const st = await S.run(["status"]);
  assert.match(st.out, /时间均为北京时间/);
  assert.match(st.out, /示例新闻社/);
});

test("bad arguments are rejected with a message, not a stack trace", async () => {
  for (const args of [["list", "--limit", "abc"], ["list", "--since", "2026-02-30"], ["list", "--status", "done"], ["list", "--bogus"], ["nonsense"], ["search", "account"], ["search", "x", "y"], ["watch", "frob"]]) {
    const r = await S.run(args);
    assert.equal(r.code, 1, `${args.join(" ")} → ${r.all}`);
    assert.doesNotMatch(r.all, /at .*\.mjs:\d+/, `no stack trace for ${args.join(" ")}`);
  }
});

test("import: every weread-omni JSON kind and an export directory", async () => {
  const T = sandbox();
  try {
    const save = async (name, args) => {
      const j = await T.mock(args);
      writeFileSync(join(T.dir, name), JSON.stringify(j));
      return j;
    };
    await save("s.json", ["search", "books", "示例", "--scope", "2"]);
    await save("a.json", ["search", "books", "周报", "--scope", "4"]);
    await save("l.json", ["public-accounts", "articles", "MP_WXS_1002", "--count", "50"]);
    const rv = await save("r.json", ["review", "single", "MP_WXS_1002_ok0001"]);
    await save("ra.json", ["public-accounts", "read-article", rv.review.mpInfo.doc_url]);
    // a minimal export directory in weread-omni's layout
    const ex = join(T.dir, "export");
    const item = join(ex, "review-MP_WXS_1002_entity1");
    mkdirSync(item, { recursive: true });
    const html = readFileSync(join(import.meta.dirname, "fixtures", "html", "entities.html"), "utf8");
    writeFileSync(join(item, "source.html"), html);
    writeFileSync(join(item, "article.md"), "## 示例实体字符");
    writeFileSync(join(item, "mp-info.json"), JSON.stringify({ title: "示例实体字符", mp_name: "示例新闻社", time: 1793900000, doc_url: "https://mp.weixin.qq.com/s?__biz=MTAwMg==&mid=5", payType: 0 }));
    writeFileSync(join(item, "metadata.json"), JSON.stringify({ accountId: "MP_WXS_1002", article: { reviewId: "MP_WXS_1002_entity1", createTime: 1793900100 } }));
    writeFileSync(join(ex, "manifest.json"), JSON.stringify({ version: 1, accountId: "MP_WXS_1002", createdAt: "2026-11-06T23:35:26.324Z", items: [{ accountId: "MP_WXS_1002", reviewId: "MP_WXS_1002_entity1", state: "complete", directory: "review-MP_WXS_1002_entity1", sourceUrl: "https://mp.weixin.qq.com/s?__biz=MTAwMg==&mid=5" }] }));
    writeFileSync(join(T.dir, "junk.json"), '{"hello":1}');
    const files = ["s.json", "a.json", "l.json", "r.json", "ra.json", "junk.json", "missing.json"].map((f) => join(T.dir, f));
    const r = await T.run(["import", ...files, ex]);
    assert.equal(r.code, 1, "junk and missing files were not imported → exit 1");
    assert.match(r.out, /公众号搜索「示例」，2 条/);
    assert.match(r.out, /文章搜索「周报」，20 条/);
    assert.match(r.out, /文章列表 10 条/);
    assert.match(r.out, /正文 fixed/);
    assert.match(r.out, /认不出的 JSON/);
    assert.match(r.out, /不存在/);
    assert.match(r.out, /export 目录 export：导入 1 篇/);
    assert.equal(T.q("select status from articles where review_id='MP_WXS_1002_ok0001'")[0].status, "fixed");
    assert.equal(T.q("select fetched_at from articles where review_id='MP_WXS_1002_entity1'")[0].fetched_at, "2026-11-07T07:35:26+08:00");
    assert.equal(T.calls().length, 0, "import is offline");
  } finally {
    T.cleanup();
  }
});

test("data directory: ~/wechat-mp-data unless WXMP_HOME is set", async () => {
  const T = sandbox();
  try {
    const fakeHome = join(T.dir, "user");
    mkdirSync(fakeHome, { recursive: true });
    const re = (p) => new RegExp(`数据目录 ${p.replace(/\\/g, "\\\\")}`);
    const fresh = await T.run(["status"], { WXMP_HOME: "", USERPROFILE: fakeHome, HOME: fakeHome });
    assert.match(fresh.out, re(join(fakeHome, "wechat-mp-data")));
    const custom = join(T.dir, "elsewhere");
    const set = await T.run(["status"], { WXMP_HOME: custom, USERPROFILE: fakeHome, HOME: fakeHome });
    assert.match(set.out, re(custom));
  } finally {
    T.cleanup();
  }
});

test("the mock never wrote outside the sandbox", () => {
  const lib = join(S.env.WEREAD_LIBRARY_DIR, "blobs", "sha256");
  assert.ok(existsSync(lib));
  const blobs = readdirSync(lib).flatMap((d) => readdirSync(join(lib, d)).map((f) => join(lib, d, f)));
  for (const b of blobs) assert.equal(createHash("sha256").update(readFileSync(b)).digest("hex"), b.split(/[\\/]/).pop());
});
