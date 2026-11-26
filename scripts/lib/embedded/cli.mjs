#!/usr/bin/env node
// wxmp's own WeRead client, run as a child process by lib/weread.mjs (one process per call).
// It answers the few commands wxmp uses, with the JSON shapes and error reports of the weread-omni
// command line it replaces, so either can be plugged in:
//   doctor | login
//   search books <keyword> --scope <2|4> --count <n> [--max-idx <n>]
//   public-accounts articles <accountId> --count <n> [--offset <n>]
//   public-accounts resolve-article <url>
//   public-accounts read-article <url> [--review-id <id>] [--pay-type <n>]
//   review single <reviewId>
// Results go to stdout as one JSON document; a failure is one JSON line on stderr and exit code 1.
// Every command is a read. Tests: WXMP_WEREAD_API and WXMP_WEREAD_ARTICLE_ORIGIN replace the hosts.
import { createRequire } from "node:module";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { AuthError, TransportError, WeReadApiError } from "../../vendor/weread-omni/errors.js";
import { redact, stripErrorPrefix } from "../../vendor/weread-omni/redact.js";
import { login, openClient } from "./api.mjs";
import { readArticlePage, sourceUrl, SourceFailure } from "./article.mjs";

/** The weread-omni release the request layer was taken from. */
const EMBEDDED_FROM = "0.1.2";

class UsageError extends Error {}

function parse(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") continue;
    if (a.startsWith("--")) {
      if (i + 1 >= argv.length) throw new UsageError(`option ${a} needs a value`);
      options[a.slice(2)] = argv[++i];
    } else positional.push(a);
  }
  return { positional, options };
}

function wholeNumber(options, name, fallback) {
  const raw = options[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a whole number`);
  return Number(raw);
}

function need(value, what) {
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`missing ${what}`);
  return value;
}

/** The error report wxmp reads: errCode for WeRead's business codes, code for everything it must tell apart. */
function report(error) {
  const message = stripErrorPrefix(redact(error?.message ?? String(error)));
  if (error instanceof AuthError) return { error: message, code: "AUTH" };
  if (error instanceof WeReadApiError) {
    return { error: message, ...(error.errCode === undefined ? {} : { errCode: error.errCode }), status: error.status, path: error.path };
  }
  if (error instanceof SourceFailure) return { error: message, code: error.code, article: { diagnostics: [{ code: error.code, message }] } };
  if (error instanceof UsageError) return { error: message, code: "USAGE" };
  // No answer from WeRead at all: no connection, a reset, or a timeout.
  if (error instanceof TransportError) return { error: message, code: "NETWORK" };
  return { error: message };
}

async function printQr(url) {
  let qrcode;
  try {
    qrcode = createRequire(import.meta.url)("../../vendor/qrcode-terminal/lib/main.js"); // ships with the skill
  } catch {
    process.stderr.write(`skill 自带的二维码组件（scripts/vendor/qrcode-terminal）不完整，请重新复制整个 wechat-mp 文件夹。也可以把下面的链接做成二维码，用手机微信扫：\n${url}\n`);
    return;
  }
  await new Promise((resolve) => {
    qrcode.generate(url, { small: true }, (image) => {
      process.stderr.write(`${image}\n`);
      resolve();
    });
  });
}

async function run(argv, env) {
  const { positional, options } = parse(argv);
  const [c1, c2, c3] = positional;
  if (c1 === "login") {
    process.stderr.write("用手机微信扫描下面的二维码，登录微信读书（5 分钟内有效）：\n");
    const done = await login(env, {
      onQr: printQr,
      onStatus: (status) => process.stderr.write(status === "scanned" ? "已扫码，请在手机上点确认……\n" : status === "confirmed" ? "已确认，正在登录……\n" : ""),
    });
    process.stdout.write(`已登录微信读书（账号 ${done.account}，vid ${done.vid}）。\n`);
    return undefined;
  }
  // The arguments of a command are checked before the saved login is opened, so a mistyped command
  // is reported as that and not as a missing login.
  let client;
  const open = () => (client ??= openClient(env));
  if (c1 === "doctor") {
    const api = open();
    await api.ping();
    return { ok: true, cli: { package: "wxmp embedded client", version: EMBEDDED_FROM }, auth: { status: "authenticated", account: api.alias, ...api.identity } };
  }
  if (c1 === "search" && c2 === "books") {
    const keyword = need(c3, "keyword");
    const how = { scope: wholeNumber(options, "scope", 10), count: wholeNumber(options, "count", 20), maxIdx: wholeNumber(options, "max-idx", 0) };
    return open().search(keyword, how);
  }
  if (c1 === "public-accounts" && c2 === "articles") {
    const accountId = need(c3, "account ID");
    const how = { count: wholeNumber(options, "count", 50), offset: wholeNumber(options, "offset", undefined) };
    return open().articles(accountId, how);
  }
  if (c1 === "review" && c2 === "single") {
    const reviewId = need(c3, "review ID");
    return { reviewId, ...(await open().reviewSingle(reviewId)) };
  }
  if (c1 === "public-accounts" && c2 === "resolve-article") {
    const link = sourceUrl(need(c3, "article URL")).href;
    return open().resolveArticle(link);
  }
  if (c1 === "public-accounts" && c2 === "read-article") {
    // The link is checked before anything is sent anywhere.
    let link = sourceUrl(need(c3, "article URL")).href;
    let payType = wholeNumber(options, "pay-type", undefined);
    const api = open();
    let reviewId = options["review-id"];
    let title = null;
    let accountName = null;
    let publishedAt = null;
    if (!reviewId) {
      // Called with a bare link: look the article up first (two requests the caller can save by
      // passing --review-id and --pay-type when it already has them).
      reviewId = (await api.resolveArticle(link)).reviewId;
      const mp = (await api.reviewSingle(reviewId))?.review?.mpInfo ?? {};
      title = mp.title ?? null;
      accountName = mp.mp_name ?? null;
      payType = typeof mp.payType === "number" ? mp.payType : payType;
      publishedAt = Number(mp.time) > 0 ? new Date(Number(mp.time) * 1000).toISOString() : null;
      if (typeof mp.doc_url === "string" && mp.doc_url) link = mp.doc_url;
    }
    const page = await readArticlePage(api, link, { payType, env });
    const now = new Date().toISOString();
    return {
      reviewId,
      title,
      accountName,
      sourceUrl: page.sourceUrl,
      publishedAt,
      readAt: now,
      fetchedAt: now,
      cachedAt: null,
      fromCache: false,
      status: page.status,
      completeness: page.status === "readable" ? "unverified" : page.status,
      markdown: page.markdown,
      contentHtml: null,
      sourceSha256: page.sourceSha256,
      sourceHtml: page.sourceHtml,
      diagnostics: page.diagnostics,
    };
  }
  throw new UsageError(`unsupported command: ${positional.join(" ") || "(none)"}`);
}

// A connect attempt gets 1 s instead of Node's 250 ms: on an IPv4-only network the single usable
// address of i.weread.qq.com often needs a little longer, and Node would give up on it.
if (process.env.WEREAD_CONNECT_ATTEMPT_TIMEOUT_MS !== "0") setDefaultAutoSelectFamilyAttemptTimeout(1000);

try {
  const result = await run(process.argv.slice(2), process.env);
  if (result !== undefined) process.stdout.write(JSON.stringify(result));
} catch (error) {
  // login talks to a person; every other command talks to wxmp
  if (process.argv[2] === "login") process.stderr.write(`登录没有完成：${report(error).error}\n`);
  else process.stderr.write(`${JSON.stringify(report(error))}\n`);
  process.exitCode = 1;
}
