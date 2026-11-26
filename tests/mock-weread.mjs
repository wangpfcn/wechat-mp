#!/usr/bin/env node
// Offline stand-in for the weread-omni CLI, driven by tests/fixtures/world.json.
// It emits the same JSON shapes wxmp consumes and never touches the network.
//
// Env:
//   WXMP_MOCK_WORLD    world file (default: ./fixtures/world.json next to this script)
//   WXMP_MOCK_LOG      append one JSON line per call (the argv) — lets tests count requests
//   WXMP_MOCK_PORT     replaces __PORT__ in fixture HTML (local image server)
//   WXMP_MOCK_FAIL     -2041 | -2010 | -2013 | <any number> | AUTH | CHALLENGE | INSUFFICIENT | GARBAGE | HANG
//   WXMP_MOCK_FAIL_ON  only fail when the joined argv contains this text
//   WXMP_MOCK_FAIL_MSG message for a numeric failure (default: an English one)
//   WXMP_MOCK_FAIL_VARY append a different request number to every failure message
//   WXMP_MOCK_FAIL_STDOUT report the failure as JSON on stdout with exit code 0
//   WEREAD_LIBRARY_DIR where read-article stores the raw page (like weread-omni's content library)
// World extras: generate[].jitter (articles of one push get createTimes a few seconds apart; pushes
// are then grouped by push, not by time), articles[].noBlob (the raw page is not cached).
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2).filter((a) => a !== "--json");
const joined = argv.join(" ");
const env = process.env;
if (env.WXMP_MOCK_LOG) appendFileSync(env.WXMP_MOCK_LOG, JSON.stringify(argv) + "\n");

const die = (obj) => {
  process.stderr.write(JSON.stringify(obj) + "\n");
  process.exit(1);
};
const ok = (obj) => {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
};

function failure(kind) {
  if (/^-?\d+$/.test(kind)) {
    const vary = env.WXMP_MOCK_FAIL_VARY ? ` [request ${process.pid}-${Date.now()}]` : "";
    const report = { error: `${env.WXMP_MOCK_FAIL_MSG || `mobile /mock: simulated failure (${kind})`}${vary}`, errCode: Number(kind), status: 499, path: "/mock" };
    if (env.WXMP_MOCK_FAIL_STDOUT) ok(report);
    die(report);
  }
  if (kind === "AUTH") die({ error: "no WeRead accounts are configured; run weread-omni login" });
  if (kind === "CHALLENGE") die({ error: "article source unavailable", code: "SOURCE_WECHAT_CHALLENGE", article: { diagnostics: [{ code: "SOURCE_WECHAT_CHALLENGE", message: "WeChat asked for verification" }] } });
  if (kind === "INSUFFICIENT") die({ error: "article source content was insufficient", code: "SOURCE_CONTENT_INSUFFICIENT", article: { diagnostics: [{ code: "SOURCE_CONTENT_INSUFFICIENT", message: "article source content was insufficient" }] } });
  if (kind === "GARBAGE") {
    process.stdout.write("this is not json");
    process.exit(0);
  }
  if (kind === "HANG") return "hang";
  die({ error: `mock: unknown failure kind ${kind}` });
}

if (env.WXMP_MOCK_FAIL && (!env.WXMP_MOCK_FAIL_ON || joined.includes(env.WXMP_MOCK_FAIL_ON))) {
  if (failure(env.WXMP_MOCK_FAIL) === "hang") {
    // Stay alive until the caller's timeout kills us; give up on our own after a while so a caller
    // that was itself killed does not leave this process behind.
    setTimeout(() => process.exit(9), Number(env.WXMP_MOCK_HANG_MS || 120_000));
    await new Promise(() => {});
  }
}

// ── world ──
const worldPath = env.WXMP_MOCK_WORLD || join(here, "fixtures", "world.json");
const world = JSON.parse(readFileSync(worldPath, "utf8"));
const htmlDir = join(dirname(worldPath), "html");
const now = Math.floor(Date.now() / 1000);
const accounts = new Map(world.accounts.map((a) => [a.id, a]));
const b64 = (digits) => Buffer.from(String(digits)).toString("base64");
let mid = 1000;
const urlFor = (account, rid) => {
  mid += 1;
  const sn = createHash("md5").update(rid).digest("hex");
  return `https://mp.weixin.qq.com/s?__biz=${b64(account.replace("MP_WXS_", ""))}&mid=${mid}&idx=1&sn=${sn}`;
};
const articles = [];
for (const g of world.generate ?? []) {
  const perPush = g.perPush ?? 1; // articles per push (they share createTime)
  for (let i = 0; i < g.count; i++) {
    const rid = `${g.account}_${g.idPrefix}${String(i).padStart(4, "0")}`;
    const slot = Math.floor(i / perPush);
    const base = now - Math.round((g.startHoursAgo + slot * g.stepHours) * 3600);
    articles.push({
      reviewId: rid,
      account: g.account,
      title: `${g.titlePrefix}${g.count - i}期`,
      createTime: g.jitter ? base - (i % perPush) : base,
      push: g.jitter ? `${g.idPrefix}-${slot}` : undefined,
      html: g.html,
    });
  }
}
for (const a of world.articles ?? []) articles.push({ ...a, createTime: now - Math.round(a.hoursAgo * 3600) });
for (const a of articles) {
  a.pubTime ??= a.createTime - 600;
  a.url = a.noDocUrl ? undefined : urlFor(a.account, a.reviewId);
}
// "skip": articles deleted upstream (removed after URLs are assigned, so the others keep theirs)
const skip = new Set(world.skip ?? []);
for (let i = articles.length - 1; i >= 0; i--) if (skip.has(articles[i].reviewId)) articles.splice(i, 1);
// "holes": a push whose article is gone but whose slot still counts for offset / count (the page comes back short).
const holes = new Set(world.holes ?? []);
const listSlots = articles.map((a) => ({ ...a, hole: holes.has(a.reviewId) }));
for (let i = articles.length - 1; i >= 0; i--) if (holes.has(articles[i].reviewId)) articles.splice(i, 1);
const byUrl = (u) => articles.find((a) => a.url && a.url.split("#")[0] === String(u).split("#")[0]);

// ── commands ──
const [c1, c2, c3] = argv;
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (c1 === "doctor") ok({ ok: true, cli: { package: "weread-omni", version: "mock" }, auth: { status: "authenticated", vid: "0", source: "mock" } });
if (c1 === "login") {
  process.stdout.write("mock login ok\n");
  process.exit(0);
}

if (c1 === "search" && c2 === "books") {
  const kw = c3;
  const scope = Number(opt("scope") ?? 10);
  const start = Number(opt("max-idx") ?? 0);
  const count = Number(opt("count") ?? 20);
  let hits = [];
  if (scope === 2) hits = world.accounts.filter((a) => (a.name ?? "").includes(kw)).map((a) => ({ bookInfo: { bookId: a.id, title: a.name, author: "公众号", intro: a.intro, cover: "" } }));
  if (scope === 4)
    hits = articles
      .filter((a) => a.title.includes(kw))
      .map((a) => ({ bookInfo: { bookId: a.account, title: accounts.get(a.account)?.name, author: "公众号", intro: "" }, mpContentInfo: { reviewId: a.reviewId, title: a.title, abstract: `${a.title}的摘要` } }));
  const page = hits.slice(start, start + count).map((h, i) => ({ ...h, searchIdx: start + i + 1 }));
  ok({ parts: [kw], books: page, hasMore: start + count < hits.length ? 1 : 0, totalCount: hits.length });
}

if (c1 === "public-accounts" && c2 === "articles") {
  if (!accounts.has(c3)) die({ error: "mobile /mp/chapters: book not found", errCode: -2003, status: 200, path: "/mp/chapters" });
  const list = listSlots.filter((a) => a.account === c3).sort((x, y) => y.createTime - x.createTime);
  // Like the real /mp/chapters: offset and count are in pushes (群发, one "chapter" each), and every
  // article of a selected push comes back. Articles of one push share createTime.
  const pushes = [];
  const pushOf = (a) => a.push ?? a.createTime;
  for (const a of list) {
    if (pushes.length && pushOf(pushes[pushes.length - 1][0]) === pushOf(a)) pushes[pushes.length - 1].push(a);
    else pushes.push([a]);
  }
  const count = Number(opt("count") ?? 50);
  const offset = Number(opt("offset") ?? 0);
  const page = pushes
    .slice(offset, offset + count)
    .flat()
    .filter((a) => !a.hole)
    .map((a) => ({ reviewId: a.reviewId, mpInfo: { title: a.title, pic_url: "", payType: a.payType ?? 0 }, createTime: a.createTime }));
  const res = { synckey: list[0]?.createTime ?? 0, clearAll: 1, accountId: c3, articles: page, returnedCount: page.length, requestedOffset: offset };
  // The real CLI's nextOffset is offset + article count (it skips pushes when a push has several
  // articles); reproduce that so the tests catch anyone trusting it.
  if (page.length >= count) res.nextOffset = offset + page.length;
  ok(res);
}

if (c1 === "review" && c2 === "single") {
  const a = articles.find((x) => x.reviewId === c3);
  if (!a) die({ error: "mobile /review/single: review not found", errCode: -2003, status: 200, path: "/review/single" });
  ok({ reviewId: a.reviewId, review: { reviewId: a.reviewId, belongBookId: a.account, mpInfo: { doc_url: a.url ?? "", title: a.title, mp_name: accounts.get(a.account)?.name, time: a.pubTime, payType: a.payType ?? 0 } } });
}

if (c1 === "public-accounts" && c2 === "resolve-article") {
  const a = byUrl(c3);
  if (!a) die({ error: "mobile /mp/getreviewid: no review ID for the requested article", path: "/mp/getreviewid" });
  ok({ url: a.url, reviewId: a.reviewId });
}

if (c1 === "public-accounts" && c2 === "read-article") {
  const a = byUrl(c3);
  if (!a) die({ error: "article source unavailable", code: "SOURCE_URL_INVALID", article: { diagnostics: [{ code: "SOURCE_URL_INVALID" }] } });
  if (a.readError) failure(a.readError);
  let html = readFileSync(join(htmlDir, a.html), "utf8").replace(/__PORT__/g, env.WXMP_MOCK_PORT || "9");
  const bytes = Buffer.from(html, "utf8");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const lib = env.WEREAD_LIBRARY_DIR || join(homedir(), ".local", "share", "weread", "library");
  const dir = join(lib, "blobs", "sha256", sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  if (!a.noBlob && !existsSync(join(dir, sha))) writeFileSync(join(dir, sha), bytes);
  ok({
    reviewId: a.reviewId,
    title: a.title,
    accountName: accounts.get(a.account)?.name,
    sourceUrl: a.url,
    publishedAt: new Date(a.pubTime * 1000).toISOString(),
    readAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    cachedAt: null,
    fromCache: false,
    status: a.status ?? "readable",
    completeness: a.status === "partial" ? "partial" : "unverified",
    markdown: a.toolMarkdown ?? `## ${a.title}\n\n这是工具自带提取的正文，长度足够，模拟提取正常的情况。`.repeat(1) + "\n\n" + "正文内容。".repeat(60),
    contentHtml: "",
    sourceSha256: sha,
    diagnostics: [],
  });
}

die({ error: `mock: unsupported command: ${joined}` });
