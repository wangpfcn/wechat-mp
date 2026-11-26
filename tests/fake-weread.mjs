// A local stand-in for the WeRead API and for mp.weixin.qq.com article pages, used by the tests of
// the embedded client. It speaks just enough of the protocol: the token mint, the business-code
// envelope (HTTP 200 with a negative errCode), search, the article list paged by push (with a push
// that keeps its place but has no article), article details, link lookup and the pages themselves.
// Everything in it is made up; it never leaves 127.0.0.1.
import http from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HTML = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "html");

export const ACCOUNT = "MP_WXS_7001";
export const ACCOUNT_NAME = "内置测试号";
const BIZ = Buffer.from("7001").toString("base64");

/** Save a WeRead login the way `wxmp login` does. */
export function writeLogin(configDir, credentials = {}) {
  const dir = join(configDir, "accounts", "default");
  mkdirSync(join(dir, "clients"), { recursive: true });
  writeFileSync(join(dir, "account.json"), `${JSON.stringify({ version: 1, client: "eink" }, null, 2)}\n`);
  const eink = { vid: "10001", refreshToken: "RT-1", deviceId: "eink3346912250000000000000000001", accessToken: "AT-1", ...credentials };
  writeFileSync(join(dir, "clients", "eink.json"), `${JSON.stringify({ version: 1, eink }, null, 2)}\n`);
  return join(dir, "clients", "eink.json");
}

/**
 * Start the stand-in. `state` can be changed by a test while it runs:
 *   accessToken / refreshToken  what the server currently accepts
 *   rotate                      a mint also issues a new refresh token
 *   fail                        { path, errCode, errMsg } answers that route with a business error
 *   paid                        the body /mp/getpaidinfo answers with (default: -2012, like the real route)
 *   pages                       per article ("sn" of its link): { html: fixture file } | { text } | { redirect }
 */
export async function fakeWeread() {
  const state = { vid: "10001", refreshToken: "RT-1", accessToken: "AT-1", mints: 0, rotate: false, fail: null, paid: null, pages: {}, requests: [] };
  const now = Math.floor(Date.now() / 1000);
  // 60 pushes of one article, a day apart. Push 10 lost its article but keeps its place in the list.
  const pushes = Array.from({ length: 60 }, (_, i) => ({
    reviewId: `${ACCOUNT}_e${String(i).padStart(4, "0")}`,
    title: `内置文章第${60 - i}期`,
    createTime: now - 3600 - i * 86400,
    hole: i === 10,
    sn: `sn${i}`,
    payType: 0,
  }));
  const urlOf = (p) => `https://mp.weixin.qq.com/s?__biz=${BIZ}&mid=${3000 + Number(p.sn.slice(2))}&idx=1&sn=${p.sn}`;
  const send = (res, status, body, headers = {}) => {
    const html = typeof body === "string";
    res.writeHead(status, { "content-type": html ? "text/html; charset=utf-8" : "application/json", ...headers });
    res.end(html ? body : JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const q = Object.fromEntries(url.searchParams);
    state.requests.push({ method: req.method, path: url.pathname, query: q, headers: req.headers, body });
    if (url.pathname === "/s") {
      const page = state.pages[q.sn] ?? { html: "ok.html" };
      if (page.redirect) return send(res, 302, "", { location: page.redirect });
      return send(res, 200, page.text ?? readFileSync(join(HTML, page.html), "utf8"));
    }
    if (url.pathname === "/login" && req.method === "POST") {
      if (body?.refreshToken !== state.refreshToken) return send(res, 200, { errCode: -2012, errMsg: "登录超时" });
      state.mints += 1;
      state.accessToken = `AT-${state.mints + 1}`;
      if (state.rotate) state.refreshToken = `RT-${state.mints + 1}`;
      return send(res, 200, { vid: Number(state.vid), accessToken: state.accessToken, refreshToken: state.refreshToken });
    }
    if (req.headers.accesstoken !== state.accessToken || req.headers.vid !== state.vid) return send(res, 200, { errCode: -2012, errMsg: "登录超时" });
    if (state.fail?.path === url.pathname) return send(res, 200, { errCode: state.fail.errCode, errMsg: state.fail.errMsg ?? "simulated" });
    if (url.pathname === "/shelf/sync") return send(res, 200, { books: [] });
    if (url.pathname === "/store/search") {
      const books = [];
      if (q.scope === "2" && ACCOUNT_NAME.includes(q.keyword)) books.push({ bookInfo: { bookId: ACCOUNT, title: ACCOUNT_NAME, author: "公众号", intro: "虚构账号", cover: "" } });
      if (q.scope === "4") {
        for (const p of pushes) {
          if (!p.hole && p.title.includes(q.keyword)) books.push({ bookInfo: { bookId: ACCOUNT, title: ACCOUNT_NAME, author: "公众号", intro: "" }, mpContentInfo: { reviewId: p.reviewId, title: p.title, abstract: `${p.title}的摘要` } });
        }
      }
      const start = Number(q.maxIdx ?? 0);
      const page = books.slice(start, start + Number(q.count ?? 20)).map((b, i) => ({ ...b, searchIdx: start + i + 1 }));
      return send(res, 200, { parts: [q.keyword], books: page, hasMore: start + page.length < books.length ? 1 : 0, totalCount: books.length });
    }
    if (url.pathname === "/mp/chapters") {
      const offset = Number(q.offset ?? 0);
      const data = pushes
        .slice(offset, offset + Number(q.count))
        .filter((p) => !p.hole)
        .map((p) => ({ reviewId: p.reviewId, createTime: p.createTime, mpInfo: { title: p.title, pic_url: "", payType: p.payType } }));
      return send(res, 200, { synckey: pushes[0].createTime, clearAll: q.offset === undefined ? 1 : 0, data });
    }
    if (url.pathname === "/review/single") {
      const p = pushes.find((x) => x.reviewId === q.reviewId && !x.hole);
      if (!p) return send(res, 200, { errCode: -2003, errMsg: "review not found" });
      return send(res, 200, { reviewId: p.reviewId, review: { reviewId: p.reviewId, belongBookId: ACCOUNT, mpInfo: { doc_url: urlOf(p), title: p.title, mp_name: ACCOUNT_NAME, time: p.createTime - 600, payType: p.payType } } });
    }
    if (url.pathname === "/mp/getreviewid") {
      const link = body?.urls?.[0] ?? "";
      const p = pushes.find((x) => !x.hole && link.includes(`sn=${x.sn}`) && new URL(link).searchParams.get("sn") === x.sn);
      return send(res, 200, { reviewIds: p ? [{ url: link, reviewId: p.reviewId }] : [] });
    }
    if (url.pathname === "/mp/getpaidinfo") return send(res, 200, state.paid ?? { errCode: -2012, errMsg: "登录超时" });
    return send(res, 404, { errCode: -1, errMsg: "no such route" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    pushes,
    urlOf,
    /** Requests seen so far, optionally only those to one path. */
    seen: (path) => (path ? state.requests.filter((r) => r.path === path) : state.requests),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
