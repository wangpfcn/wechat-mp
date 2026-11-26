// The embedded WeRead client (scripts/lib/embedded), run the way wxmp runs it: as a child process,
// against a local stand-in for the WeRead API and the article pages (tests/fake-weread.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers.mjs";
import { fakeWeread, writeLogin, ACCOUNT, ACCOUNT_NAME } from "./fake-weread.mjs";

const FAST = ["--delay", "0", "--page-delay", "0"];
const one = (S, sql, ...p) => S.q(sql, ...p)[0];

/** A sandbox whose wxmp runs the embedded client against the stand-in, logged in unless told otherwise. */
async function setup({ login = {} } = {}) {
  const api = await fakeWeread();
  const S = sandbox({ WXMP_WEREAD_CLI: "", WXMP_WEREAD_API: api.url, WXMP_WEREAD_ARTICLE_ORIGIN: api.url });
  const loginFile = login === null ? undefined : writeLogin(S.env.WEREAD_CONFIG_DIR, login);
  const done = async () => {
    await api.close();
    S.cleanup();
  };
  return { api, S, loginFile, done };
}

test("doctor: one authenticated read, sent as the e-ink device", async () => {
  const { api, S, done } = await setup();
  try {
    const r = await S.run(["doctor"]);
    assert.match(r.out, /\[ OK \] 微信读书连接\s+已登录，连接正常/, r.all);
    const calls = api.seen();
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /shelf/sync"]);
    assert.match(calls[0].headers["user-agent"], /wr_eink/);
    assert.equal(calls[0].headers.vid, "10001");
    assert.equal(calls[0].headers.accesstoken, "AT-1");
  } finally {
    await done();
  }
});

test("an expired access token is renewed once and the new tokens are saved to the login file", async () => {
  const { api, S, loginFile, done } = await setup({ login: { accessToken: "STALE" } });
  try {
    api.state.rotate = true;
    const r = await S.run(["doctor"]);
    assert.match(r.out, /已登录，连接正常/, r.all);
    assert.deepEqual(api.seen().map((c) => c.path), ["/shelf/sync", "/login", "/shelf/sync"], "rejected, renewed, sent again");
    const mint = api.seen("/login")[0].body;
    assert.equal(mint.refreshToken, "RT-1");
    assert.equal(mint.deviceType, 3);
    assert.match(mint.signature, /^[0-9a-f]{64}$/);
    const saved = JSON.parse(readFileSync(loginFile, "utf8"));
    assert.deepEqual(saved, { version: 1, eink: { vid: "10001", refreshToken: "RT-2", deviceId: "eink3346912250000000000000000001", accessToken: "AT-2" } });
    // the next command uses the saved token: no second renewal
    assert.match((await S.run(["doctor"])).out, /已登录，连接正常/);
    assert.equal(api.state.mints, 1);
  } finally {
    await done();
  }
});

test("a login WeRead no longer accepts stops the run and asks for wxmp login", async () => {
  const { api, S, loginFile, done } = await setup({ login: { accessToken: "STALE", refreshToken: "REVOKED" } });
  try {
    const before = readFileSync(loginFile, "utf8");
    const d = await S.run(["doctor"]);
    assert.match(d.out, /\[FAIL\] 微信读书连接\s+未登录或登录已失效/, d.all);
    const r = await S.run(["sync", "--account", ACCOUNT, ...FAST]);
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /已停止.*没有登录微信读书，或登录已失效/s);
    assert.match(r.err, /wxmp login/);
    assert.equal(readFileSync(loginFile, "utf8"), before, "a failed renewal leaves the login file alone");
    assert.equal(r.all.includes("REVOKED"), false, "no token in the output");
  } finally {
    await done();
  }
});

test("without a login nothing is sent anywhere", async () => {
  const { api, S, done } = await setup({ login: null });
  try {
    const r = await S.run(["search", "account", "内置"]);
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /没有登录微信读书，或登录已失效/);
    assert.equal(api.seen().length, 0);
  } finally {
    await done();
  }
});

test("search, sync and download through the embedded client", async () => {
  const { api, S, done } = await setup();
  try {
    const s = await S.run(["search", "account", "内置"]);
    assert.equal(s.code, 0, s.all);
    assert.match(s.out, new RegExp(`${ACCOUNT}\\s+${ACCOUNT_NAME}`));
    assert.deepEqual(api.seen("/store/search")[0].query, { keyword: "内置", scope: "2", count: "20", maxIdx: "0" });

    await S.run(["watch", "add", ACCOUNT]);
    const sync = await S.run(["sync", "--since", "2012-01-01", ...FAST]);
    assert.equal(sync.code, 0, sync.all);
    // The first page is asked for with a synckey and no offset, later pages with an offset and no synckey.
    const pages = api.seen("/mp/chapters").map((c) => c.query);
    assert.deepEqual(pages[0], { bookId: ACCOUNT, count: "50", synckey: "0" });
    assert.ok(pages.length >= 3, `the 49-article first page is not the end: ${JSON.stringify(pages)}`);
    for (const q of pages.slice(1)) assert.ok(q.offset !== undefined && q.synckey === undefined, JSON.stringify(q));
    assert.equal(one(S, "select count(*) n from articles where account_id=?", ACCOUNT).n, 59, "60 pushes, one without an article");
    assert.equal(one(S, "select pending_cutoff p from accounts where account_id=?", ACCOUNT).p, null);

    // One article: its details once, then the page. The link is not looked up again.
    const id = `${ACCOUNT}_e0000`;
    const before = api.seen().length;
    const d = await S.run(["download", id, "--delay", "0"]);
    assert.equal(d.code, 0, d.all);
    const sent = api.seen().slice(before);
    assert.deepEqual(sent.map((c) => c.path), ["/review/single", "/s"]);
    const page = sent[1];
    assert.match(page.headers["user-agent"], /wr_eink/);
    assert.equal("accesstoken" in page.headers || "vid" in page.headers || "cookie" in page.headers, false, "no token or cookie goes to the article host");
    const row = one(S, "select status, md_path, raw_path, pub_time, doc_url, body_chars from articles where review_id=?", id);
    assert.equal(row.status, "ok");
    assert.ok(row.body_chars > 100 && row.pub_time > 0);
    assert.match(row.doc_url, /^https:\/\/mp\.weixin\.qq\.com\/s\?/);
    assert.ok(existsSync(S.file(row.md_path)) && existsSync(S.file(row.raw_path)));
    assert.match(readFileSync(S.file(row.md_path), "utf8"), new RegExp(`account: "${ACCOUNT_NAME}"`));
    assert.equal(existsSync(join(S.env.WEREAD_LIBRARY_DIR)), false, "nothing is written to a weread content library");
  } finally {
    await done();
  }
});

test("fetch by link: link lookup, details, page", async () => {
  const { api, S, done } = await setup();
  try {
    const link = api.urlOf(api.pushes[1]);
    const r = await S.run(["fetch", `${link}#rd`, "--delay", "0"]);
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(api.seen().map((c) => c.path), ["/mp/getreviewid", "/review/single", "/s"]);
    assert.equal(api.seen("/mp/getreviewid")[0].body.urls[0], link, "the #fragment is dropped before the link is sent");
    assert.equal(one(S, "select status from articles where review_id=?", `${ACCOUNT}_e0001`).status, "ok");
    const unknown = await S.run(["fetch", "https://mp.weixin.qq.com/s?__biz=NzAwMQ==&mid=1&idx=1&sn=nothere", "--delay", "0"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /微信读书没有收录这篇/);
  } finally {
    await done();
  }
});

test("risk control stops the run: -2041 from the API, a verification redirect, a verification page", async () => {
  const { api, S, done } = await setup();
  try {
    api.state.fail = { path: "/store/search", errCode: -2041, errMsg: "need verify" };
    const s = await S.run(["search", "account", "内置"]);
    assert.equal(s.code, 2, s.all);
    assert.match(s.err, /已停止.*人机验证（-2041）/s);
    api.state.fail = null;

    api.state.pages.sn2 = { redirect: "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=x&target_url=y" };
    const red = await S.run(["download", `${ACCOUNT}_e0002`, "--delay", "0"]);
    assert.equal(red.code, 2, red.all);
    assert.match(red.err, /已停止.*打开原文时微信要求验证/s);

    api.state.pages.sn3 = { text: '<html><body><div class="weui-msg">环境异常，完成验证后即可继续访问。<a id="js_verify">去验证</a><script src="captcha.js"></script></div></body></html>' };
    const page = await S.run(["download", `${ACCOUNT}_e0003`, "--delay", "0"]);
    assert.equal(page.code, 2, page.all);
    assert.match(page.err, /已停止.*原文页面返回了微信的验证页/s);
  } finally {
    await done();
  }
});

test("an article that only talks about verification is an article, not risk control", async () => {
  const { api, S, done } = await setup();
  try {
    const body = "本文讨论登录时的安全验证：访问过于频繁、环境异常、操作频繁这些提示分别是什么意思，需要验证时该怎么办。".repeat(6);
    api.state.pages.sn4 = { text: `<html><body><div id="js_content"><p>${body}</p></div></body></html>` };
    const r = await S.run(["download", `${ACCOUNT}_e0004`, "--delay", "0"]);
    assert.equal(r.code, 0, r.all);
    const row = one(S, "select status, md_path from articles where review_id=?", `${ACCOUNT}_e0004`);
    assert.equal(row.status, "ok");
    assert.match(readFileSync(S.file(row.md_path), "utf8"), /访问过于频繁、环境异常、操作频繁/);
  } finally {
    await done();
  }
});

test("pages without the body container: a removed article fails, a summary-only page is kept as short", async () => {
  const { api, S, done } = await setup();
  try {
    api.state.pages.sn5 = { text: '<html><body><div class="weui-msg"><p>该内容已被发布者删除</p></div></body></html>' };
    const gone = await S.run(["download", `${ACCOUNT}_e0005`, "--delay", "0"]);
    assert.equal(gone.code, 1, gone.all);
    assert.match(gone.out, /failed\s.*原文页面没有可用正文/);
    assert.equal(one(S, "select status from articles where review_id=?", `${ACCOUNT}_e0005`).status, "failed");

    api.state.pages.sn6 = { text: '<html><head><meta property="og:description" content="一组图片的说明文字"></head><body><div id="js_image_content"></div></body></html>' };
    const album = await S.run(["download", `${ACCOUNT}_e0006`, "--delay", "0"]);
    assert.equal(album.code, 0, album.all);
    const row = one(S, "select status, md_path, error from articles where review_id=?", `${ACCOUNT}_e0006`);
    assert.equal(row.status, "short");
    assert.match(row.error, /页面没有标准正文区域/);
    assert.match(readFileSync(S.file(row.md_path), "utf8"), /一组图片的说明文字/);
  } finally {
    await done();
  }
});

test("a paid article: the purchase check is asked first, and its refusal leaves the preview", async () => {
  const { api, S, done } = await setup();
  try {
    api.pushes[7].payType = 2;
    await S.run(["watch", "add", ACCOUNT]);
    await S.run(["sync", "--days", "30", ...FAST]);
    const before = api.seen().length;
    const r = await S.run(["download", `${ACCOUNT}_e0007`, "--delay", "0"]);
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(api.seen().slice(before).map((c) => c.path), ["/review/single", "/mp/getpaidinfo", "/s"], "the route answers -2012 without that meaning a lost login");
    assert.equal(api.state.mints, 0, "no token renewal for the paid route's -2012");
    assert.equal(one(S, "select status from articles where review_id=?", `${ACCOUNT}_e0007`).status, "partial");
  } finally {
    await done();
  }
});

test("no network: said in plain words, and a network failure is never taken for a lost login", async () => {
  // logged in, but the API address is a closed port (the sandbox default)
  const S = sandbox({ WXMP_WEREAD_CLI: "" });
  try {
    const loginFile = writeLogin(S.env.WEREAD_CONFIG_DIR, { accessToken: undefined });
    const before = readFileSync(loginFile, "utf8");
    const d = await S.run(["doctor"]);
    assert.match(d.out, /\[FAIL\] 微信读书连接\s+连不上微信读书（网络不通或超时）/, d.all);
    const s = await S.run(["search", "account", "测试"]);
    assert.equal(s.code, 1, s.all);
    assert.match(s.err, /出错：连不上微信读书（网络不通或超时）/);
    assert.equal(/登录/.test(s.err), false, "a failed token renewal over a dead network is not a login problem");
    assert.equal(readFileSync(loginFile, "utf8"), before);
  } finally {
    S.cleanup();
  }
});

test("article pages that cannot be opened: three in a row stop the batch instead of failing all of it", async () => {
  const { api, S, done } = await setup();
  try {
    await S.run(["watch", "add", ACCOUNT]);
    await S.run(["sync", "--days", "9", ...FAST]);
    // the API answers, the article host does not
    const r = await S.run(["download", "--account", ACCOUNT, "--limit", "6", "--delay", "0"], { WXMP_WEREAD_ARTICLE_ORIGIN: "http://127.0.0.1:9" });
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /已停止（download）：连续 3 篇都打不开原文页/);
    assert.match(r.err, /download --status failed/);
    assert.equal((r.out.match(/failed\s/g) || []).length, 3, "the fourth article is not tried");
    assert.equal(one(S, "select count(*) n from articles where status='failed'").n, 3);
    // the same articles go through once the host is back
    const again = await S.run(["download", "--account", ACCOUNT, "--status", "failed", "--delay", "0"]);
    assert.equal(again.code, 0, again.all);
    assert.equal(one(S, "select count(*) n from articles where status='ok'").n, 3);
    assert.equal(api.seen("/s").length, 3);
  } finally {
    await done();
  }
});

test("the embedded client checks its arguments before it opens the login", async () => {
  const S = sandbox({ WXMP_WEREAD_CLI: "" });
  try {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const cli = fileURLToPath(new URL("../scripts/lib/embedded/cli.mjs", import.meta.url));
    const run = (...args) => spawnSync(process.execPath, ["--no-warnings", cli, ...args, "--json"], { encoding: "utf8", env: S.env });
    const report = (r) => JSON.parse(r.stderr.trim().split("\n").at(-1));
    assert.equal(report(run("nonsense")).code, "USAGE");
    assert.equal(report(run("public-accounts", "articles", "MP_WXS_1", "--count", "abc")).code, "USAGE");
    assert.equal(report(run("public-accounts", "read-article", "http://example.com/s/x")).code, "SOURCE_URL_INVALID");
    assert.equal(report(run("search", "books", "x", "--scope", "2")).code, "AUTH", "a well-formed command without a login");
  } finally {
    S.cleanup();
  }
});

test("login: QR flow, saved in the shared layout, and a second login keeps the device ID", async () => {
  const { S, done } = await setup({ login: null });
  try {
    const { login } = await import("../scripts/lib/embedded/api.mjs");
    const { loadCredentials } = await import("../scripts/lib/embedded/account.mjs");
    const env = { WEREAD_CONFIG_DIR: S.env.WEREAD_CONFIG_DIR };
    const seen = [];
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    let n = 0;
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(String(input));
      seen.push(`${init.method ?? "GET"} ${url.host}${url.pathname}`);
      if (url.pathname === "/wxticket") return json({ signature: "sig", timeStamp: 1 });
      if (url.pathname === "/connect/sdk/qrconnect") return json({ errcode: 0, uuid: "UUID1" });
      if (url.pathname === "/connect/l/qrconnect") return json({ wx_errcode: 405, wx_code: "CODE1" });
      if (url.pathname === "/login") {
        n += 1;
        const body = JSON.parse(init.body);
        assert.equal(body.code, "CODE1");
        return json({ vid: 20002, accessToken: `LOGIN-AT-${n}`, refreshToken: `LOGIN-RT-${n}` });
      }
      throw new Error(`unexpected request ${url}`);
    };
    let qr;
    const first = await login(env, { fetchImpl, onQr: (u) => (qr = u) });
    assert.equal(qr, "https://open.weixin.qq.com/connect/confirm?uuid=UUID1");
    assert.deepEqual(seen, ["GET i.weread.qq.com/wxticket", "GET open.weixin.qq.com/connect/sdk/qrconnect", "GET long.open.weixin.qq.com/connect/l/qrconnect", "POST i.weread.qq.com/login"]);
    assert.equal(first.account, "default");
    assert.equal(first.vid, "20002");
    assert.match(first.deviceId, /^eink334691225\d{19}$/);
    const saved = loadCredentials("default", env);
    assert.deepEqual(saved, { vid: "20002", refreshToken: "LOGIN-RT-1", deviceId: first.deviceId, accessToken: "LOGIN-AT-1" });
    assert.deepEqual(JSON.parse(readFileSync(join(env.WEREAD_CONFIG_DIR, "accounts", "default", "account.json"), "utf8")), { version: 1, client: "eink" });
    const second = await login(env, { fetchImpl });
    assert.equal(second.deviceId, first.deviceId, "the same device logs in again");
    assert.equal(loadCredentials("default", env).refreshToken, "LOGIN-RT-2");
  } finally {
    await done();
  }
});
