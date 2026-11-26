// Download of one article page from mp.weixin.qq.com. The link checks, the manual redirect handling
// and the limits follow weread-omni 0.1.2 (dist/public-accounts.js, MIT, Teng Lin). Unlike weread-omni
// nothing is extracted or judged here: the caller gets the page as it came, and decides from the body
// container (#js_content) whether it is an article, a verification page or something else.
import { createHash } from "node:crypto";
import { einkDevice } from "../../vendor/weread-omni/device-ua.js";

const SOURCE_TIMEOUT_MS = 20_000;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const USER_AGENT = einkDevice().userAgent;
const PAYWALL_CONTENT = /(?:付费后阅读|购买后阅读|付费内容|试看)/;
// Pages WeChat serves in place of an article that is gone.
const REMOVED_CONTENT = /该内容已被发布者删除|此内容因违规无法查看|此内容被投诉且经审核涉嫌侵权|此帐号已被屏蔽|该公众号已迁移|内容已被删除/;
const HAS_BODY = /\sid\s*=\s*["']?js_content["'\s>]/i;
/** `payType` 2 marks protected content: the entitlement endpoint is asked before the public page. */
const PAID_ARTICLE_PAY_TYPE = 2;

/** A failure of the page download, with a code wxmp knows (SOURCE_...). */
export class SourceFailure extends Error {
  constructor(code, message, status, options) {
    super(message, options);
    this.code = code;
    this.status = status;
  }
}

/** Only HTTPS mp.weixin.qq.com/s links without credentials or a port; the #fragment is dropped. */
export function sourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new SourceFailure("SOURCE_URL_INVALID", "article source URL is invalid", undefined, { cause });
  }
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1] ?? "";
  if (
    value !== value.trim() ||
    authority.includes("@") ||
    url.protocol !== "https:" ||
    url.hostname !== "mp.weixin.qq.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    (url.pathname !== "/s" && !url.pathname.startsWith("/s/"))
  ) {
    throw new SourceFailure("SOURCE_URL_INVALID", "article source must be an HTTPS mp.weixin.qq.com/s URL without credentials or a custom port");
  }
  url.hash = "";
  return url;
}

async function readBytes(response) {
  const declared = response.headers.get("content-length");
  const tooLarge = () => new SourceFailure("SOURCE_TOO_LARGE", `article source exceeds ${MAX_SOURCE_BYTES} bytes`);
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_SOURCE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > MAX_SOURCE_BYTES - total) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * GET the page, following at most three redirects by hand so every hop is checked. Only the device's
 * user agent is sent: no cookie and no WeRead token ever goes to mp.weixin.qq.com.
 * `origin` (tests only) sends the request to another host; the link itself is still checked as given.
 */
export async function fetchPage(initial, { fetchImpl = fetch, signal, origin } = {}) {
  let current = initial;
  for (let redirects = 0; ; redirects++) {
    const target = origin ? new URL(current.pathname + current.search, origin) : current;
    let response;
    try {
      response = await fetchImpl(target, { redirect: "manual", signal, headers: { accept: "text/html,application/xhtml+xml", "user-agent": USER_AGENT } });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new SourceFailure("SOURCE_FETCH_FAILED", "article source fetch failed", undefined, { cause });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (redirects >= 3) throw new SourceFailure("SOURCE_REDIRECT_LIMIT", "article source exceeded three redirects");
      if (!location) throw new SourceFailure("SOURCE_REDIRECT_INVALID", "article redirect has no location");
      let next;
      try {
        const authority = /^(?:[a-z][a-z\d+.-]*:)?\/\/([^/?#]*)/i.exec(location)?.[1] ?? "";
        if (location !== location.trim() || location.includes("#") || authority.includes("@")) throw new TypeError("redirect contains credentials, whitespace, or a fragment");
        next = new URL(location, current);
      } catch (cause) {
        throw new SourceFailure("SOURCE_REDIRECT_INVALID", "article redirect target is not allowed", undefined, { cause });
      }
      if (next.hostname === "mp.weixin.qq.com" && next.pathname === "/mp/wappoc_appmsgcaptcha") {
        throw new SourceFailure("SOURCE_WECHAT_CHALLENGE", "WeChat asked for verification instead of serving the article; open the article URL in a browser to complete it", response.status);
      }
      try {
        current = sourceUrl(next.href);
      } catch (cause) {
        throw new SourceFailure("SOURCE_REDIRECT_INVALID", "article redirect target is not allowed", undefined, { cause });
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SourceFailure("SOURCE_HTTP_ERROR", `article source returned HTTP ${response.status}`, response.status);
    }
    return { bytes: await readBytes(response), url: current };
  }
}

const metaContent = (html, name) => {
  const tag = html.match(new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${name}["'][^>]*>`, "i"))?.[0];
  const value = tag?.match(/\scontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return (value?.[1] ?? value?.[2] ?? "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\\x0a|\\n/g, "\n").trim();
};

/**
 * Read one article page.
 * Returns { sourceUrl, sourceHtml, sourceSha256, status ("readable" | "partial"), markdown, diagnostics }.
 * `markdown` is only a stand-in for pages without the standard body container: the page's own summary
 * (og:description), or null. A page that says the article was removed is a failure.
 */
export async function readArticlePage(api, link, { payType, env = process.env, fetchImpl = fetch } = {}) {
  let page = sourceUrl(link);
  const diagnostics = [];
  const signal = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
  let html;
  let bytes;
  let paidInFull = false;
  if (payType === PAID_ARTICLE_PAY_TYPE) {
    try {
      const entry = await api.paidContent(page.href);
      if (entry.ispaid === true && typeof entry.content === "string" && entry.content.length > 0) {
        // The authorized body. It is wrapped in the standard container when it comes without one.
        html = HAS_BODY.test(entry.content) ? entry.content : `<div id="js_content">${entry.content}</div>`;
        bytes = Buffer.from(html, "utf8");
        paidInFull = true;
      } else if (typeof entry.url === "string" && entry.url.length > 0) {
        try {
          page = sourceUrl(entry.url);
        } catch {
          /* a substitute link that fails the checks is ignored; the original link still stands */
        }
      }
    } catch (cause) {
      // The public page is still worth reading: it is what a reader without the purchase sees.
      diagnostics.push({ code: "PAID_LOOKUP_FAILED", message: `paid article lookup failed: ${cause?.message ?? cause}` });
    }
  }
  if (html === undefined) {
    let got;
    try {
      got = await fetchPage(page, { fetchImpl, signal, origin: env.WXMP_WEREAD_ARTICLE_ORIGIN || undefined });
    } catch (cause) {
      if (cause instanceof SourceFailure) throw cause;
      throw new SourceFailure(signal.aborted ? "SOURCE_TIMEOUT" : "SOURCE_FETCH_FAILED", signal.aborted ? "article source timed out" : `article source fetch failed: ${cause?.message ?? cause}`);
    }
    page = got.url;
    bytes = got.bytes;
    html = bytes.toString("utf8");
  }
  const hasBody = HAS_BODY.test(html);
  if (!hasBody) {
    const removed = html.match(REMOVED_CONTENT)?.[0];
    if (removed) throw new SourceFailure("SOURCE_CONTENT_INSUFFICIENT", `the article is no longer available (${removed})`);
  }
  const paywall = !paidInFull && ((payType ?? 0) > 0 || PAYWALL_CONTENT.test(html));
  if (paywall) diagnostics.push({ code: "SOURCE_PAYWALL_PREVIEW", message: "article source exposes a paywall preview" });
  return {
    sourceUrl: page.href,
    sourceHtml: html,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    status: paywall ? "partial" : "readable",
    markdown: hasBody ? null : metaContent(html, "og:description") || metaContent(html, "description") || null,
    diagnostics,
  };
}
