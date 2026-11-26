#!/usr/bin/env node
// wxmp — search, track and download WeChat Official Account articles through WeRead (read-only).
// Usage: node wxmp.mjs <command> [...]   (run `node wxmp.mjs help`)
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync, renameSync, copyFileSync, openSync, writeSync, closeSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname, basename, relative } from "node:path";
import { openStore, HOME, ARTICLE_TIME, TRACKED, absPath, relPath } from "./lib/store.mjs";
import { runWeread, isFatal, WereadError, accountIdFromUrl, accountOfReview, ACCOUNT_ID, wereadRoot, wereadVersion, wereadCli, wereadSource, EMBEDDED_FROM } from "./lib/weread.mjs";
import { jsContentFragment, fragmentToMarkdown, markdownTextLength, libraryBlobPath, readMaybeGz } from "./lib/extract.mjs";
import { markdownInfo } from "./lib/markdown.mjs";
import { bj, bjIso, toBjIso, parseDate, safeName, ridTag, pad, clip, sleep } from "./lib/util.mjs";

export const VERSION = "0.1.0";

const HELP = `wxmp ${VERSION} — 公众号搜索 / 追踪 / 下载（经微信读书，只读）
数据目录: ${HOME}   (环境变量 WXMP_HOME 可改)

  login                                           用微信扫码登录微信读书（要在自己的终端里运行）
  doctor                                          检查环境：Node、微信读书登录、正文转换、数据目录
  search account <关键词> [--refresh] [--top N] [--max-idx N]
                                                  搜公众号（30 天内同词第一页走缓存）
  search article <关键词> [--max-idx N] [--top N] 搜文章（返回标题、摘要，无发布时间）
  watch add <号ID|文章链接> [--name 名称]          加入关注（本地，不在微信读书订阅）
  watch rm <号ID> | watch ls
  sync [--account 号] [--days N | --since YYYY-MM-DD] [--max-pages N] [--download] [--images] [--limit N]
                                                  拉关注号的新文章；首次回看 30 天，之后增量
                                                  只看某号最新：sync --account 号 --days 1
  download [--account 号] [--status new,failed] [--since YYYY-MM-DD] [--limit N] [--images]
  download <文章ID> ... [--images]                 下载正文（默认每篇间隔 8 秒、每次最多 50 篇）
                                                  文章 ID 也可写 --review ID；指定了 ID 就不能再用 --account/--status/--since
  fetch <文章链接> ... [--images]                  按链接直接下载（不用先搜、不用关注）
  list [--account 号] [--top N] [--status ...] [--since YYYY-MM-DD]
                                                  按时间倒序列出库里的文章（不联网；要最新先 sync）
  export [--account 号] [--since YYYY-MM-DD] [--status ...] [--out 文件或目录]
  status [--account 号]                           各号篇数与下载状态
  refix [--account 号] [--images] | refix <文章ID> ... [--images]
                                                  离线重新提取已存的正文（加 --images 会补下缺的图片）
  import <json文件|export目录> ...                 导入 weread-omni 的 JSON 输出或 export 目录

  --account 可写号 ID、该号任一带 __biz= 的文章链接，或库里已有的公众号名称（如 --account 某某研究所）
  --since 按“时间”筛选：有收录时间（列表时间）用收录时间，否则用发布时间；日期是北京时间 0 点
  --delay 秒  文章间隔，默认 8（sync / download / fetch）；--page-delay 秒  翻页间隔，默认 4（sync）
  --force     新结果不如本地已有版本时也覆盖（默认保留已有版本；sync / download / fetch / refix / import）`;

// ───────────────────────── output & errors ─────────────────────────
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});
const out = (...a) => console.log(...a);

class StopRun extends Error {}
class UsageError extends Error {}

function hintFor(err, inDoctor = false) {
  const code = err instanceof WereadError ? err.code : "";
  if (inDoctor && code === "TIMEOUT") return "微信读书接口没有响应：检查网络后再试；网络慢时可以设环境变量 WXMP_TIMEOUT_MS 调大超时。";
  if (inDoctor && (code === "PARSE" || code === "SPAWN")) {
    return "微信读书接口返回的内容和预期不一样：稍后再试；一直这样说明微信读书改了接口，本工具需要更新。";
  }
  if (code === -2041) return "微信读书要求人机验证：用手机打开微信读书 App 随便搜一下，完成滑块/验证码后再运行。";
  if (code === -2010) return "服务端限流：等几个小时再运行，不要重试。";
  if (code === "AUTH") return "没有登录或登录已失效：在自己的终端里运行 wxmp login，用微信扫码。";
  if (code === "NO_WEREAD") {
    if (process.env.WXMP_WEREAD_CLI) return "检查环境变量 WXMP_WEREAD_CLI 指向的文件。";
    if (process.env.WXMP_WEREAD_ROOT) return "检查环境变量 WXMP_WEREAD_ROOT 指向的目录（不用外部 weread-omni 时去掉这个变量）。";
    return "skill 目录不完整（缺 scripts/lib/embedded），请重新复制整个文件夹。";
  }
  if (code === "TIMEOUT") return "微信读书接口没有响应：先运行 wxmp doctor 检查；网络慢时可以设环境变量 WXMP_TIMEOUT_MS 调大超时。";
  if (code === "PARSE" || code === "SPAWN") return "微信读书接口运行异常：先运行 wxmp doctor 检查。";
  return "疑似微信反爬（环境异常/验证）：先停一段时间，或在浏览器里打开原文完成验证。";
}

// Upstream messages for run-stopping errors are English; say what happened in Chinese.
const STOP_TEXT = {
  [-2041]: "微信读书要求人机验证（-2041）",
  [-2010]: "微信读书限流（-2010）",
  AUTH: "没有登录微信读书，或登录已失效",
  SOURCE_WECHAT_CHALLENGE: "打开原文时微信要求验证",
  SOURCE_CLOUDFLARE_CHALLENGE: "打开原文时网站要求验证",
};
const stopText = (err) => STOP_TEXT[err?.code] ?? describeUnknown(err);

function failLoud(err, context) {
  throw new StopRun(`已停止（${context}）：${stopText(err)}\n${hintFor(err)}`);
}

const ARTICLE_ERRORS = {
  [-2013]: "无权限：付费内容或没有阅读权限（-2013）",
  [-2003]: "微信读书找不到这篇（ID 可能不对，-2003）",
  SOURCE_CONTENT_INSUFFICIENT: "原文页面没有可用正文：可能是付费、已删除，或只能在微信里打开",
  SOURCE_URL_INVALID: "原文链接无效",
  SOURCE_TIMEOUT: "打开原文超时",
  SOURCE_FETCH_FAILED: "打开原文失败",
  SOURCE_HTTP_ERROR: "打开原文失败（原文页返回了错误）",
  SOURCE_TOO_LARGE: "原文页面太大，没有下载",
  SOURCE_REDIRECT_INVALID: "原文链接被转到了别的地址，没有下载",
  SOURCE_REDIRECT_LIMIT: "原文链接转了太多次，没有下载",
  ARTICLE_UNAVAILABLE: "原文暂时无法读取",
};
// The article page could not be fetched at all. One such failure is that article's; three in a row
// with nothing going through in between are the network or a block, and stop a batch.
const PAGE_UNREACHABLE = new Set(["SOURCE_TIMEOUT", "SOURCE_FETCH_FAILED", "SOURCE_HTTP_ERROR"]);

/**
 * An error with no known meaning: say so in Chinese and keep the client's own words, which are the
 * only clue for troubleshooting.
 */
function describeUnknown(e) {
  const msg = e?.message ?? String(e);
  if (!(e instanceof WereadError) || OWN_CODES.has(e.code)) return msg;
  if (e.code === "NETWORK") return "连不上微信读书（网络不通或超时）";
  if (/non-JSON/.test(msg)) return "收到的不是微信读书的数据（可能被上网登录页或代理拦住了）";
  if (typeof e.code === "number") return `微信读书接口报错（代码 ${e.code}），原始信息：${clip(msg, 100)}`;
  if (/^微信读书接口异常退出/.test(msg)) return `${msg}；先运行 wxmp doctor 检查`;
  return `微信读书接口报错${e.code && e.code !== "CLI" ? `（${e.code}）` : ""}，原始信息：${clip(msg, 100)}`;
}
// Codes wxmp gives its own (Chinese) errors; their messages are shown as they are.
const OWN_CODES = new Set(["PARSE", "TIMEOUT", "SPAWN", "NO_WEREAD", "AUTH", "WECHAT"]);

/** Per-article failure text in Chinese (known upstream codes are not echoed in English). */
function articleError(e) {
  const known = ARTICLE_ERRORS[e?.code];
  return known ?? describeUnknown(e);
}

/** Local errors (SQLite, file system) in Chinese with a next step. */
function friendlyError(e) {
  const msg = e?.message ?? String(e);
  // fs errors carry the paths as properties; the message does not always quote them.
  const where = e?.dest ?? e?.path ?? msg.match(/'([^']+)'/)?.[1];
  const isDir = (p) => {
    try {
      return Boolean(p) && statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  if (/readonly database|read-only database/i.test(msg)) return `数据库是只读的，无法写入：${join(HOME, "wxmp.db")}。去掉文件的只读属性或检查目录权限后再试`;
  if (/database is locked|SQLITE_BUSY/i.test(msg)) return "数据库正被另一个程序占用，稍后再试";
  if (/unable to open database file/i.test(msg)) return `打不开数据库文件 ${join(HOME, "wxmp.db")}：检查它是不是一个文件（不能是文件夹），以及所在目录能不能写入`;
  if (/ENOSPC/.test(msg)) return "磁盘空间不足";
  if (/\b(EEXIST|ENOTDIR)\b/.test(msg)) {
    // Name the file that is in the way: the folder being created may sit several levels below it.
    let block = where;
    for (let p = where; p && dirname(p) !== p; p = dirname(p)) {
      try {
        if (statSync(p).isFile()) {
          block = p;
          break;
        }
      } catch {
        /* not there yet: keep walking up */
      }
    }
    return `路径冲突：${block ?? "目标路径"} 是一个文件，挡住了要建的文件夹（换个路径，或删掉那个文件）`;
  }
  // Windows reports a rename onto an existing folder as EPERM.
  if (/\bEISDIR\b/.test(msg) || (/\bEPERM\b/.test(msg) && isDir(e?.dest))) return `路径冲突：${where ?? "目标路径"} 是一个目录，这里需要的是文件`;
  if (/\b(EACCES|EPERM)\b/.test(msg)) return `没有权限写入：${where ?? HOME}`;
  return describeUnknown(e);
}

/** A captcha / "environment abnormal" page instead of an article. */
function looksLikeVerificationPage(html) {
  return /环境异常/.test(html) && /完成验证|去验证/.test(html) && /captcha/i.test(html);
}

// ───────────────────────── accounts ─────────────────────────
function accountName(store, accountId, fallback) {
  const a = accountId ? store.getAccount(accountId) : undefined;
  return a?.name || fallback || accountId || "未知公众号";
}

/** Name clipped to width, or the full ID when the account has no name yet. */
function accountLabel(store, accountId, width) {
  const a = accountId ? store.getAccount(accountId) : undefined;
  return a?.name ? clip(a.name, width) : accountId || "未知公众号";
}

// ───────────────────────── images ─────────────────────────
const IMG_LINK = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Local file already saved for the n-th picture of an article. */
function existingAsset(assetsDir, prefix, n) {
  if (!existsSync(assetsDir)) return undefined;
  const nn = String(n).padStart(2, "0");
  return readdirSync(assetsDir).find((f) => f.startsWith(`${prefix}_${nn}.`));
}

/** Point picture links at files saved by an earlier run (no network). */
function linkExistingImages(markdown, assetsDir, prefix) {
  const map = new Map();
  let n = 0;
  for (const m of markdown.matchAll(IMG_LINK)) {
    if (map.has(m[2])) continue;
    n += 1;
    const f = existingAsset(assetsDir, prefix, n);
    if (f) map.set(m[2], `assets/${f}`);
  }
  return markdown.replace(IMG_LINK, (all, alt, url) => (map.has(url) ? `![${alt}](${map.get(url)})` : all));
}

async function downloadImages(markdown, assetsDir, prefix, gapMs = 250) {
  let n = 0;
  let ok = 0;
  const failed = [];
  const map = new Map();
  const tried = new Set();
  for (const m of markdown.matchAll(IMG_LINK)) {
    const url = m[2];
    if (map.has(url) || tried.has(url)) continue;
    tried.add(url);
    n += 1;
    const have = existingAsset(assetsDir, prefix, n);
    if (have) {
      map.set(url, `assets/${have}`);
      ok += 1;
      continue;
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fmt = (url.match(/wx_fmt=(\w+)/)?.[1] || res.headers.get("content-type")?.split("/")[1] || "jpg").toLowerCase();
      const ext = { jpeg: "jpg", "svg+xml": "svg" }[fmt] || fmt.replace(/[^a-z0-9]/g, "") || "jpg";
      const file = `${prefix}_${String(n).padStart(2, "0")}.${ext}`;
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, file), Buffer.from(await res.arrayBuffer()));
      map.set(url, `assets/${file}`);
      ok += 1;
    } catch (e) {
      failed.push(`${url}（${e.message}）`);
    }
    if (gapMs) await sleep(gapMs);
  }
  const md = markdown.replace(IMG_LINK, (all, alt, url) => (map.has(url) ? `![${alt}](${map.get(url)})` : all));
  return { markdown: md, total: n, saved: ok, failed };
}

// ───────────────────────── article materialisation ─────────────────────────
/**
 * Turn a fetched page into a stored article: Markdown file, gzipped #js_content, DB row.
 * opts: { html?, fragment?, toolMd?, sha256?, pubTime?, docUrl?, accName?, partial?, images?, gapMs?,
 *         fetchedAt?, keepIfEmpty? } — keepIfEmpty (refix): leave the row alone when nothing can be re-extracted.
 */
async function materialize(store, row, opts) {
  const accountId = row.account_id || accountOfReview(row.review_id);
  if (opts.accName && accountId && !store.getAccount(accountId)?.name) store.upsertAccount({ accountId, name: opts.accName });
  const name = accountName(store, accountId, opts.accName);
  const fragment = opts.fragment ?? (opts.html ? jsContentFragment(opts.html) : null);
  const toolChars = opts.toolMd !== undefined ? markdownTextLength(opts.toolMd) : row.tool_chars ?? undefined;
  let markdown;
  let bodyChars;
  let images = 0;
  let media = 0;
  let status;
  const notes = [];
  if (fragment) {
    const r = await fragmentToMarkdown(fragment);
    markdown = r.markdown;
    bodyChars = r.chars;
    images = r.images;
    media = r.media ?? 0;
    if (opts.partial) status = "partial";
    else if (bodyChars < 50) status = "short";
    else if (toolChars !== undefined && toolChars < bodyChars * 0.8) status = "fixed";
    else status = "ok";
  } else if (opts.toolMd) {
    markdown = opts.toolMd;
    bodyChars = toolChars;
    images = (markdown.match(/!\[[^\]]*\]\(/g) || []).length;
    status = opts.partial ? "partial" : (toolChars ?? 0) >= 200 ? "ok" : "short";
    notes.push("页面没有标准正文区域（#js_content），用的是读取接口返回的文字");
  } else if (opts.keepIfEmpty) {
    return { status: row.status, skipped: true };
  } else {
    // Nothing usable came back: an earlier good copy stays (even with --force, there is nothing to
    // replace it with); otherwise the article is marked failed.
    if (hasGoodCopy(row)) {
      return { status: row.status, kept: true, failure: true, error: "这次没有拿到可用的页面内容，保留已有版本" };
    }
    store.markFailed(row.review_id, "没有可用的页面内容");
    return { status: "failed", failure: true, error: "没有可用的页面内容" };
  }
  // Never replace a good local copy with a worse one (lower status, or at least 20% less text: an
  // import without the raw page, a re-download that came back short, …) unless --force.
  const RANK = { ok: 3, fixed: 3, partial: 2, short: 1 };
  const hadFile = row.md_path && existsSync(absPath(row.md_path));
  if (!opts.force && hadFile && RANK[row.status] && (RANK[status] < RANK[row.status] || (bodyChars ?? 0) < (row.body_chars ?? 0) * 0.8)) {
    return {
      status: row.status,
      kept: true,
      thinner: true,
      error: `新结果（${status}，正文 ${bodyChars ?? 0} 字）不如已有版本（${row.status}，正文 ${row.body_chars ?? 0} 字），保留已有版本；确实要覆盖加 --force`,
    };
  }
  if (images > 0 && (status === "short" || (images >= 3 && (bodyChars ?? 0) < images * 30))) notes.push(`以图片为主（${images} 张图），文字多在图片里`);
  if (status === "partial") notes.push("付费文章，只拿到试读部分");
  if (media) notes.push(`含 ${media} 个视频/语音，Markdown 里只有占位`);
  const pubTime = opts.pubTime ?? row.pub_time ?? undefined;
  const fetchedAt = toBjIso(opts.fetchedAt ?? Date.now());
  // A title given with the download (it may have changed upstream) is used and saved only with it.
  const title = oneLine(opts.title || row.title) || "无标题";
  const dir = join(HOME, "articles", safeName(name, 40));
  const prefix = ridTag(row.review_id);
  const file = `${bj(pubTime || row.list_time, false) || "未知日期"}_${safeName(title)}_${prefix}.md`;
  mkdirSync(dir, { recursive: true });
  let imageNote = "";
  if (opts.images && images > 0) {
    const d = await downloadImages(markdown, join(dir, "assets"), prefix, opts.gapMs ?? 250);
    markdown = d.markdown;
    imageNote = d.total === images ? `本地存下 ${d.saved}/${d.total} 张` : `其中 ${d.total} 张不重复，本地存下 ${d.saved}/${d.total} 张`;
    if (d.failed.length) notes.push(`${d.failed.length} 张图下载失败，保留了原链接`);
    // Pictures that failed this time must not cost a copy whose pictures were all saved locally.
    const localLinks = (t) => (t.match(/\]\(assets\//g) || []).length;
    const oldText = !opts.force && d.failed.length && hadFile && statSync(absPath(row.md_path)).isFile() ? readFileSync(absPath(row.md_path), "utf8") : "";
    if (oldText && localLinks(markdown) < localLinks(oldText)) {
      return { status: row.status, kept: true, thinner: true, error: `这次有 ${d.failed.length} 张图没下载成功，已有版本的本地图片更全，保留已有版本；确实要覆盖加 --force` };
    }
  } else if (images > 0) {
    markdown = linkExistingImages(markdown, join(dir, "assets"), prefix);
  }
  const front = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `account: ${JSON.stringify(name)}`,
    `account_id: ${accountId}`,
    `review_id: ${row.review_id}`,
    `published: ${pubTime ? bj(pubTime) + " (北京时间)" : "未知"}`,
    `source: ${opts.docUrl || row.doc_url || ""}`,
    `fetched: ${bjIso(fetchedAt)} (北京时间)`,
    `status: ${status}`,
    ...(notes.length ? [`note: ${JSON.stringify(notes.join("；"))}`] : []),
    "---",
    "",
    `# ${title}`,
    "",
    "",
  ].join("\n");
  const mdPath = join(dir, file);
  // Both files are written to temp names first, so a failure (full disk, a file where a folder should
  // be, …) leaves the old Markdown, raw page and DB row all as they were. Then, inside one DB
  // transaction: the row is updated first (a read-only DB stops here, before any file changes), the
  // raw page and the Markdown move into place, the stale Markdown goes (its name depends on date and
  // title), and the transaction commits; any failure rolls the row back.
  const articlesRoot = join(HOME, "articles");
  const oldMd = absPath(row.md_path);
  let rawPath = absPath(row.raw_path);
  let rawTmp;
  const tmp = `${mdPath}.tmp-${process.pid}`;
  try {
    if (fragment) {
      rawPath = join(HOME, "raw", accountId || "unknown", `${safeName(row.review_id, 120)}.html.gz`);
      mkdirSync(dirname(rawPath), { recursive: true });
      rawTmp = `${rawPath}.tmp-${process.pid}`;
      writeFileSync(rawTmp, gzipSync(fragment));
    }
    writeFileSync(tmp, front + markdown + "\n", "utf8");
  } catch (e) {
    for (const t of [rawTmp, tmp]) if (t) rmSync(t, { force: true });
    throw e;
  }
  try {
    store.db.exec("begin immediate");
  } catch (e) {
    for (const t of [rawTmp, tmp]) if (t) rmSync(t, { force: true });
    throw e;
  }
  const staleMd = oldMd && oldMd !== mdPath && existsSync(oldMd) && !relative(articlesRoot, oldMd).startsWith("..") ? oldMd : undefined;
  // On a case-insensitive disk a title that only changed case names the same file.
  const sameFile = staleMd && staleMd.toLowerCase() === mdPath.toLowerCase();
  // Every file put in place inside the transaction can be undone: a file it replaces is copied aside
  // first (moved aside instead when the new name differs from it only in case), and a file that was
  // not there before is noted for removal. The backups go once the transaction has committed.
  const undo = [];
  const put = (from, to, moveOld) => {
    const old = moveOld ?? to;
    let had = false;
    try {
      had = statSync(old).isFile();
    } catch {
      /* nothing there yet */
    }
    const u = { path: old, bak: `${old}.bak-${process.pid}`, moved: Boolean(moveOld) };
    if (had) {
      if (moveOld) renameSync(old, u.bak);
      else {
        try {
          copyFileSync(old, u.bak);
        } catch (e) {
          rmSync(u.bak, { force: true }); // a partial copy (full disk, …) is no backup
          throw e;
        }
      }
      undo.push(u);
    }
    renameSync(from, to);
    u.replaced = true;
    if (moveOld || !had) undo.push({ path: to, created: true });
  };
  try {
    store.saveDownload(row.review_id, {
      status,
      toolChars,
      bodyChars,
      images,
      mdPath: relPath(mdPath),
      rawPath: relPath(rawPath),
      sha256: opts.sha256 ?? row.source_sha256 ?? undefined,
      pubTime,
      docUrl: opts.docUrl,
      title: opts.title,
      payType: opts.payType,
      fetchedAt,
      error: notes.length ? notes.join("；") : null,
    });
    if (rawTmp) {
      put(rawTmp, rawPath);
      rawTmp = undefined;
    }
    put(tmp, mdPath, sameFile ? staleMd : undefined);
    store.db.exec("commit");
  } catch (e) {
    try {
      store.db.exec("rollback");
    } catch {
      /* nothing to roll back */
    }
    for (const t of [rawTmp, tmp]) if (t) rmSync(t, { force: true });
    for (const u of undo.reverse()) {
      try {
        if (u.created) rmSync(u.path, { force: true });
        else if (u.moved || u.replaced) renameSync(u.bak, u.path);
        else rmSync(u.bak, { force: true }); // never replaced: the old file is still in place
      } catch {
        if (!u.created) console.error(`注意：没能把旧文件放回原处，它还在 ${u.bak}`);
      }
    }
    throw e;
  }
  // Committed. A backup or the Markdown under its old name that cannot be removed now is only a
  // leftover file: the download itself went through.
  for (const p of [...undo.filter((u) => u.bak).map((u) => u.bak), ...(staleMd && !sameFile ? [staleMd] : [])]) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* leftover */
    }
  }
  return { status, bodyChars, toolChars, images, imageNote, mdPath, notes };
}

// ───────────────────────── downloading ─────────────────────────
const GOOD = new Set(["ok", "fixed", "short", "partial"]);
/** The article has a usable local copy, which a new download only replaces when it is not worse. */
const hasGoodCopy = (row) => Boolean(row && GOOD.has(row.status) && row.md_path && existsSync(absPath(row.md_path)));

/**
 * True for an error with no known per-article meaning (not paid, not found, no usable content, …).
 * Three of those in a row stop a batch: whatever their codes or wording, the WeRead client is not working,
 * and going on would only keep sending requests.
 */
const isUnknownError = (e) => e instanceof WereadError && ARTICLE_ERRORS[e.code] === undefined;

/**
 * Network download of one article: review single (if needed) → read-article → materialize.
 * `row` may be a bare { review_id } for an ID that is not in the DB yet; nothing is written for it
 * unless WeRead knows the article. A failed re-download keeps the earlier good copy.
 */
async function downloadOne(store, row, { images, gapMs = 1500, force = false }) {
  let known = Boolean(store.getArticle(row.review_id));
  const hadGood = hasGoodCopy(row);
  // `failure` marks a result where nothing came through this time (the old copy may still be kept).
  const fail = (msg, e) => {
    const unknown = isUnknownError(e);
    const unreachable = e instanceof WereadError && PAGE_UNREACHABLE.has(e.code);
    if (hadGood) return { status: row.status, kept: true, failure: true, error: msg, unknown, unreachable };
    if (known) store.markFailed(row.review_id, msg);
    return { status: "failed", failure: true, error: msg, unknown, unreachable };
  };
  let docUrl = row.doc_url;
  let pubTime = row.pub_time;
  let accName;
  let fresh = {}; // title and pay type for an article with a good copy: saved only with an accepted download
  if (!docUrl || !pubTime) {
    let rv;
    try {
      rv = runWeread(["review", "single", row.review_id]);
    } catch (e) {
      if (isFatal(e)) failLoud(e, `review single ${row.review_id}`);
      return fail(articleError(e), e);
    }
    if (!isObj(rv?.review) || !isObj(rv.review.mpInfo)) throw new WereadError("PARSE", "微信读书接口输出格式不对：文章信息里没有 review.mpInfo");
    const mp = rv.review.mpInfo;
    docUrl = mp.doc_url || docUrl;
    pubTime = mp.time || pubTime;
    accName = mp.mp_name;
    const accountId = row.account_id || rv?.review?.belongBookId || accountOfReview(row.review_id);
    // An article with a good local copy keeps its stored title, publish time and link unless this
    // download is accepted (materialize saves them then); otherwise the metadata is recorded now.
    if (hadGood) {
      fresh = { title: mp.title, payType: mp.payType };
      store.upsertArticle({ reviewId: row.review_id, accountId });
    } else store.upsertArticle({ reviewId: row.review_id, accountId, docUrl, pubTime, title: mp.title, payType: mp.payType });
    known = true;
    row = store.getArticle(row.review_id);
    if (!docUrl) return fail("微信读书没有给出原文链接");
    if (gapMs) await sleep(gapMs);
  }
  let j;
  try {
    // The embedded client is told what is already known (the article ID and its pay type), so it only
    // downloads the page; an external weread-omni looks both up again.
    const have = wereadSource() === "embedded" ? ["--review-id", row.review_id, ...(Number.isInteger(row.pay_type) ? ["--pay-type", String(row.pay_type)] : [])] : [];
    j = runWeread(["public-accounts", "read-article", docUrl, ...have], { timeoutMs: 60_000 });
  } catch (e) {
    if (isFatal(e)) failLoud(e, `read-article ${row.review_id}`);
    return fail(articleError(e), e);
  }
  if (!isObj(j) || (typeof j.sourceSha256 !== "string" && typeof j.markdown !== "string" && typeof j.sourceHtml !== "string")) {
    throw new WereadError("PARSE", "微信读书接口输出格式不对：读正文的结果里没有 sourceSha256 / markdown");
  }
  // The embedded client hands the page over; weread-omni keeps it in its content library.
  const blob = typeof j.sourceHtml === "string" ? undefined : libraryBlobPath(j.sourceSha256);
  const html = typeof j.sourceHtml === "string" ? j.sourceHtml : blob ? readFileSync(blob, "utf8") : undefined;
  if (html && !jsContentFragment(html) && looksLikeVerificationPage(html)) {
    failLoud(new WereadError("WECHAT", "原文页面返回了微信的验证页"), `read-article ${row.review_id}`);
  }
  const published = Date.parse(j.publishedAt ?? "");
  return materialize(store, row, {
    html,
    // markdown is weread-omni's own extraction (compared with ours), or the embedded client's stand-in
    // for a page without the body container; a missing one only means there is nothing to compare.
    toolMd: typeof j.markdown === "string" ? j.markdown : undefined,
    sha256: j.sourceSha256,
    pubTime: Number.isFinite(published) ? Math.floor(published / 1000) : pubTime,
    docUrl: j.sourceUrl || docUrl,
    title: fresh.title,
    payType: fresh.payType,
    accName: j.accountName || accName,
    partial: j.status === "partial",
    images,
    gapMs: Math.min(250, gapMs),
    fetchedAt: Number.isFinite(Date.parse(j.fetchedAt ?? "")) ? j.fetchedAt : undefined,
    force,
  });
}

/** "成功 3 篇（其中修复 1）、失败 1 篇" — the per-run summary in words. */
function summarize(t) {
  const parts = [];
  const done = (t.ok ?? 0) + (t.fixed ?? 0);
  if (done) parts.push(`成功 ${done} 篇${t.fixed ? `（其中修复 ${t.fixed}）` : ""}`);
  if (t.partial) parts.push(`付费试读 ${t.partial} 篇`);
  if (t.short) parts.push(`短文 ${t.short} 篇`);
  if (t.kept) parts.push(`保留旧版 ${t.kept} 篇`);
  if (t.failed) parts.push(`失败 ${t.failed} 篇`);
  const text = parts.join("、") || "没有处理任何文章";
  return t.imgFailed ? `${text}；其中 ${t.imgFailed} 篇有图片没下载成功（保留了原链接，补图片的命令见上面那一行）` : text;
}

/** Something in the batch did not fully go through (exit code 1): failed, kept the old copy, or pictures missing. */
const incomplete = (t) => Boolean(t.failed || t.kept || t.imgFailed);

async function downloadMany(store, rows, { images, limit, delay, force = false, label = "download" }) {
  const todo = rows.slice(0, limit);
  if (rows.length > limit) out(`共 ${rows.length} 篇待下载，本次只下 ${limit} 篇（--limit 可调）。`);
  const tally = {};
  // Unexplained errors since the last article that went through. Known per-article failures (paid,
  // not found, no usable content) neither count nor reset it: the client may still be broken.
  let streak = 0;
  // Article pages that could not be fetched at all since the last article that went through.
  let unreachable = 0;
  for (const [i, row] of todo.entries()) {
    if (i > 0) await sleep(delay * 1000);
    let r;
    try {
      r = await downloadOne(store, row, { images, gapMs: Math.min(1500, delay * 1000), force });
    } catch (e) {
      // Stopped part-way (risk control, a busy database, …): say what was done before the error.
      if (i > 0) out(`下载结果：${summarize(tally)}（第 ${i + 1} 篇处中断）`);
      throw e;
    }
    const key = r.kept ? "kept" : r.status;
    tally[key] = (tally[key] || 0) + 1;
    const imgFailed = r.notes?.some((n) => /张图下载失败/.test(n));
    if (imgFailed) tally.imgFailed = (tally.imgFailed || 0) + 1;
    const title = clip(store.getArticle(row.review_id)?.title || row.title || row.review_id, 40);
    let line;
    // The keep reason is shown in full: it ends with how to override it (--force).
    if (r.kept) line = `${pad("保留旧版", 9)}${title}  ${r.thinner ? "" : "这次没下成："}${r.error}`;
    else if (r.status === "failed") line = `${pad("failed", 9)}${title}  ${clip(r.error, 100)}`;
    else line = `${pad(r.status, 9)}${title}  正文 ${r.bodyChars ?? "?"} 字  图 ${r.images ?? 0}${r.imageNote ? `（${r.imageNote}）` : ""}${r.notes?.length ? `  ${clip(r.notes.join("；"), 40)}` : ""}`;
    // Only the pictures are retried this way (from the stored page): no request to WeRead.
    if (imgFailed && !r.kept) line += `  补图片：refix ${row.review_id} --images`;
    out(`[${i + 1}/${todo.length}] ${line}`);
    // Three unexplained errors (whatever their codes) with nothing going through in between mean
    // the WeRead client itself is not working.
    const through = !r.failure && r.status !== "failed";
    if (r.unknown) streak += 1;
    else if (through) streak = 0;
    if (r.unreachable) unreachable += 1;
    else if (through) unreachable = 0;
    if (streak >= 3) {
      out(`下载结果：${summarize(tally)}`);
      throw new StopRun(`已停止（${label}）：微信读书接口连续 3 篇返回无法识别的错误，最后一次：${clip(r.error, 80)}\n先运行 wxmp doctor 检查；问题不在单篇文章，继续下载只会全部失败。`);
    }
    // Three pages in a row that cannot be opened are not three bad articles: the network is down, or
    // WeChat is refusing this machine for now. Going on would mark the whole batch failed.
    if (unreachable >= 3) {
      out(`下载结果：${summarize(tally)}`);
      throw new StopRun(`已停止（${label}）：连续 3 篇都打不开原文页，最后一次：${clip(r.error, 80)}\n多半是网络问题，或暂时被微信限制：检查网络，过一段时间再运行。这几篇已标成失败，之后用 download --status failed 重试。`);
    }
  }
  return tally;
}

// ───────────────────────── search & watch ─────────────────────────
function printAccounts(store, ids, top) {
  for (const id of ids.slice(0, top)) {
    const a = store.getAccount(id) || {};
    out(`${id}  ${pad(clip(a.name || "", 16), 34)}${a.watch ? "[已关注] " : ""}${clip(a.intro, 40)}`);
  }
}

async function cmdSearch(store, [kind, ...rest], o) {
  const keyword = rest.join(" ").trim();
  if (!keyword || !["account", "article"].includes(kind)) throw new UsageError("用法：search account|article <关键词>");
  if (kind === "article" && o.refresh) throw new UsageError("search article 不支持 --refresh（文章搜索每次都联网，没有缓存）");
  const top = Number(o.top ?? 10);
  const maxIdx = Number(o["max-idx"] ?? 0);
  const scope = kind === "account" ? 2 : 4;
  if (scope === 2 && maxIdx === 0 && !o.refresh) {
    const last = store.lastSearch(keyword, 2);
    if (last && Date.now() - Date.parse(last.at) < 30 * 86400_000) {
      const ids = last.result_ids.split(",").filter(Boolean);
      const shownCached = Math.min(ids.length, top);
      out(`（缓存：北京时间 ${bjIso(last.at)} 搜过，共 ${last.total ?? ids.length} 个${shownCached < ids.length ? `，这里显示前 ${shownCached} 个（--top 可调）` : ""}${last.next_idx != null ? `，还有更多：--max-idx ${last.next_idx}` : ""}；--refresh 重新搜）`);
      printAccounts(store, ids, top);
      return;
    }
  }
  const args = ["search", "books", keyword, "--scope", String(scope), "--count", "20"];
  if (maxIdx) args.push("--max-idx", String(maxIdx));
  let r;
  try {
    r = runWeread(args);
  } catch (e) {
    if (isFatal(e)) failLoud(e, `search ${keyword}`);
    throw e;
  }
  if (!Array.isArray(r?.books)) throw new WereadError("PARSE", "微信读书接口输出格式不对：搜索结果里没有 books");
  if (r.books.length && !r.books.some((b) => isObj(b?.bookInfo))) throw new WereadError("PARSE", "微信读书接口输出格式不对：搜索结果的条目里没有 bookInfo");
  const ids = [];
  for (const b of r.books ?? []) {
    const info = b.bookInfo ?? {};
    if (!ACCOUNT_ID.test(info.bookId || "")) continue;
    store.upsertAccount({ accountId: info.bookId, name: info.title, intro: info.intro, cover: info.cover, keyword: scope === 2 ? keyword : undefined });
    if (scope === 4 && b.mpContentInfo?.reviewId) {
      const m = b.mpContentInfo;
      store.upsertArticle({ reviewId: m.reviewId, accountId: info.bookId, title: m.title, abstract: m.abstract });
      ids.push(m.reviewId);
    } else ids.push(info.bookId);
  }
  const nextIdx = r.hasMore ? r.books?.at(-1)?.searchIdx ?? null : null;
  store.logSearch(keyword, scope, r.totalCount, ids, { pageStart: maxIdx, nextIdx });
  const shown = Math.min(ids.length, top);
  out(`共 ${r.totalCount ?? ids.length} 个结果${shown < ids.length ? `，这里显示前 ${shown} 个（--top 可调）` : ""}${nextIdx != null ? `（还有更多：--max-idx ${nextIdx}）` : ""}`);
  if (scope === 2) printAccounts(store, ids, top);
  else {
    for (const rid of ids.slice(0, top)) {
      const a = store.getArticle(rid);
      out(`${pad(accountLabel(store, a.account_id, 10), 22)}${clip(a.title, 44)}\n${" ".repeat(22)}${rid}${a.abstract ? `\n${" ".repeat(22)}摘要：${clip(a.abstract, 60)}` : ""}`);
    }
  }
}

async function cmdWatch(store, [sub, target, ...extra], o) {
  if (extra.length) throw new UsageError(`多余的参数：${extra.join(" ")}`);
  if (o.name !== undefined && sub !== "add") throw new UsageError("--name 只能和 watch add 一起用");
  if (sub === "ls" || !sub) {
    if (target) throw new UsageError(`多余的参数：${target}`);
    const rows = store.watched();
    if (!rows.length) return out("关注列表为空。用 `watch add <号ID|文章链接>` 添加。");
    for (const a of rows) {
      const n = store.all("select count(*) c from articles where account_id=?", a.account_id)[0].c;
      out(`${a.account_id}  ${pad(clip(a.name || "（名称待同步）", 16), 34)}${n} 篇  上次同步 ${a.last_sync ? bjIso(a.last_sync) + "（北京）" : "从未"}`);
    }
    return;
  }
  if (!["add", "rm"].includes(sub)) throw new UsageError("用法：watch add|rm <号ID|文章链接>，或 watch ls");
  const t = String(target ?? "").trim();
  const id = ACCOUNT_ID.test(t) ? t : accountIdFromUrl(t);
  if (!id) throw new UsageError("需要 MP_WXS_数字 形式的号 ID，或一篇该号的 mp.weixin.qq.com 文章链接");
  if (sub === "add") {
    const known = store.getAccount(id);
    store.upsertAccount({ accountId: id, name: o.name });
    store.setWatch(id, true);
    const a = store.getAccount(id);
    out(`已关注 ${id}${a.name ? ` ${a.name}` : ""}${known ? "" : "（还没确认这个号存在，首次 sync 时会确认）"}`);
  } else {
    const a = store.getAccount(id);
    if (!a?.watch) return out(`本来就没有关注 ${id}`);
    store.setWatch(id, false);
    out(`已取消关注 ${id}（已存的文章保留）`);
  }
}

// ───────────────────────── sync ─────────────────────────
/**
 * Page through one account's listing (newest first, 50 per page).
 *
 * - Incremental run (account fully synced before): stop at the first page with nothing new.
 * - Backfill (first sync, explicit --since/--days, or a scan left unfinished): page until the cutoff.
 * - An unfinished scan (stopped by an error or by --max-pages) is remembered as pending_cutoff +
 *   resume_offset. The next plain sync first reads from the top until it reaches known articles,
 *   then jumps to resume_offset and keeps going down to the pending cutoff. Offsets only drift
 *   downwards as new articles arrive, so the jump re-reads a little and never skips.
 * - last_sync only moves when a scan completes, and an explicit window only moves it when it reached
 *   back at least as far as the next plain sync would start.
 */
async function syncAccount(store, account, o) {
  const id = account.account_id;
  const now = Math.floor(Date.now() / 1000);
  const explicit = Boolean(o.since || o.days);
  const prevResume = account.pending_cutoff != null ? account.resume_offset ?? 0 : null;
  const pending = !explicit && account.pending_cutoff != null ? { cutoff: account.pending_cutoff, offset: prevResume } : null;
  // The default first look-back (30 days) happens once per account. A run with an explicit short
  // window (--days / --since) does not count as that first sync, so a quick "latest articles" check
  // does not stop the later plain sync from filling the 30 days.
  const initialCutoff = now - 30 * 86400;
  const initial = !explicit && !account.initial_done;
  const incrementalCutoff = account.last_sync ? Math.floor(Date.parse(account.last_sync) / 1000) - 3 * 86400 : initialCutoff;
  let cutoff = parseDate(o.since) ?? (o.days ? now - Number(o.days) * 86400 : initial ? initialCutoff : incrementalCutoff);
  if (pending) cutoff = Math.min(cutoff, pending.cutoff);
  const backfill = explicit || initial || Boolean(pending);
  const maxPages = Number(o["max-pages"] ?? 10);
  const pageDelay = Number(o["page-delay"] ?? 4) * 1000;
  let named = Boolean(store.getAccount(id)?.name);
  let pages = 0;
  let added = 0;
  let complete = false;
  let emptyList = false;
  let jumped = !pending;
  let offset = 0;

  const readPage = async () => {
    if (pages > 0) await sleep(pageDelay);
    const args = ["public-accounts", "articles", id, "--count", "50"];
    if (offset) args.push("--offset", String(offset));
    let page;
    try {
      page = runWeread(args);
    } catch (e) {
      if (isFatal(e)) failLoud(e, `articles ${id}`);
      if (e.code === -2003) throw new Error(pages === 0 && offset === 0 ? "微信读书说找不到这个号（-2003）：ID 可能不对，也可能是临时问题" : `读取第 ${Math.floor(offset / 50) + 1} 页失败（-2003），已存的不受影响`);
      throw e;
    }
    if (!Array.isArray(page?.articles)) throw new WereadError("PARSE", "微信读书接口输出格式不对：文章列表里没有 articles");
    const timeOf = (a) => (a.createTime == null || a.createTime === "" ? NaN : Number(a.createTime));
    if (page.articles.some((a) => !isObj(a) || typeof a.reviewId !== "string" || !a.reviewId || !(timeOf(a) > 0))) {
      throw new WereadError("PARSE", "微信读书接口输出格式不对：文章列表里有条目缺少文章 ID 或收录时间");
    }
    if (pages === 0) store.upsertAccount({ accountId: id });
    pages += 1;
    let newHere = 0;
    let oldest = Infinity;
    let first;
    let firstNew = false; // was the page's first article unknown before this page?
    const pushTimes = new Set();
    for (const a of page.articles) {
      const t = timeOf(a);
      const isFirst = first === undefined;
      first ??= a.reviewId;
      pushTimes.add(t);
      oldest = Math.min(oldest, t);
      if (t < cutoff) continue;
      const isNew = store.upsertArticle({ reviewId: a.reviewId, accountId: id, title: a.mpInfo?.title, listTime: t, payType: a.mpInfo?.payType });
      if (isNew) newHere += 1;
      if (isFirst) firstNew = isNew;
    }
    added += newHere;
    if (!named && first) {
      named = true; // one attempt per run
      try {
        const rv = runWeread(["review", "single", first]);
        if (rv?.review?.mpInfo?.mp_name) store.upsertAccount({ accountId: id, name: rv.review.mpInfo.mp_name });
      } catch (e) {
        if (isFatal(e)) failLoud(e, `review single ${first}`);
      }
    }
    // The list pages by push (群发; WeRead calls each one a chapter): --offset and --count are numbers
    // of pushes, and every article of a returned push comes back, all with the push's createTime.
    // The nextOffset field in the CLI output counts articles, which would skip pushes whenever a push
    // holds several articles, so the next offset is computed here from a safe lower bound on the
    // pushes the page holds: the number of distinct push times, and at least ceil(articles / 8), as a
    // push carries at most 8 articles. Pushes sharing a timestamp only make the next page start early
    // (re-reads are deduplicated), and the second bound keeps a list where most pushes share one
    // timestamp from crawling a push at a time. Capping at 50 (a full page) keeps articles of one push
    // with differing timestamps from pushing the offset past a page. A full page advances at least 7
    // (50 articles / 8), which OVERLAP below relies on.
    // A page with fewer than 50 articles does not prove the list ended: a push whose article is gone
    // upstream can keep its place in the list, so 50 pushes come back as 49 articles in the middle of
    // it (seen on a real account with one article per push). Only an empty page ends the list; a short
    // page advances by the same lower bound, so the page after a real last page is the empty one.
    const items = page.articles.length;
    const nextOffset = items ? offset + Math.min(50, Math.max(pushTimes.size, Math.ceil(items / 8))) : undefined;
    return { newHere, firstNew, oldest, items, nextOffset, short: items > 0 && items < 50 };
  };

  // Phase A (only with a pending scan): read from the top until a page has nothing new.
  // Phase B: the scan proper. Each phase has its own --max-pages budget.
  // The jump back to resume_offset lands OVERLAP pushes early: pushes deleted upstream shift the
  // rest up, and the (deduplicated) overlap keeps that from skipping anything. It stays below the
  // smallest advance of a full page (7, see readPage), so every run moves the scan forward, even a
  // one-page run on a list whose pushes all share one timestamp.
  // After the jump, the first page read must start with an article stored before; if it starts with a
  // new one, more pushes than the overlap were deleted above the resume point, so step back a page at a
  // time (never above phase A's end) until it does, then go on from the furthest page already read.
  const OVERLAP = 6;
  let pagesA = 0;
  let pagesB = 0;
  let cappedInA = false;
  let anchor; // { floor, ahead, endSeen } while checking the jump
  // A short page advances by less than a full one, possibly by less than OVERLAP, and the page after
  // it is usually the empty one that ends the list. A run that stops right after a short page
  // therefore saves its position OVERLAP further on, so the next run lands exactly on the page still
  // to read instead of in front of the short page again (which a small --max-pages would repeat for
  // ever). Landing without an overlap is safe: the check after the jump steps back whenever that page
  // is empty or starts with an article not seen before.
  let afterShort = false;
  const resumePoint = () => offset + (afterShort ? OVERLAP : 0);
  // Progress is saved before every page, so even a killed run (no finally) resumes where it was.
  const progress = () => (jumped && pending ? resumePoint() : prevResume != null ? Math.max(resumePoint(), prevResume) : resumePoint());
  try {
    for (;;) {
      if (pagesA + pagesB > 0) store.setPending(id, cutoff, progress());
      const inA = !jumped;
      const p = await readPage();
      // WeRead answers a list request for an account it does not know with an empty list, not an error.
      if (pagesA + pagesB === 0 && offset === 0 && !p.items) emptyList = true;
      if (inA) pagesA += 1;
      else pagesB += 1;
      if (anchor) {
        const ended = !p.items || p.nextOffset === undefined || p.oldest < cutoff;
        // An empty page means the list is now shorter than the resume point (articles deleted
        // upstream): the unread part lies before it, so step back as for an unknown first article.
        if ((p.firstNew || !p.items) && offset > anchor.floor) {
          anchor.ahead = Math.max(anchor.ahead, p.nextOffset ?? offset);
          anchor.endSeen ||= ended;
          offset = Math.max(anchor.floor, offset - 50);
          afterShort = false;
          // An empty page only tells where the list ends: the first one of a run does not use up the
          // page budget, so even a one-page run reads the page it steps back to (and can finish
          // there). Any further empty pages count, so --max-pages still bounds the requests.
          if (!p.items && !anchor.refunded) {
            anchor.refunded = true;
            pagesB -= 1;
          }
          if (pagesB >= maxPages) break;
          continue;
        }
        const { ahead, endSeen } = anchor;
        anchor = undefined;
        if (endSeen) {
          complete = true;
          break;
        }
        if (!ended && ahead > (p.nextOffset ?? 0)) {
          offset = ahead;
          afterShort = false;
          if (pagesB >= maxPages) break;
          continue;
        }
      }
      if (!p.items || p.nextOffset === undefined || p.oldest < cutoff) {
        complete = true;
        break;
      }
      if (inA && p.newHere === 0) {
        jumped = true; // caught up with known articles: resume the unfinished scan
        offset = Math.max(p.nextOffset, pending.offset - OVERLAP);
        afterShort = false;
        if (offset > p.nextOffset) anchor = { floor: p.nextOffset, ahead: 0, endSeen: false };
        continue;
      }
      if (!backfill && p.newHere === 0) {
        complete = true;
        break;
      }
      offset = p.nextOffset;
      afterShort = p.short;
      if ((inA ? pagesA : pagesB) >= maxPages) {
        cappedInA = inA && Boolean(pending);
        break;
      }
    }
  } finally {
    const acc = store.getAccount(id);
    if (complete) {
      if (acc?.pending_cutoff == null || cutoff <= acc.pending_cutoff) store.clearPending(id);
      if (!explicit || cutoff <= initialCutoff) store.setInitialDone(id);
      // A short explicit window (--days 1) did not look as far back as the next plain sync would
      // start, so moving last_sync would make that sync skip the articles in between.
      if (!explicit || cutoff <= incrementalCutoff) store.touchSync(id);
    } else if (acc && (pagesA + pagesB > 0 || acc.pending_cutoff != null)) {
      // Stopped before reaching the old resume point (in phase A, or in a run that started at the
      // top): the earlier scan already covered down to it, so keep it instead of re-reading.
      store.setPending(id, cutoff, progress());
    }
  }
  const resumeAt = store.getAccount(id)?.resume_offset ?? offset;
  return { added, pages, pagesA, pagesB, cutoff, complete, maxPages, cappedInA, emptyList, resumePage: Math.floor(resumeAt / 50) + 1 };
}

async function cmdSync(store, args, o) {
  if (args.length) throw new UsageError(`多余的参数：${args.join(" ")}`);
  const forDownload = ["limit", "images", "force"].filter((k) => o[k] !== undefined);
  if (forDownload.length && !o.download) throw new UsageError(`sync 的 ${forDownload.map((k) => `--${k}`).join("、")} 只在加了 --download 时有用（运行 help 查看用法）`);
  const accounts = o.account ? [store.getAccount(o.account) ?? { account_id: o.account }] : store.watched();
  if (!accounts.length) return out("没有关注的号。先 `watch add <号ID>`，或用 --account 指定。");
  const synced = [];
  let failures = 0;
  for (const [i, acc] of accounts.entries()) {
    if (i > 0) await sleep(Number(o["page-delay"] ?? 4) * 1000);
    let r;
    try {
      r = await syncAccount(store, acc, o);
    } catch (e) {
      if (e instanceof StopRun || (e instanceof WereadError && isFatal(e))) throw e;
      failures += 1;
      let msg = friendlyError(e);
      if (/找不到这个号/.test(msg) && store.getAccount(acc.account_id)?.watch) msg += `；稍后再试一次，确认 ID 确实不对再 watch rm ${acc.account_id}`;
      out(`${pad(accountLabel(store, acc.account_id, 16), 34)}同步失败：${clip(msg, 100)}`);
      continue;
    }
    synced.push(acc.account_id);
    const pagesText = r.pagesA ? `翻了 ${r.pagesA + r.pagesB} 页：顶部 ${r.pagesA} 页、补旧 ${r.pagesB} 页` : `翻了 ${r.pages} 页`;
    out(`${pad(accountLabel(store, acc.account_id, 16), 34)}新增 ${r.added} 篇（${pagesText}，截止 ${bj(r.cutoff, false)}）`);
    if (r.emptyList && !store.all("select 1 from articles where account_id=? limit 1", acc.account_id).length) {
      out(`  微信读书给出的文章列表是空的：号 ID 可能不对（用 search account 或该号的一篇文章链接核对），也可能这个号在微信读书里没有文章。`);
    }
    if (!r.complete && r.cappedInA) {
      out(`  这次的 ${r.maxPages} 页都用在追新文章上了，积压还没开始补。下次 sync 会继续；新文章很多时请加大 --max-pages。`);
    } else if (!r.complete) {
      out(`  已翻满 ${r.maxPages} 页，还没到截止日 ${bj(r.cutoff, false)}。下次 sync 会从第 ${r.resumePage} 页附近接着补；想一次补完可以加大 --max-pages。`);
    }
  }
  if (o.download && synced.length) {
    const rows = store.all(`select * from articles where status='new' and ${TRACKED} and account_id in (${synced.map(() => "?").join(",")}) order by ${ARTICLE_TIME} desc`, ...synced);
    if (rows.length) {
      out(`\n开始下载未下载的文章（共 ${rows.length} 篇）……`);
      const t = await downloadMany(store, rows, { images: o.images, limit: Number(o.limit ?? 50), delay: Number(o.delay ?? 8), force: o.force, label: "sync" });
      out(`下载结果：${summarize(t)}`);
      if (incomplete(t)) failures += 1;
    } else out("\n没有未下载的文章。");
  }
  if (failures) process.exitCode = 1;
}

// ───────────────────────── download / fetch / refix ─────────────────────────
function selectRows(store, o, defaultStatus) {
  if (o.review?.length) {
    const filters = ["account", "status", "since"].filter((k) => o[k]);
    if (filters.length) throw new UsageError(`指定了文章 ID 时不能再用 ${filters.map((k) => `--${k}`).join("、")} 筛选（二选一）`);
    return o.review.map((r) => store.getArticle(r) ?? { review_id: r, account_id: accountOfReview(r) });
  }
  const status = (o.status || defaultStatus).split(",").map((s) => s.trim()).filter(Boolean);
  const where = [`status in (${status.map(() => "?").join(",")})`, TRACKED];
  const params = [...status];
  if (o.account) {
    where.push("account_id=?");
    params.push(o.account);
  }
  if (o.since) {
    where.push(`${ARTICLE_TIME}>=?`);
    params.push(parseDate(o.since));
  }
  return store.all(`select * from articles where ${where.join(" and ")} order by ${ARTICLE_TIME} desc`, ...params);
}

async function cmdDownload(store, args, o) {
  // Article IDs may also be given as plain arguments: download ID1 ID2 ...
  const bad = args.filter((a) => !REVIEW_ID.test(a));
  if (bad.length) throw new UsageError(`不是有效的文章 ID：${bad.join("、")}（文章 ID 形如 MP_WXS_数字_xxxx）`);
  if (args.length) o.review = [...(o.review ?? []), ...args];
  const rows = selectRows(store, o, "new");
  if (!rows.length) return out("没有符合条件的待下载文章。");
  const t = await downloadMany(store, rows, { images: o.images, limit: Number(o.limit ?? 50), delay: Number(o.delay ?? 8), force: o.force });
  out(`下载结果：${summarize(t)}`);
  if (incomplete(t)) process.exitCode = 1;
}

async function cmdFetch(store, urls, o) {
  if (!urls.length) throw new UsageError("用法：fetch <mp.weixin.qq.com 文章链接> ...");
  const rows = [];
  let bad = 0;
  let streak = 0; // consecutive resolve failures with errors that have no known meaning
  try {
    for (const [i, raw] of urls.entries()) {
      const url = String(raw).trim();
      if (!url) {
        bad += 1;
        out("跳过：空链接");
        continue;
      }
      if (!/^https?:\/\/mp\.weixin\.qq\.com\/s/.test(url)) {
        bad += 1;
        out(`跳过（不是公众号文章链接，要以 https://mp.weixin.qq.com/s 开头）：${url}`);
        continue;
      }
      // A full link has &mid=…&idx=…&sn=…; cmd.exe cuts a link at its first & when wxmp.cmd is run
      // from PowerShell, leaving only ?__biz=….
      if (/[?&]__biz=/.test(url) && !/[?&]sn=/.test(url)) {
        bad += 1;
        out(`跳过（链接不完整，缺 &mid=…&sn=… 部分）：${url}\n  在 PowerShell 里用 wxmp.cmd 时，链接里第一个 & 之后的部分会被截掉：改用 node scripts/wxmp.mjs fetch "链接"，或在 cmd 里运行。`);
        continue;
      }
      if (i > 0 && Number(o.delay ?? 8) > 0) await sleep(1500);
      let r;
      try {
        r = runWeread(["public-accounts", "resolve-article", url]);
      } catch (e) {
        if (isFatal(e)) failLoud(e, `resolve-article ${url}`);
        bad += 1;
        if (/no review ID/i.test(e.message)) out(`微信读书没有收录这篇：${url}`);
        else out(`解析失败：${clip(articleError(e), 80)}  ${url}`);
        // "not indexed" is a known per-link answer: it neither counts nor resets the streak
        if (!/no review ID/i.test(e.message) && isUnknownError(e)) streak += 1;
        if (streak >= 3) throw new StopRun(`已停止（fetch）：微信读书接口连续 3 个链接返回无法识别的错误，最后一次：${clip(articleError(e), 80)}\n先运行 wxmp doctor 检查；问题不在单个链接，继续只会全部失败。`);
        continue;
      }
      streak = 0;
      // The client fails when an article is not indexed, so a successful answer always carries an ID.
      if (!isObj(r) || typeof (r.reviewId ?? r.reviewIds?.[0]?.reviewId) !== "string") {
        throw new WereadError("PARSE", "微信读书接口输出格式不对：解析链接的结果里没有文章 ID");
      }
      const reviewId = r.reviewId ?? r.reviewIds?.[0]?.reviewId;
      if (!reviewId) {
        bad += 1;
        out(`微信读书没有收录这篇：${url}`);
        continue;
      }
      const accountId = accountIdFromUrl(url) ?? accountOfReview(reviewId);
      store.upsertAccount({ accountId });
      // An article with a good local copy keeps its stored link unless the download is accepted
      // (materialize saves the link then); the link given here is used for this download either way.
      store.upsertArticle(hasGoodCopy(store.getArticle(reviewId)) ? { reviewId, accountId } : { reviewId, accountId, docUrl: url });
      rows.push({ ...store.getArticle(reviewId), doc_url: url });
    }
  } catch (e) {
    // Stopped while resolving the links: the ones resolved so far are recorded but not downloaded.
    if (rows.length) out(`停下前已解析好 ${rows.length} 个链接，还没下载；问题解决后运行：wxmp download ${rows.map((x) => x.review_id).join(" ")}`);
    throw e;
  }
  if (rows.length) {
    const t = await downloadMany(store, rows, { images: o.images, limit: rows.length, delay: Number(o.delay ?? 8), force: o.force, label: "fetch" });
    out(`下载结果：${summarize(t)}`);
    if (incomplete(t)) bad += 1;
  }
  if (bad || !rows.length) process.exitCode = 1;
}

async function cmdRefix(store, args, o) {
  // Article IDs may also be given as plain arguments: refix ID1 ID2 ...
  const bad = args.filter((a) => !REVIEW_ID.test(a));
  if (bad.length) throw new UsageError(`不是有效的文章 ID：${bad.join("、")}（文章 ID 形如 MP_WXS_数字_xxxx）`);
  if (args.length) o.review = [...(o.review ?? []), ...args];
  const rows = selectRows(store, o, "ok,fixed,short,partial");
  let n = 0;
  let kept = 0;
  let noSource = 0;
  let imgFailed = 0;
  for (const row of rows) {
    if (!row.first_seen) {
      out(`跳过（库里没有这篇）：${row.review_id}`);
      noSource += 1;
      continue;
    }
    let fragment;
    let html;
    if (row.raw_path && existsSync(absPath(row.raw_path))) fragment = readMaybeGz(absPath(row.raw_path));
    else if (libraryBlobPath(row.source_sha256)) html = readFileSync(libraryBlobPath(row.source_sha256), "utf8");
    else {
      // Nothing stored to re-extract from: say so for articles asked for by ID, count the rest.
      noSource += 1;
      if (o.review?.length) out(`${pad("跳过", 9)}${clip(row.title, 44)}  没有存下原始页面，无法离线重新提取（重新下载用 download ${row.review_id}${["new", "failed"].includes(row.status) ? "" : " --force"}）`);
      continue;
    }
    const r = await materialize(store, row, { fragment, html, images: o.images, partial: row.status === "partial", fetchedAt: row.fetched_at ?? undefined, force: o.force, keepIfEmpty: true });
    if (r.skipped) {
      out(`${pad("保留", 9)}${clip(row.title, 44)}  没有可重新提取的正文区域，状态不变（${row.status}）`);
      continue;
    }
    if (r.kept) {
      kept += 1;
      out(`${pad("保留旧版", 9)}${clip(row.title, 44)}  ${r.error}`);
      continue;
    }
    n += 1;
    if (r.notes?.some((x) => /张图下载失败/.test(x))) imgFailed += 1;
    out(`${pad(r.status, 9)}${clip(row.title, 44)}  正文 ${r.bodyChars} 字  图 ${r.images}${r.imageNote ? `（${r.imageNote}）` : ""}${r.notes?.length ? `  ${clip(r.notes.join("；"), 40)}` : ""}`);
  }
  out(
    `重新提取 ${n} 篇${kept ? `，保留旧版 ${kept} 篇（新结果不如已有版本；确实要覆盖加 --force）` : ""}${noSource ? `，${noSource} 篇没有可用的原始页面` : ""}${imgFailed ? `，${imgFailed} 篇有图片没下载成功（保留了原链接，稍后再运行一次同样的 refix 即可只补这些图片）` : ""}。`,
  );
  if (kept || imgFailed || (noSource && o.review?.length)) process.exitCode = 1;
}

// ───────────────────────── import ─────────────────────────
function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

async function importExportDir(store, dir, force = false) {
  let manifest;
  try {
    manifest = readJson(join(dir, "manifest.json"));
  } catch {
    out(`跳过（manifest.json 损坏）：${dir}`);
    return { n: 0, missed: 0 };
  }
  let n = 0;
  let missed = 0; // items kept at the local copy or unreadable
  for (const item of Array.isArray(manifest?.items) ? manifest.items : []) {
    if (!isObj(item) || typeof item.reviewId !== "string" || typeof item.directory !== "string") continue;
    const d = join(dir, item.directory);
    let meta;
    let mp;
    try {
      meta = readJson(join(d, "metadata.json"));
      mp = existsSync(join(d, "mp-info.json")) ? readJson(join(d, "mp-info.json")) : meta?.review?.review?.mpInfo ?? {};
    } catch {
      out(`  跳过（元数据损坏）：${item.directory}`);
      missed += 1;
      continue;
    }
    const accountId = item.accountId ?? accountOfReview(item.reviewId);
    const pubTime = Number(mp?.time) > 0 ? Number(mp.time) : undefined;
    const docUrl = mp?.doc_url ?? item.sourceUrl;
    // An article already in the DB keeps its fields unless the import is accepted (materialize saves
    // the publish time and link then); a new one is recorded in full.
    store.upsertArticle(
      store.getArticle(item.reviewId)
        ? { reviewId: item.reviewId, accountId }
        : { reviewId: item.reviewId, accountId, title: mp?.title ?? meta?.article?.mpInfo?.title, listTime: meta?.article?.createTime, pubTime, docUrl, payType: mp?.payType },
    );
    const html = existsSync(join(d, "source.html")) ? readFileSync(join(d, "source.html"), "utf8") : undefined;
    const toolMd = existsSync(join(d, "article.md")) ? readFileSync(join(d, "article.md"), "utf8") : undefined;
    const r = await materialize(store, store.getArticle(item.reviewId), {
      html,
      toolMd,
      docUrl,
      pubTime,
      title: mp?.title,
      accName: mp?.mp_name,
      partial: item.state === "partial",
      fetchedAt: manifest.createdAt,
      force,
    });
    if (r.kept) {
      out(`  保留已有版本 ${clip(mp?.title, 40)}：${r.error}`);
      missed += 1;
      continue;
    }
    out(`  ${pad(r.status, 7)} ${clip(mp?.title, 40)}  正文 ${r.bodyChars ?? 0} 字（工具原来 ${r.toolChars ?? 0} 字）`);
    n += 1;
  }
  return { n, missed };
}

async function cmdImport(store, paths, o = {}) {
  if (!paths.length) throw new UsageError("用法：import <json文件|export目录> ...");
  let used = 0;
  for (const p of paths) if (await importOne(store, p, o.force)) used += 1;
  if (used < paths.length) process.exitCode = 1;
}

/** Import one path; returns true when it was recognised and imported. */
async function importOne(store, p, force = false) {
  {
    if (!p || !existsSync(p)) {
      out(`跳过（不存在）：${p}`);
      return false;
    }
    if (statSync(p).isDirectory()) {
      if (existsSync(join(p, "manifest.json"))) {
        const { n, missed } = await importExportDir(store, p, force);
        out(`export 目录 ${basename(p)}：导入 ${n} 篇${missed ? `，${missed} 篇没有导入（见上面的说明）` : ""}`);
        // Exit code 1 when anything in the folder was not imported, as for a single file.
        return n > 0 && missed === 0;
      }
      out(`跳过（不是 export 目录）：${p}`);

      return false;
    }
    let j;
    try {
      j = readJson(p);
    } catch {
      out(`跳过（不是 JSON）：${p}`);
      return false;
    }
    if (!isObj(j)) {
      out(`跳过（认不出的 JSON）：${p}`);
      return false;
    }
    if (Array.isArray(j.books)) {
      const keyword = typeof j.parts?.[0] === "string" ? j.parts[0] : "";
      const isArticle = j.books.some((b) => isObj(b?.mpContentInfo));
      const ids = [];
      for (const b of j.books) {
        const info = isObj(b?.bookInfo) ? b.bookInfo : {};
        if (!ACCOUNT_ID.test(info.bookId || "")) continue;
        store.upsertAccount({ accountId: info.bookId, name: info.title, intro: info.intro, cover: info.cover, keyword: isArticle || !keyword ? undefined : keyword });
        if (isArticle && typeof b.mpContentInfo?.reviewId === "string") {
          store.upsertArticle({ reviewId: b.mpContentInfo.reviewId, accountId: info.bookId, title: b.mpContentInfo.title, abstract: b.mpContentInfo.abstract });
          ids.push(b.mpContentInfo.reviewId);
        } else ids.push(info.bookId);
      }
      // Page position is unknown for an imported file, so it is logged with page_start -1 and never used as the cache.
      if (keyword) store.logSearch(keyword, isArticle ? 4 : 2, j.totalCount, ids, { dedupe: true, pageStart: -1, nextIdx: j.hasMore ? j.books.at(-1)?.searchIdx ?? null : null });
      out(`${basename(p)}：${isArticle ? "文章" : "公众号"}搜索${keyword ? `「${keyword}」` : "（没有关键词，不记入搜索记录）"}，${ids.length} 条`);
    } else if (Array.isArray(j.articles) && ACCOUNT_ID.test(j.accountId || "")) {
      let added = 0;
      store.upsertAccount({ accountId: j.accountId });
      for (const a of j.articles) {
        if (!isObj(a) || typeof a.reviewId !== "string") continue;
        if (store.upsertArticle({ reviewId: a.reviewId, accountId: j.accountId, title: a.mpInfo?.title, listTime: a.createTime, payType: a.mpInfo?.payType })) added += 1;
      }
      out(`${basename(p)}：${j.accountId} 文章列表 ${j.articles.length} 条，新增 ${added}`);
    } else if (isObj(j.review?.mpInfo) && typeof j.reviewId === "string") {
      const mp = j.review.mpInfo;
      const accountId = j.review.belongBookId || accountOfReview(j.reviewId);
      if (accountId) store.upsertAccount({ accountId, name: mp.mp_name });
      store.upsertArticle({ reviewId: j.reviewId, accountId, title: mp.title, pubTime: mp.time, docUrl: mp.doc_url, payType: mp.payType });
      // A downloaded article keeps the title of its copy: show what is stored, not what was given.
      const stored = store.getArticle(j.reviewId)?.title;
      out(`${basename(p)}：文章元数据 ${clip(stored || mp.title, 30)}${stored && mp.title && stored !== mp.title ? "（本地已有下载版本，标题、时间、链接沿用它的）" : ""}`);
    } else if (typeof j.reviewId === "string" && accountOfReview(j.reviewId) && typeof j.sourceSha256 === "string") {
      const blob = libraryBlobPath(j.sourceSha256);
      if (!blob && typeof j.markdown !== "string") {
        out(`跳过（找不到原始网页缓存，也没有正文）：${p}`);
        return false;
      }
      const accountId = accountOfReview(j.reviewId);
      const published = Date.parse(j.publishedAt ?? "");
      const pubTime = Number.isFinite(published) ? Math.floor(published / 1000) : undefined;
      // An article already in the DB keeps its fields unless the import is accepted (materialize saves
      // the publish time and link then); a new one is recorded in full.
      store.upsertArticle(store.getArticle(j.reviewId) ? { reviewId: j.reviewId, accountId } : { reviewId: j.reviewId, accountId, title: j.title, pubTime, docUrl: j.sourceUrl });
      const r = await materialize(store, store.getArticle(j.reviewId), {
        html: blob ? readFileSync(blob, "utf8") : undefined,
        toolMd: typeof j.markdown === "string" ? j.markdown : "",
        sha256: j.sourceSha256,
        docUrl: j.sourceUrl,
        pubTime,
        title: j.title,
        accName: j.accountName,
        partial: j.status === "partial",
        fetchedAt: j.fetchedAt ?? j.readAt ?? j.cachedAt ?? undefined,
        force,
      });
      if (r.kept) {
        out(`${basename(p)}：保留已有版本：${r.error}`);
        return false;
      }
      out(`${basename(p)}：正文 ${pad(r.status, 6)} ${clip(j.title, 30)}  ${r.bodyChars ?? 0} 字（工具原来 ${r.toolChars ?? 0} 字）`);
    } else {
      out(`跳过（认不出的 JSON）：${p}`);
      return false;
    }
    return true;
  }
}

// ───────────────────────── list / export / status ─────────────────────────
/**
 * One CSV cell. Line breaks become a space (one record per line for line-based tools), and text that
 * Excel would run as a formula (= + - @ …, also after leading spaces) gets a leading apostrophe.
 */
// Every kind of line break: CR, LF, vertical tab, form feed, Unicode line and paragraph separators.
const CSV_BREAKS = new RegExp(`\\s*[\\r\\n\\v\\f${String.fromCharCode(0x85, 0x2028, 0x2029)}]+\\s*`, "g");
function csvCell(v) {
  let t = String(v ?? "").replace(CSV_BREAKS, " ");
  if (/^\s*[=+\-@]/.test(t) || /^\t/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
}

async function cmdExport(store, args, o) {
  if (args.length) throw new UsageError(`多余的参数：${args.join(" ")}`);
  const rows = selectRows(store, o, "new,ok,fixed,short,partial,failed");
  const header = ["公众号", "发布时间(北京)", "收录时间(北京)", "抓取时间(北京)", "标题", "状态", "正文字数", "图片数", "本地文件", "原文链接", "摘要", "reviewId", "说明"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    const local = r.md_path ? relPath(r.md_path) : "";
    lines.push(
      [accountName(store, r.account_id), bj(r.pub_time), bj(r.list_time), bjIso(r.fetched_at), r.title, r.status, r.body_chars, r.images, local, r.doc_url, r.abstract, r.review_id, r.error]
        .map(csvCell)
        .join(","),
    );
  }
  const today = bj(Math.floor(Date.now() / 1000), false);
  const defaultName = `wxmp_${o.account ? safeName(accountName(store, o.account), 20) + "_" : ""}${today}.csv`;
  let file = o.out || join(HOME, "exports", defaultName);
  // "--out somewhere/" or an existing folder: write the default file name inside it.
  if (/[\\/]$/.test(file) || (existsSync(file) && statSync(file).isDirectory())) file = join(file, defaultName);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "\uFEFF" + lines.join("\r\n") + "\r\n", "utf8");
  out(`导出 ${rows.length} 条 → ${file}`);
}

async function cmdList(store, args, o) {
  if (args.length) throw new UsageError(`多余的参数：${args.join(" ")}`);
  const top = Number(o.top ?? 10);
  const where = [TRACKED];
  const params = [];
  if (o.account) {
    where.push("account_id=?");
    params.push(o.account);
  }
  if (o.status) {
    const st = o.status.split(",").map((s) => s.trim()).filter(Boolean);
    where.push(`status in (${st.map(() => "?").join(",")})`);
    params.push(...st);
  }
  if (o.since) {
    where.push(`${ARTICLE_TIME}>=?`);
    params.push(parseDate(o.since));
  }
  const rows = store.all(`select * from articles where ${where.join(" and ")} order by ${ARTICLE_TIME} desc limit ?`, ...params, top);
  if (!rows.length) return out("没有符合条件的文章。");
  out(`${pad("时间(北京)", 18)}${pad("状态", 8)}${pad("公众号", 20)}标题`);
  for (const r of rows) {
    const why = r.status === "failed" && r.error ? `  ← ${clip(r.error, 40)}` : "";
    out(`${pad(bj(r.list_time ?? r.pub_time), 18)}${pad(r.status, 8)}${pad(accountLabel(store, r.account_id, 8), 20)}${clip(r.title, 48)}${why}`);
  }
  out("（时间：收录时间；没有收录时间的用发布时间）");
}

async function cmdStatus(store, args, o) {
  if (args.length) throw new UsageError(`多余的参数：${args.join(" ")}`);
  const only = o.account ? "where a.account_id = ?" : "";
  const rows = store.all(
    `select a.account_id, a.name, a.watch, a.last_sync, count(r.review_id) total,
       sum(r.status='new') new, sum(r.status in ('ok','fixed')) done, sum(r.status='fixed') fixed,
       sum(r.status='short') short, sum(r.status='partial') partial, sum(r.status='failed') failed,
       max(coalesce(r.list_time, r.pub_time)) latest
     from accounts a left join articles r on r.account_id=a.account_id and ${TRACKED.replace(/(list_time|pub_time|doc_url|status)/g, "r.$1")}
     ${only}
     group by a.account_id having total>0 or a.watch=1 or a.account_id = ? order by a.watch desc, total desc`,
    ...(o.account ? [o.account] : []),
    o.account ?? "",
  );
  // Two accounts can share a display name; tell them apart by the end of the ID.
  if (o.account && !rows.length) {
    out(`库里没有这个号：${o.account}（先 watch add 关注，或 sync --account 拉一次）`);
    process.exitCode = 1;
    return;
  }
  const nameCount = new Map();
  for (const r of rows) if (r.name) nameCount.set(r.name, (nameCount.get(r.name) ?? 0) + 1);
  const label = (r) => (!r.name ? r.account_id : nameCount.get(r.name) > 1 ? `${clip(r.name, 5)}(${r.account_id.slice(-4)})` : clip(r.name, 9));
  out(`数据目录 ${HOME}    （时间均为北京时间）${store.readOnly ? "  [只读打开]" : ""}`);
  out(`${pad("公众号", 20)}${pad("关注", 6)}${pad("总数", 6)}${pad("未下", 6)}${pad("已下", 6)}${pad("其中修复", 10)}${pad("短/付费/失败", 14)}最新文章`);
  for (const r of rows) {
    out(
      `${pad(label(r), 20)}${pad(r.watch ? "是" : "", 6)}${pad(r.total, 6)}${pad(r.new ?? 0, 6)}${pad(r.done ?? 0, 6)}${pad(r.fixed ?? 0, 10)}${pad(`${r.short ?? 0}/${r.partial ?? 0}/${r.failed ?? 0}`, 14)}${bj(r.latest)}`,
    );
  }
  const s = store.all("select count(*) n, max(at) last from searches")[0];
  out(`搜索记录 ${s.n} 次，最近 ${s.last ? bjIso(s.last) : "无"}`);
}

// ───────────────────────── login ─────────────────────────
/** Log in to WeRead with a WeChat QR code (shown in the terminal by the client). */
function cmdLogin() {
  const cli = wereadCli();
  if (!process.stdout.isTTY) out("提示：二维码要显示在终端里。看不到二维码时，请在自己的终端里、skill 目录下运行 ./wxmp login（Windows PowerShell 里是 .\\wxmp.cmd login）。");
  const r = spawnSync(process.execPath, ["--no-warnings", cli, "login"], { stdio: "inherit", env: { ...process.env, WEREAD_READONLY: "1" } });
  if (r.error) throw new WereadError("SPAWN", `启动登录失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`登录没有完成（退出码 ${r.status}），重新运行 wxmp login 再扫一次`);
  out("\n登录完成。运行 wxmp doctor 检查环境。");
}

// ───────────────────────── doctor ─────────────────────────
async function cmdDoctor() {
  let ok = true;
  const line = (good, label, detail) => {
    out(`${good ? "[ OK ]" : "[FAIL]"} ${pad(label, 16)}${detail}`);
    if (!good) ok = false;
  };
  const [maj, min] = process.versions.node.split(".").map(Number);
  line(maj > 22 || (maj === 22 && min >= 13), "Node.js", `${process.version}（需要 ≥ 22.13）`);
  try {
    const source = wereadSource();
    if (source === "test") line(true, "微信读书客户端", `使用 WXMP_WEREAD_CLI=${wereadCli()}`);
    else if (source === "external") line(true, "微信读书客户端", `外部 weread-omni ${wereadVersion() ?? "?"}  ${wereadRoot()}（WXMP_WEREAD_ROOT）`);
    else {
      wereadCli(); // throws when the copy lacks it
      line(true, "微信读书客户端", `内置（请求和登录模块取自 weread-omni ${EMBEDDED_FROM}）`);
    }
  } catch (e) {
    line(false, "微信读书客户端", `${e.message}  → ${hintFor(e)}`);
  }
  try {
    const d = runWeread(["doctor"], { timeoutMs: 60_000 });
    if (!isObj(d?.auth) && typeof d?.ok !== "boolean") throw new WereadError("PARSE", "微信读书接口自检的输出格式不对");
    const authed = d?.auth?.status === "authenticated";
    line(authed, "微信读书连接", authed ? "已登录，连接正常" : "未登录：在自己的终端里运行 wxmp login，用微信扫码");
  } catch (e) {
    if (e instanceof WereadError && e.code === "AUTH") line(false, "微信读书连接", "未登录或登录已失效 → 在自己的终端里运行 wxmp login，用微信扫码");
    else line(false, "微信读书连接", `${stopText(e)}  → ${e instanceof WereadError && isFatal(e) ? hintFor(e, true) : "检查网络后重试"}`);
  }
  try {
    const info = markdownInfo();
    const r = await fragmentToMarkdown('<div id="js_content"><p>自检<strong>正文</strong></p><img data-src="https://example.com/a.png"></div>');
    const good = r.markdown.includes("**正文**") && r.markdown.includes("![](https://example.com/a.png)");
    line(good, "正文转换", `turndown ${info.turndown} + gfm ${info.gfm}（skill 自带）${good ? "" : "：自检输出不对"}`);
  } catch (e) {
    line(false, "正文转换", e.message);
  }
  try {
    mkdirSync(HOME, { recursive: true });
    const probe = join(HOME, `.write-test-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe);
    const store = openStore();
    const n = store.all(`select count(*) n from articles where ${TRACKED}`)[0].n;
    line(true, "数据目录", `${HOME}（库里 ${n} 篇）`);
  } catch (e) {
    line(false, "数据目录", `${HOME} 不可用：${e.message}`);
  }
  out(ok ? "\n环境正常，可以使用。" : "\n有问题，按上面 [FAIL] 行的提示处理后再运行 doctor。");
  if (!ok) process.exitCode = 1;
}

// ───────────────────────── arguments ─────────────────────────
const OPTIONS = {
  refresh: { type: "boolean" },
  top: { type: "string" },
  "max-idx": { type: "string" },
  name: { type: "string" },
  account: { type: "string" },
  days: { type: "string" },
  since: { type: "string" },
  "max-pages": { type: "string" },
  download: { type: "boolean" },
  images: { type: "boolean" },
  limit: { type: "string" },
  delay: { type: "string" },
  "page-delay": { type: "string" },
  review: { type: "string", multiple: true },
  status: { type: "string" },
  out: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  force: { type: "boolean" },
};
// Which options each command understands; anything else is a usage error rather than silently ignored.
const ALLOWED = {
  doctor: [],
  login: [],
  search: ["refresh", "top", "max-idx"],
  watch: ["name"],
  sync: ["account", "days", "since", "max-pages", "download", "images", "limit", "delay", "page-delay", "force"],
  download: ["account", "review", "status", "since", "limit", "images", "delay", "force"],
  fetch: ["images", "delay", "force"],
  list: ["account", "top", "status", "since"],
  export: ["account", "since", "status", "out"],
  status: ["account"],
  refix: ["account", "review", "images", "force"],
  import: ["force"],
};
const INTEGER = { top: [1, 1000], "max-idx": [0, 1e9], days: [1, 3650], "max-pages": [1, 200], limit: [1, 1000] };
const SECONDS = { delay: [0, 600], "page-delay": [0, 600] };
const STATUSES = new Set(["new", "ok", "fixed", "short", "partial", "failed"]);
const REVIEW_ID = /^MP_WXS_\d+_[A-Za-z0-9_~-]+$/;

/** parseArgs messages are English; say the same thing in Chinese. */
function translateParseError(raw) {
  const msg = raw.replace(/\s*<value>/g, "");
  let m;
  if ((m = msg.match(/Unknown option '([^']+)'/))) return `未知参数 ${m[1]}`;
  if ((m = msg.match(/Option '([^']+)'(?: \([^)]*\))? argument is ambiguous/))) return `${m[1]} 的值不能以 - 开头`;
  if ((m = msg.match(/Option '([^']+)'(?: \([^)]*\))? argument missing/))) return `${m[1]} 后面要跟一个值`;
  if ((m = msg.match(/Option '([^']+)'.*does not take an argument/))) return `${m[1]} 不需要值`;
  return msg;
}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    throw new UsageError(translateParseError(e.message));
  }
  const o = parsed.values;
  for (const k of ["account", "since", "status", "name", "out"]) {
    if (o[k] !== undefined) {
      o[k] = o[k].trim();
      if (!o[k]) throw new UsageError(`--${k} 不能为空`);
    }
  }
  for (const [k, [lo, hi]] of Object.entries(INTEGER)) {
    if (o[k] === undefined) continue;
    if (!/^\d+$/.test(o[k]) || Number(o[k]) < lo || Number(o[k]) > hi) throw new UsageError(`--${k} 应为 ${lo}–${hi} 之间的整数，收到「${o[k]}」`);
  }
  for (const [k, [lo, hi]] of Object.entries(SECONDS)) {
    if (o[k] === undefined) continue;
    if (!/^\d+(\.\d+)?$/.test(o[k]) || Number(o[k]) < lo || Number(o[k]) > hi) throw new UsageError(`--${k} 应为 ${lo}–${hi} 之间的秒数，收到「${o[k]}」`);
  }
  if (o.since && o.days) throw new UsageError("--since 和 --days 只能用一个");
  if (o.since) {
    try {
      parseDate(o.since);
    } catch (e) {
      throw new UsageError(e.message);
    }
  }
  if (o.status) {
    const list = o.status.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length) throw new UsageError("--status 不能为空");
    const bad = list.filter((s) => !STATUSES.has(s));
    if (bad.length) throw new UsageError(`--status 只能是 ${[...STATUSES].join(",")}，收到「${bad.join(",")}」`);
  }
  if (o.review) {
    o.review = o.review.flatMap((r) => r.split(",")).map((r) => r.trim());
    if (o.review.some((r) => !r)) throw new UsageError("--review 不能为空");
    const bad = o.review.filter((r) => !REVIEW_ID.test(r));
    if (bad.length) throw new UsageError(`--review 要写文章 ID（形如 MP_WXS_数字_xxxx），收到「${bad.join("、")}」`);
  }
  return { o, positionals: parsed.positionals };
}

/** --account accepts an ID, an article URL of that account, or an exact account name. */
function resolveAccount(store, value) {
  if (ACCOUNT_ID.test(value)) return value;
  if (REVIEW_ID.test(value)) throw new UsageError(`--account 要写公众号（MP_WXS_数字），「${value}」是文章 ID`);
  if (/^https?:\/\//i.test(value)) {
    const id = accountIdFromUrl(value);
    if (!id) throw new UsageError("这个链接里没有有效的公众号 ID（__biz），需要 mp.weixin.qq.com 的文章链接");
    return id;
  }
  const hits = store.accountsNamed(value);
  if (!hits.length) throw new UsageError(`本地没有叫「${value}」的号，先用 search account 找到 ID。`);
  if (hits.length === 1) return hits[0].account_id;
  const watched = hits.filter((h) => h.watch);
  if (watched.length === 1) return watched[0].account_id;
  throw new UsageError(`有 ${hits.length} 个号叫「${value}」，请用 ID：${hits.map((h) => h.account_id).join("、")}`);
}

// ───────────────────────── one networked run per data dir ─────────────────────────
class LockError extends Error {}
// Networked commands (parallel runs would repeat requests) and the offline writers (they rewrite the
// same article files and rows a download writes).
const LOCKED = new Set(["search", "sync", "download", "fetch", "refix", "import"]);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * Parallel runs on one data dir would repeat each other's requests and defeat the pacing, which is
 * exactly what WeRead's risk control punishes. A lock file holds the pid; a dead pid is taken over.
 */
function acquireLock(cmd) {
  const lockPath = join(HOME, "wxmp.lock");
  mkdirSync(HOME, { recursive: true });
  if (existsSync(lockPath) && statSync(lockPath).isDirectory()) {
    throw new Error(`锁文件的位置被一个目录占用：${lockPath}。这不是 wxmp 建的，删掉这个目录再试。`);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, at: toBjIso(), cmd }));
      closeSync(fd);
      process.on("exit", () => {
        try {
          if (JSON.parse(readFileSync(lockPath, "utf8")).pid === process.pid) rmSync(lockPath, { force: true });
        } catch {
          /* already gone */
        }
      });
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let info = {};
      try {
        info = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        /* unreadable lock: treat as stale */
      }
      if (Number.isInteger(info.pid) && info.pid !== process.pid && isAlive(info.pid)) {
        throw new LockError(`另一个 wxmp 正在使用这个数据目录（pid ${info.pid}${info.at ? `，北京时间 ${bjIso(info.at)} 开始` : ""}${info.cmd ? `：${info.cmd}` : ""}）。等它结束再运行；同时联网会重复请求、触发风控。`);
      }
      // Take the stale lock over by renaming it away: only one process can rename it. If what got
      // moved is not the lock just inspected, another process took over first: put it back, re-check.
      const stale = `${lockPath}.stale-${process.pid}`;
      try {
        renameSync(lockPath, stale);
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
      let moved = {};
      try {
        moved = JSON.parse(readFileSync(stale, "utf8"));
      } catch {
        /* unreadable: it was the stale one */
      }
      if (moved.pid !== info.pid) {
        // Not the stale lock: another process took over first. Its lock goes back (never deleted),
        // then the check starts again and finds it alive.
        renameSync(stale, lockPath);
        continue;
      }
      rmSync(stale, { force: true });
    }
  }
  throw new LockError(`无法创建锁文件：${lockPath}`);
}

// ───────────────────────── main ─────────────────────────
const READ_ONLY_OK = new Set(["list", "status", "export"]);
const commands = { search: cmdSearch, watch: cmdWatch, sync: cmdSync, download: cmdDownload, fetch: cmdFetch, refix: cmdRefix, list: cmdList, import: (s, a, o) => cmdImport(s, a, o), export: cmdExport, status: cmdStatus };

async function main() {
  const { o, positionals } = parseCli(process.argv.slice(2));
  const [cmd, ...args] = positionals;
  if (o.version || cmd === "version") return out(`wxmp ${VERSION}`);
  if (!cmd || o.help || cmd === "help") return out(HELP);
  // node:sqlite (the data store) arrived in Node 22.5 and lost its flag in 22.13.
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`wxmp 需要 Node.js 22.13 或更高，当前是 ${process.version}。到 https://nodejs.org 安装新版后再运行。`);
    process.exit(1);
  }
  if (!Object.hasOwn(commands, cmd) && !["doctor", "login"].includes(cmd)) throw new UsageError(`未知命令：${cmd}（运行 help 查看可用命令）`);
  const unsupported = Object.keys(o).filter((k) => !ALLOWED[cmd].includes(k));
  if (unsupported.length) throw new UsageError(`${cmd} 不支持 ${unsupported.map((k) => `--${k}`).join("、")}（运行 help 查看用法）`);
  // These two work without the data directory.
  if (["doctor", "login"].includes(cmd)) {
    if (args.length) throw new UsageError(`多余的参数：${args.join(" ")}`);
    return cmd === "doctor" ? cmdDoctor() : cmdLogin();
  }
  const store = openStore({ allowReadOnly: READ_ONLY_OK.has(cmd) });
  if (o.account) o.account = resolveAccount(store, o.account);
  if (LOCKED.has(cmd)) acquireLock([cmd, ...args].join(" "));
  await commands[cmd](store, args, o);
}

try {
  await main();
} catch (e) {
  if (e instanceof StopRun) {
    console.error(e.message);
    process.exit(2);
  }
  if (e instanceof WereadError && isFatal(e)) {
    console.error(`已停止：${stopText(e)}\n${hintFor(e)}`);
    process.exit(2);
  }
  if (e instanceof UsageError) {
    console.error(`参数错误：${e.message}`);
    process.exit(1);
  }
  if (e instanceof LockError) {
    console.error(`已有任务在运行：${e.message}`);
    process.exit(1);
  }
  console.error(`出错：${friendlyError(e)}`);
  process.exit(1);
}
