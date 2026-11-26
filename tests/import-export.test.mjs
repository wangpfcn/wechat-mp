// import (weread-omni JSON and export folders) and export (CSV).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sandbox, TESTS } from "./helpers.mjs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const FAST = ["--delay", "0", "--page-delay", "0"]; // sync
const DL = ["--delay", "0"]; // download, fetch (no paging)
const one = (S, sql, ...p) => S.q(sql, ...p)[0];
const W = (name) => join(TESTS, "fixtures", name);
const { fragmentToMarkdown } = await import("../scripts/lib/extract.mjs");
const md = async (html) => (await fragmentToMarkdown(`<div id="js_content">${html}</div>`)).markdown;
async function downloaded(S, id = "MP_WXS_1002_ok0001", extra = {}) {
  await S.run(["watch", "add", id.slice(0, 11)], extra);
  await S.run(["sync", ...FAST], extra);
  const r = await S.run(["download", id, ...DL], extra);
  assert.equal(r.code, 0, r.all);
  return one(S, "select status, body_chars, md_path, pub_time, doc_url, title from articles where review_id=?", id);
}
const ID = "MP_WXS_1002_ok0001";
const OLD_TITLE = "示例快讯：工具只拿到标题";

test("import: null and malformed JSON are skipped, re-import does not duplicate searches, stale files are removed", async () => {
  const S = sandbox();
  try {
    writeFileSync(join(S.dir, "null.json"), "null");
    const s2 = await S.mock(["search", "books", "示例", "--scope", "2"]);
    writeFileSync(join(S.dir, "s2.json"), JSON.stringify(s2));
    writeFileSync(join(S.dir, "bad.json"), JSON.stringify({ reviewId: "MP_WXS_1001_gen0005", sourceSha256: "0000" }));
    const r = await S.run(["import", join(S.dir, "null.json"), join(S.dir, "s2.json"), join(S.dir, "bad.json")]);
    assert.equal(r.code, 1, "two of three files skipped → exit 1");
    assert.match(r.out, /null\.json.*认不出|跳过（认不出的 JSON）/);
    assert.match(r.out, /公众号搜索「示例」/);
    assert.match(r.out, /找不到原始网页缓存/);
    assert.doesNotMatch(r.out, /undefined/);
    await S.run(["import", join(S.dir, "s2.json")]);
    assert.equal(S.q("select count(*) n from searches")[0].n, 1, "identical search import is not logged twice");
    const none = await S.run(["import", join(S.dir, "null.json")]);
    assert.equal(none.code, 1, "nothing importable → exit 1");

    // same article, publish date moves → only one Markdown file remains
    const rv = await S.mock(["review", "single", "MP_WXS_1002_ok0001"]);
    const ra = await S.mock(["public-accounts", "read-article", rv.review.mpInfo.doc_url]);
    writeFileSync(join(S.dir, "ra1.json"), JSON.stringify({ ...ra, publishedAt: "2026-11-05T15:59:59.000Z" }));
    writeFileSync(join(S.dir, "ra2.json"), JSON.stringify({ ...ra, publishedAt: "2026-11-06T02:00:00.000Z" }));
    await S.run(["import", join(S.dir, "ra1.json")]);
    await S.run(["import", join(S.dir, "ra2.json")]);
    const files = readdirSync(join(S.env.WXMP_HOME, "articles", "示例新闻社")).filter((f) => f.endsWith(".md"));
    assert.equal(files.length, 1, files.join(", "));
    assert.ok(files[0].startsWith("2026-11-06_"));
  } finally {
    S.cleanup();
  }
});

test("--since means the same thing in list, export and download; CSV paths use forward slashes", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    await S.run(["download", "--account", "MP_WXS_1002", ...DL]);
    // The fixture's articles are 0.5 to 5 hours old. The date six hours ago (Beijing time) is on or
    // before every one of them at any time of day; the current date leaves none just after midnight.
    const since = new Date(Date.now() + 8 * 3600_000 - 6 * 3600_000).toISOString().slice(0, 10);
    const listed = (await S.run(["list", "--since", since, "--top", "100"])).out.split("\n").filter((x) => /^\d{4}-\d{2}-\d{2} /.test(x)).length;
    const out = join(S.dir, "s.csv");
    await S.run(["export", "--since", since, "--out", out]);
    const csv = readFileSync(out, "utf8").split("\r\n").filter(Boolean);
    assert.equal(csv.length - 1, listed);
    const local = csv.slice(1).map((l) => l.split('","')[8]).find(Boolean);
    assert.ok(local && local.includes("/") && !local.includes("\\"), local);
  } finally {
    S.cleanup();
  }
});

test("imported search results never serve as the search cache", async () => {
  const S = sandbox();
  try {
    const s = await S.mock(["search", "books", "示例", "--scope", "2"]);
    writeFileSync(join(S.dir, "s.json"), JSON.stringify(s));
    await S.run(["import", join(S.dir, "s.json")]);
    const before = S.calls().length;
    const r = await S.run(["search", "account", "示例"]);
    assert.doesNotMatch(r.out, /缓存/);
    assert.equal(S.calls().length, before + 1);
  } finally {
    S.cleanup();
  }
});

test("an import rejected as worse leaves the stored title alone", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    await S.run(["download", "MP_WXS_1002_ok0001", ...DL]);
    const title = one(S, "select title from articles where review_id='MP_WXS_1002_ok0001'").title;
    writeFileSync(join(S.dir, "thin.json"), JSON.stringify({ reviewId: "MP_WXS_1002_ok0001", sourceSha256: "f".repeat(64), title: "完全不同的标题", markdown: "## 标题\n\n只有一行" }));
    const r = await S.run(["import", join(S.dir, "thin.json")]);
    assert.match(r.out, /保留已有版本/);
    assert.equal(one(S, "select title from articles where review_id='MP_WXS_1002_ok0001'").title, title);
  } finally {
    S.cleanup();
  }
});

test("CSV: line breaks in titles become spaces; formula-like cells after spaces are guarded", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: W("world-csv.json") });
  try {
    await S.run(["sync", "--account", "MP_WXS_5001", ...FAST]);
    const file = join(S.dir, "t.csv");
    const r = await S.run(["export", "--out", file]);
    assert.equal(r.code, 0, r.all);
    const text = readFileSync(file, "utf8");
    assert.equal(text.split("\r\n").filter(Boolean).length, 5, "header + 4 records, one line each");
    assert.match(text, /"第一行 第二行"/);
    assert.match(text, /"甲 乙"/, "a Unicode line separator also becomes a space");
    assert.match(text, /"丙 丁"/, "so does NEL");
    assert.match(text, /"'  =SUM\(1,2\)"/);
  } finally {
    S.cleanup();
  }
});

test("an export-directory import rejected as worse leaves publish time and link alone", async () => {
  const S = sandbox();
  try {
    const row = await downloaded(S);
    const ex = join(S.dir, "export");
    const item = join(ex, "review-MP_WXS_1002_ok0001");
    mkdirSync(item, { recursive: true });
    writeFileSync(join(item, "article.md"), "# short");
    writeFileSync(join(item, "mp-info.json"), JSON.stringify({ title: "完全不同的标题", mp_name: "示例新闻社", time: 1600000000, doc_url: "https://mp.weixin.qq.com/s?__biz=MTAwMg==&mid=999" }));
    writeFileSync(join(item, "metadata.json"), JSON.stringify({ accountId: "MP_WXS_1002", article: { reviewId: "MP_WXS_1002_ok0001", createTime: 1600000100 } }));
    writeFileSync(join(ex, "manifest.json"), JSON.stringify({ version: 1, accountId: "MP_WXS_1002", createdAt: "2026-11-06T23:35:26.324Z", items: [{ accountId: "MP_WXS_1002", reviewId: "MP_WXS_1002_ok0001", state: "complete", directory: "review-MP_WXS_1002_ok0001", sourceUrl: "https://mp.weixin.qq.com/s?__biz=MTAwMg==&mid=999" }] }));
    const r = await S.run(["import", ex]);
    assert.match(r.out, /保留已有版本/);
    const after = one(S, "select status, body_chars, md_path, pub_time, doc_url, title from articles where review_id='MP_WXS_1002_ok0001'");
    assert.deepEqual({ ...after }, { ...row });
  } finally {
    S.cleanup();
  }
});

test("importing article info leaves a downloaded article's fields alone and only fills missing ones", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    assert.equal((await S.run(["download", ID, ...DL])).code, 0);
    const db = new DatabaseSync(join(S.env.WXMP_HOME, "wxmp.db"));
    db.prepare("update articles set pub_time = null where review_id=?").run(ID);
    db.close();
    const before = one(S, "select title, doc_url, md_path from articles where review_id=?", ID);
    const meta = spawnSync(process.execPath, [join(TESTS, "mock-weread.mjs"), "review", "single", ID, "--json"], {
      env: { ...process.env, ...S.env, WXMP_MOCK_WORLD: W("world-thin-renamed.json") },
      encoding: "utf8",
    });
    assert.equal(meta.status, 0, meta.stderr);
    const file = join(S.dir, "meta.json");
    const j = JSON.parse(meta.stdout);
    j.review.mpInfo.doc_url = `${j.review.mpInfo.doc_url}&changed=1`;
    writeFileSync(file, JSON.stringify(j));
    const r = await S.run(["import", file]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, new RegExp(`文章元数据 ${OLD_TITLE}（本地已有下载版本，标题、时间、链接沿用它的）`), "says what is kept");
    const after = one(S, "select title, doc_url, pub_time, md_path from articles where review_id=?", ID);
    assert.equal(after.title, before.title, "title kept");
    assert.equal(after.doc_url, before.doc_url, "link kept");
    assert.ok(after.pub_time, "the missing publish time is filled in");
    assert.equal(after.md_path, before.md_path);
  } finally {
    S.cleanup();
  }
});

test("importing an export folder exits 1 when one of its articles keeps the local copy", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    await S.run(["download", "MP_WXS_1002_ok0001", ...DL]);
    const ex = join(S.dir, "export");
    const item = (reviewId, title, md) => {
      const d = join(ex, `review-${reviewId}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "article.md"), md);
      writeFileSync(join(d, "mp-info.json"), JSON.stringify({ title, mp_name: "示例新闻社", time: 1790000000 }));
      writeFileSync(join(d, "metadata.json"), JSON.stringify({ accountId: "MP_WXS_1002", article: { reviewId, createTime: 1790000100 } }));
      return { accountId: "MP_WXS_1002", reviewId, state: "complete", directory: `review-${reviewId}` };
    };
    const items = [item("MP_WXS_1002_ok0001", "已下载的文章", "# short"), item("MP_WXS_1002_new0001", "新文章", `# 新文章\n\n${"正文内容。".repeat(60)}`)];
    writeFileSync(join(ex, "manifest.json"), JSON.stringify({ version: 1, accountId: "MP_WXS_1002", createdAt: "2026-11-06T23:35:26.324Z", items }));
    const r = await S.run(["import", ex]);
    assert.match(r.out, /保留已有版本/);
    assert.match(r.out, /导入 1 篇，1 篇没有导入/);
    assert.equal(r.code, 1, r.all);
  } finally {
    S.cleanup();
  }
});
