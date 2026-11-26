// download, fetch and refix: what gets stored, when a local copy is kept, files and pictures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, readdirSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox, TESTS, imageServer } from "./helpers.mjs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const FAST = ["--delay", "0", "--page-delay", "0"]; // sync
const DL = ["--delay", "0"]; // download, fetch (no paging)
const EXTRA = join(TESTS, "fixtures", "world-extra.json");
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
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const leftovers = (dir) => {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.(tmp|bak)-\d+$/.test(e.name)) found.push(e.name);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
};
async function downloadedWithRaw(S, id = "MP_WXS_1002_ok0001") {
  await S.run(["watch", "add", id.slice(0, 11)]);
  await S.run(["sync", ...FAST]);
  const r = await S.run(["download", id, ...DL]);
  assert.equal(r.code, 0, r.all);
  return one(S, "select status, body_chars, md_path, raw_path, pub_time, doc_url, title from articles where review_id=?", id);
}
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

test("download --review with an unknown (well-formed) ID writes nothing", async () => {
  const S = sandbox();
  try {
    const r = await S.run(["download", "--review", "MP_WXS_1002_doesnotexist", ...DL]);
    assert.equal(r.code, 1);
    assert.match(r.out, /找不到/);
    assert.equal(S.q("select count(*) n from articles")[0].n, 0);
  } finally {
    S.cleanup();
  }
});

test("a transient failure on re-download keeps the good copy", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: EXTRA });
  try {
    await S.run(["sync", "--account", "MP_WXS_2001", ...FAST]);
    await S.run(["download", "--review", "MP_WXS_2001_okarticle", ...DL]);
    assert.equal(one(S, "select status from articles where review_id='MP_WXS_2001_okarticle'").status, "ok");
    const r = await S.run(["download", "--review", "MP_WXS_2001_okarticle", ...DL], { WXMP_MOCK_FAIL: "INSUFFICIENT", WXMP_MOCK_FAIL_ON: "read-article" });
    assert.match(r.out, /保留旧版/);
    assert.equal(one(S, "select status from articles where review_id='MP_WXS_2001_okarticle'").status, "ok");
  } finally {
    S.cleanup();
  }
});

test("pages that only mention 环境异常/完成验证 are not treated as a captcha; paid pages without a container are partial", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: EXTRA });
  try {
    await S.run(["sync", "--account", "MP_WXS_2001", ...FAST]);
    const r = await S.run(["download", "--account", "MP_WXS_2001", ...DL]);
    assert.equal(r.code, 0, r.all);
    assert.equal(one(S, "select status from articles where review_id='MP_WXS_2001_vmention1'").status, "ok");
    assert.equal(one(S, "select status from articles where review_id='MP_WXS_2001_paidnc01'").status, "partial");
    const md = readFileSync(S.file(one(S, "select md_path from articles where review_id='MP_WXS_2001_newline01'").md_path), "utf8");
    assert.match(md, /^# 标题换行 # 伪标题 \*x\*$/m, "a title with a newline stays one heading line");
    assert.doesNotMatch(md, /^# 伪标题/m);
  } finally {
    S.cleanup();
  }
});

test("refix leaves articles it cannot re-extract alone", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    await S.run(["download", "--account", "MP_WXS_1002", ...DL]);
    assert.equal(one(S, "select status from articles where review_id='MP_WXS_1002_nocont1'").status, "ok");
    const r = await S.run(["refix", "--account", "MP_WXS_1002"]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /保留\s+示例无正文容器/);
    assert.equal(one(S, "select status from articles where review_id='MP_WXS_1002_nocont1'").status, "ok");
    assert.doesNotMatch(r.out, /undefined/);
  } finally {
    S.cleanup();
  }
});

test("several article IDs: plain arguments, comma lists, and refix", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    const r = await S.run(["download", "MP_WXS_1002_ok0001", "MP_WXS_1002_entity1", ...DL]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /\[2\/2\]/);
    const c = await S.run(["download", "--review", "MP_WXS_1002_weird01,MP_WXS_1002_weird02", ...DL]);
    assert.match(c.out, /\[2\/2\]/);
    const f = await S.run(["refix", "MP_WXS_1002_ok0001", "MP_WXS_1002_entity1"]);
    assert.equal(f.code, 0, f.all);
    assert.match(f.out, /重新提取 2 篇/);
    assert.equal((await S.run(["download", "--review", ""])).code, 1);
  } finally {
    S.cleanup();
  }
});

test("a case-only title change keeps the article file", async () => {
  const S = sandbox();
  try {
    const rv = await S.mock(["review", "single", "MP_WXS_1002_ok0001"]);
    const ra = await S.mock(["public-accounts", "read-article", rv.review.mpInfo.doc_url]);
    writeFileSync(join(S.dir, "a.json"), JSON.stringify({ ...ra, title: "Case Test ABC" }));
    writeFileSync(join(S.dir, "b.json"), JSON.stringify({ ...ra, title: "case test abc" }));
    await S.run(["import", join(S.dir, "a.json")]);
    await S.run(["import", join(S.dir, "b.json")]);
    const row = one(S, "select md_path from articles where review_id='MP_WXS_1002_ok0001'");
    assert.ok(existsSync(S.file(row.md_path)), `${row.md_path} must exist`);
    const files = readdirSync(join(S.env.WXMP_HOME, "articles", "示例新闻社")).filter((x) => x.endsWith(".md"));
    assert.equal(files.length, 1, files.join(", "));
  } finally {
    S.cleanup();
  }
});

test("world-extra cases: formula-like titles, pictures of other articles, image-heavy, media, paid notes, export --out dir/", async () => {
  const S = sandbox({ WXMP_MOCK_WORLD: EXTRA });
  try {
    await S.run(["sync", "--account", "MP_WXS_2001", ...FAST]);
    // a picture that is not named after any article being downloaded
    const assets = join(S.env.WXMP_HOME, "articles", "回归测试号", "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "AAA123_01.png"), "someone else's picture");
    await S.run(["download", "--account", "MP_WXS_2001", ...DL]);
    assert.ok(existsSync(join(assets, "AAA123_01.png")), "a picture that belongs to another article is not adopted");
    const md = (rid) => readFileSync(S.file(one(S, "select md_path from articles where review_id=?", rid).md_path), "utf8");
    assert.match(md("MP_WXS_2001_imgheavy1"), /note: ".*以图片为主（6 张图）/);
    const media = md("MP_WXS_2001_media0001");
    assert.match(media, /【视频号视频：示例视频号】/);
    assert.match(media, /【视频：\[打开\]\(https:\/\/v\.qq\.com\/[^)\s]+\)】/, "the URL appears once, as the link target");
    assert.match(media, /【语音：示例语音】/);
    assert.match(media, /含 3 个视频\/语音/);
    assert.match(md("MP_WXS_2001_paidnc01"), /付费文章，只拿到试读部分/);
    mkdirSync(join(S.dir, "outdir"), { recursive: true });
    const e = await S.run(["export", "--account", "MP_WXS_2001", "--out", join(S.dir, "newdir") + "/"]);
    assert.equal(e.code, 0, e.all);
    const files = readdirSync(join(S.dir, "newdir"));
    assert.equal(files.length, 1);
    const csv = readFileSync(join(S.dir, "newdir", files[0]), "utf8");
    assert.match(csv, /"'=1\+1 看起来像公式的标题"/, "formula-like cells are neutralised");
    assert.match(csv.split("\r\n")[0], /"说明"$/);
  } finally {
    S.cleanup();
  }
});

test("a good local copy is not replaced by a thinner import or re-download unless --force", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    await S.run(["download", "MP_WXS_1002_ok0001", ...DL]);
    const good = one(S, "select status, body_chars from articles where review_id='MP_WXS_1002_ok0001'");
    assert.equal(good.status, "fixed");
    // an import that has only weread-omni's own (header-only) text
    writeFileSync(join(S.dir, "thin.json"), JSON.stringify({ reviewId: "MP_WXS_1002_ok0001", sourceSha256: "f".repeat(64), title: "示例快讯：工具只拿到标题", markdown: "## 示例快讯\n\n原创 示例新闻社" }));
    const imp = await S.run(["import", join(S.dir, "thin.json")]);
    assert.match(imp.out, /保留已有版本/);
    assert.equal(imp.code, 1);
    assert.deepEqual({ ...one(S, "select status, body_chars from articles where review_id='MP_WXS_1002_ok0001'") }, { ...good });
    // a re-download that comes back short
    const re = await S.run(["download", "MP_WXS_1002_ok0001", ...DL], { WXMP_MOCK_WORLD: W("world-thin.json") });
    assert.match(re.out, /保留旧版.*不如已有版本/);
    assert.equal(one(S, "select status from articles where review_id='MP_WXS_1002_ok0001'").status, "fixed");
    const forced = await S.run(["download", "MP_WXS_1002_ok0001", "--force", ...DL], { WXMP_MOCK_WORLD: W("world-thin.json") });
    assert.equal(forced.code, 0, forced.all);
    assert.equal(one(S, "select status from articles where review_id='MP_WXS_1002_ok0001'").status, "short");
  } finally {
    S.cleanup();
  }
});

test("download summary is in words, and a repeated image URL counts once when it fails", async () => {
  const S = sandbox({ WXMP_MOCK_PORT: "9" }); // nothing listens on port 9: every picture fails
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    const r = await S.run(["download", "MP_WXS_1002_images1", "--images", ...DL]);
    assert.match(r.out, /下载结果：成功 1 篇/);
    const md = readFileSync(S.file(one(S, "select md_path from articles where review_id='MP_WXS_1002_images1'").md_path), "utf8");
    assert.match(md, /2 张图下载失败/, "two distinct URLs, three references");
  } finally {
    S.cleanup();
  }
});

test("a re-download with no usable content keeps the good copy, even with --force", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    await S.run(["download", "MP_WXS_1002_ok0001", ...DL]);
    const before = { ...one(S, "select status, body_chars, md_path from articles where review_id='MP_WXS_1002_ok0001'") };
    assert.equal(before.status, "fixed");
    const r = await S.run(["download", "MP_WXS_1002_ok0001", "--force", ...DL], { WXMP_MOCK_WORLD: W("world-noblob.json"), WEREAD_LIBRARY_DIR: join(S.dir, "empty-library") });
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /保留旧版.*这次没有拿到可用的页面内容/);
    assert.deepEqual({ ...one(S, "select status, body_chars, md_path from articles where review_id='MP_WXS_1002_ok0001'") }, before);
  } finally {
    S.cleanup();
  }
});

test("--force with an unwritable raw folder changes nothing: Markdown, raw page and DB stay consistent", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    await S.run(["download", "MP_WXS_1002_ok0001", ...DL]);
    const row = one(S, "select status, md_path from articles where review_id='MP_WXS_1002_ok0001'");
    const md = readFileSync(S.file(row.md_path), "utf8");
    const rawDir = join(S.env.WXMP_HOME, "raw", "MP_WXS_1002");
    rmSync(rawDir, { recursive: true, force: true });
    writeFileSync(rawDir, "a file where the raw folder should be");
    const r = await S.run(["download", "MP_WXS_1002_ok0001", "--force", ...DL], { WXMP_MOCK_WORLD: W("world-thin.json") });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /路径冲突/);
    assert.equal(readFileSync(S.file(row.md_path), "utf8"), md, "the Markdown is untouched");
    assert.equal(one(S, "select status from articles where review_id='MP_WXS_1002_ok0001'").status, row.status);
  } finally {
    S.cleanup();
  }
});

test("refix says when it keeps the existing copy, and does not count it as re-extracted", async () => {
  const S = sandbox();
  try {
    await S.run(["watch", "add", "MP_WXS_1002"]);
    await S.run(["sync", ...FAST]);
    await S.run(["download", "MP_WXS_1002_ok0001", ...DL]);
    const db = new DatabaseSync(join(S.env.WXMP_HOME, "wxmp.db"));
    db.prepare("update articles set body_chars = 99999 where review_id='MP_WXS_1002_ok0001'").run();
    db.close();
    const r = await S.run(["refix", "MP_WXS_1002_ok0001"]);
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /保留旧版.*不如已有版本/);
    assert.match(r.out, /重新提取 0 篇，保留旧版 1 篇/);
    assert.doesNotMatch(r.out, /undefined/);
  } finally {
    S.cleanup();
  }
});

test("a re-download with --images that loses a picture keeps the copy whose pictures were all local", async () => {
  const img = await imageServer();
  const S = sandbox({ WXMP_MOCK_PORT: String(img.port) });
  try {
    const row = await downloaded(S, "MP_WXS_1002_images1");
    await S.run(["download", "MP_WXS_1002_images1", "--images", "--force", ...DL]);
    const mdPath = S.file(one(S, "select md_path from articles where review_id='MP_WXS_1002_images1'").md_path);
    const md = readFileSync(mdPath, "utf8");
    assert.ok(!/\]\(http/.test(md.split("---").slice(2).join("---")), "all pictures are local");
    const assets = join(mdPath, "..", "assets");
    rmSync(join(assets, readdirSync(assets)[0]));
    const r = await S.run(["download", "MP_WXS_1002_images1", "--images", ...DL], { WXMP_MOCK_PORT: "9" });
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /保留旧版.*张图没下载成功/);
    assert.equal(readFileSync(mdPath, "utf8"), md);
    assert.ok(row);
  } finally {
    S.cleanup();
    await img.close();
  }
});

test("refix says why it skips an article it has no stored page for", async () => {
  const S = sandbox();
  try {
    await downloaded(S);
    const raw = one(S, "select raw_path from articles where review_id='MP_WXS_1002_ok0001'").raw_path;
    rmSync(S.file(raw));
    const r = await S.run(["refix", "MP_WXS_1002_ok0001"], { WEREAD_LIBRARY_DIR: join(S.dir, "empty-library") });
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /没有存下原始页面/);
  } finally {
    S.cleanup();
  }
});

test("a rejected re-download leaves title, publish time and link alone", async () => {
  const S = sandbox();
  try {
    await downloadedWithRaw(S);
    // without these, the re-download asks review single again
    const db = new DatabaseSync(join(S.env.WXMP_HOME, "wxmp.db"));
    db.prepare("update articles set pub_time = null, doc_url = null where review_id='MP_WXS_1002_ok0001'").run();
    db.close();
    const before = { ...one(S, "select status, body_chars, md_path, pub_time, doc_url, title from articles where review_id='MP_WXS_1002_ok0001'") };
    const r = await S.run(["download", "MP_WXS_1002_ok0001", ...DL], { WXMP_MOCK_WORLD: W("world-thin-renamed.json") });
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /保留旧版/);
    assert.deepEqual({ ...one(S, "select status, body_chars, md_path, pub_time, doc_url, title from articles where review_id='MP_WXS_1002_ok0001'") }, before);
  } finally {
    S.cleanup();
  }
});

test("when the Markdown cannot be put in place, the raw page is put back too", async () => {
  const S = sandbox();
  try {
    const row = await downloadedWithRaw(S);
    const raw = S.file(row.raw_path);
    const rawHash = sha(raw);
    const md = S.file(row.md_path);
    rmSync(md);
    mkdirSync(md); // a folder where the Markdown file goes
    const r = await S.run(["download", "MP_WXS_1002_ok0001", "--force", ...DL], { WXMP_MOCK_WORLD: W("world-thin.json") });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /路径冲突/);
    assert.equal(sha(raw), rawHash, "the raw page is the old one again");
    assert.deepEqual(leftovers(S.env.WXMP_HOME), [], "no temp or backup files left");
    assert.equal(one(S, "select status from articles where review_id='MP_WXS_1002_ok0001'").status, row.status);
  } finally {
    S.cleanup();
  }
});

test("an accepted re-download takes the article's new title and renames its file", async () => {
  const S = sandbox();
  try {
    const row = await downloadedWithRaw(S);
    const db = new DatabaseSync(join(S.env.WXMP_HOME, "wxmp.db"));
    db.prepare("update articles set pub_time = null where review_id='MP_WXS_1002_ok0001'").run();
    db.close();
    const r = await S.run(["download", "MP_WXS_1002_ok0001", ...DL], { WXMP_MOCK_WORLD: W("world-retitled.json") });
    assert.equal(r.code, 0, r.all);
    const now = one(S, "select title, md_path, pub_time from articles where review_id='MP_WXS_1002_ok0001'");
    assert.equal(now.title, "示例快讯：标题改过了");
    assert.notEqual(now.md_path, row.md_path);
    assert.ok(now.pub_time, "publish time saved with the accepted download");
    assert.equal(existsSync(S.file(row.md_path)), false, "the file under the old title is gone");
    assert.match(readFileSync(S.file(now.md_path), "utf8"), /^title: "示例快讯：标题改过了"$/m);
    assert.deepEqual(leftovers(S.env.WXMP_HOME), []);
  } finally {
    S.cleanup();
  }
});

test("a rejected fetch leaves the stored link alone", async () => {
  const S = sandbox();
  try {
    const row = await downloadedWithRaw(S);
    const r = await S.run(["fetch", `${row.doc_url}#rd`, ...DL], { WXMP_MOCK_WORLD: W("world-thin.json") });
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /保留旧版/);
    assert.equal(one(S, "select doc_url from articles where review_id='MP_WXS_1002_ok0001'").doc_url, row.doc_url);
  } finally {
    S.cleanup();
  }
});

test("pictures that fail make the download incomplete (exit 1) and say how to fetch just them", async () => {
  const S = sandbox();
  try {
    await downloadedWithRaw(S, "MP_WXS_1002_images1");
    const r = await S.run(["download", "MP_WXS_1002_images1", "--images", "--force", ...DL], { WXMP_MOCK_PORT: "9" });
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /补图片：refix MP_WXS_1002_images1 --images/);
    assert.match(r.out, /有图片没下载成功/);
    const x = await S.run(["refix", "MP_WXS_1002_images1", "--images"]);
    assert.equal(x.code, 1, x.all);
    assert.match(x.out, /1 篇有图片没下载成功/);
  } finally {
    S.cleanup();
  }
});

test("when the Markdown file cannot be replaced, it and the raw page stay as they were", { skip: process.platform !== "win32" && "read-only files block a rename only on Windows" }, async () => {
  const S = sandbox();
  let md;
  try {
    const row = await downloadedWithRaw(S);
    const raw = S.file(row.raw_path);
    md = S.file(row.md_path);
    const before = { raw: sha(raw), md: sha(md) };
    chmodSync(md, 0o444);
    const r = await S.run(["download", "MP_WXS_1002_ok0001", "--force", ...DL], { WXMP_MOCK_WORLD: W("world-thin.json") });
    assert.equal(r.code, 1, r.all);
    assert.deepEqual({ raw: sha(raw), md: sha(md) }, before);
    assert.deepEqual(leftovers(S.env.WXMP_HOME), []);
    assert.doesNotMatch(r.err, /没能把旧文件放回/);
    assert.equal(one(S, "select body_chars from articles where review_id='MP_WXS_1002_ok0001'").body_chars, row.body_chars);
  } finally {
    if (md) chmodSync(md, 0o666);
    S.cleanup();
  }
});

test("a known error on an article that keeps its old copy does not reset the count either", async () => {
  const S = sandbox();
  try {
    const env = await withFake(S, "ok,ok,ok,ok");
    assert.equal((await S.run(["download", "--limit", "4", ...DL], env)).code, 0);
    const ids = S.q("select review_id from articles where status='ok' order by review_id").map((x) => x.review_id);
    assert.equal(ids.length, 4);
    rmSync(env.FAKE_COUNTER);
    const r = await S.run(["download", ...ids, ...DL], { ...env, FAKE_SEQ: "9001,-2013,9002,9003" });
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /连续 3 篇返回无法识别的错误/);
  } finally {
    S.cleanup();
  }
});
