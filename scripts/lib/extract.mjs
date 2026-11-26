// Body extraction for WeChat article pages.
//
// The article body lives in the #js_content container. It is cut out of the page first, lazy images
// get their real src, media cards become placeholders, tables are normalized, and only then is the
// fragment converted to Markdown.
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { homedir } from "node:os";
import { htmlToMarkdown } from "./markdown.mjs";

const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;

/**
 * The outer HTML of the element whose id attribute is exactly "js_content" (normally a div), or null.
 * Comments and scripts are ignored while matching, and depth is tracked on the container's own tag name.
 */
export function jsContentFragment(html) {
  const src = String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  const startRe = /<([a-z][a-z0-9-]*)\b(?=[^>]*?\sid\s*=\s*(["']?)js_content\2(?:[\s/>]|$))[^>]*>/gi;
  let m;
  let start = -1;
  let tag;
  while ((m = startRe.exec(src))) {
    // Skip matches that sit inside a <script> block.
    const before = src.slice(0, m.index);
    const lastOpen = before.lastIndexOf("<script");
    if (lastOpen >= 0 && lastOpen > before.lastIndexOf("</script")) continue;
    start = m.index;
    tag = m[1].toLowerCase();
    break;
  }
  if (start < 0) return null;
  if (VOID.test(tag)) return null;
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>|<script\\b[\\s\\S]*?</script>`, "gi");
  tagRe.lastIndex = start;
  let depth = 0;
  while ((m = tagRe.exec(src))) {
    if (m[0].startsWith("<script")) continue;
    if (m[1] === "/") depth -= 1;
    else if (!m[0].endsWith("/>")) depth += 1;
    if (depth === 0) return src.slice(start, m.index + m[0].length);
  }
  return src.slice(start);
}

/**
 * Make images Markdown-ready: lazy `data-src` / `data-original` (quoted or not) becomes `src`;
 * inline `data:` URIs with no real source are dropped (they are placeholders or tracking pixels).
 */
// An opening tag whose quoted attribute values may contain ">".
const openTag = (name) => new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
const cardTag = (name) => new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>(?:[\\s\\S]*?<\\/${name}>)?`, "gi");

export function fixLazyImages(fragment) {
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  };
  return fragment.replace(openTag("img"), (tag) => {
    const lazy = attr(tag, "data-src") || attr(tag, "data-original");
    const src = attr(tag, "src");
    const real = lazy && !/^data:/i.test(lazy) ? lazy : src && !/^data:/i.test(src) ? src : undefined;
    const alt = attr(tag, "alt");
    // WeChat emoji are tiny sprites: keep their text form ("[微笑]") when the alt has one, drop the rest
    // (many carry only a generic alt such as "Image").
    if (/emoji|emotion/i.test(attr(tag, "class") || "") || /res\.wx\.qq\.com\/.*(emoji|emotion|Expression)/i.test(real || "")) {
      return alt && /^\[[^\]]{1,8}\]$/.test(alt.trim()) ? escapeHtml(alt.trim()) : "";
    }
    if (!real) return "";
    return `<img src="${real.replace(/"/g, "&quot;")}"${alt ? ` alt="${alt.replace(/"/g, "&quot;")}"` : ""}>`;
  });
}

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Video and audio cards (视频号, 腾讯视频, 语音) have no Markdown form; leave a visible placeholder.
 * Returns { html, media } where media counts the cards that were replaced.
 */
export function mediaPlaceholders(fragment) {
  let media = 0;
  // Attribute values on these cards are often entity-encoded twice ("&amp;nbsp;").
  const clean = (v) => decodeEntities(decodeEntities(v)).replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const attr = (tag, name) => {
    const v = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))?.slice(1).find((x) => x !== undefined);
    return v === undefined ? undefined : clean(v);
  };
  const place = (label, url) => {
    media += 1;
    // 【】 rather than [] so the placeholder survives Markdown escaping as plain, readable text; the
    // link text is short so the (long, escaped) URL appears only once.
    return /^https?:\/\//i.test(url || "") ? `<p>【${escapeHtml(label)}：<a href="${url.replace(/"/g, "&quot;")}">打开</a>】</p>` : `<p>【${escapeHtml(label)}】</p>`;
  };
  let html = fragment
    .replace(cardTag("mp-common-videosnap"), (tag) => place(`视频号视频${attr(tag, "data-desc") ? `：${attr(tag, "data-desc")}` : ""}`))
    .replace(cardTag("mpvoice"), (tag) => place(`语音${attr(tag, "name") ? `：${attr(tag, "name")}` : ""}`))
    .replace(cardTag("mp-common-mpaudio"), (tag) => place(`语音${attr(tag, "name") ? `：${attr(tag, "name")}` : ""}`))
    .replace(cardTag("iframe"), (tag) => {
      const url = attr(tag, "data-src") || attr(tag, "src");
      return /video|v\.qq\.com|mpvideo/i.test(tag) ? place("视频", url) : "";
    })
    .replace(cardTag("video"), (tag) => place("视频", attr(tag, "src") || attr(tag, "data-src")));
  return { html, media };
}

/**
 * Make tables Markdown-friendly:
 * - a "table" with at most one cell per row, or one that wraps another table, is page layout: unwrap
 *   it into blocks (an inner data table survives as a table);
 * - colspan and rowspan are laid out on a grid, padding with empty cells so columns stay aligned;
 * - GFM needs a header row, so the first row is promoted to <th> when the table has none.
 * Innermost tables are handled first; converted tables use temporary tag names so the outer passes
 * do not mistake their rows and cells for their own.
 */
export function normalizeTables(fragment) {
  const one = /<table\b(?:(?!<table\b)[\s\S])*?<\/table>/gi;
  const num = (attrs, name) => Math.min(Math.max(Number(attrs.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i"))?.[1] ?? 1), 1), 20);
  let html = fragment;
  for (let guard = 0; guard < 20; guard++) {
    let changed = false;
    html = html.replace(one, (table) => {
      changed = true;
      const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
      const cellsOf = (row) => [...row.matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)];
      const counts = rows.map((r) => cellsOf(r).length);
      if (!rows.length || Math.max(...counts) <= 1 || /<tbl__x>/.test(table)) {
        return rows.flatMap((r) => cellsOf(r).map((c) => `<div>${c[3]}</div>`)).join("") || table.replace(/<\/?(table|tbody|thead|tfoot|tr|td|th|colgroup|col)\b[^>]*>/gi, "");
      }
      const hasTh = /<th\b/i.test(table);
      const carry = []; // carry[col]: rows below that a rowspan still covers
      const out = rows.map((row, i) => {
        const head = !hasTh && i === 0;
        const empty = `<${head ? "th" : "td"}__x></${head ? "th" : "td"}__x>`;
        const cellsOut = [];
        let col = 0;
        const skipCarried = () => {
          while (carry[col] > 0) {
            carry[col] -= 1;
            cellsOut.push(empty);
            col += 1;
          }
        };
        for (const c of cellsOf(row)) {
          skipCarried();
          const kind = head || c[1] === "h" ? "th" : "td";
          const span = num(c[2], "colspan");
          const rows2 = num(c[2], "rowspan");
          cellsOut.push(`<${kind}__x>${c[3]}</${kind}__x>`);
          for (let s = 1; s < span; s++) cellsOut.push(`<${kind}__x></${kind}__x>`);
          if (rows2 > 1) for (let s = 0; s < span; s++) carry[col + s] = rows2 - 1;
          col += span;
        }
        while (col < carry.length) {
          if (carry[col] > 0) carry[col] -= 1;
          cellsOut.push(empty);
          col += 1;
        }
        return `<tr__x>${cellsOut.join("")}</tr__x>`;
      });
      return `<tbl__x>${out.join("")}</tbl__x>`;
    });
    if (!changed) break;
  }
  return html.replace(/<(\/?)(tbl|tr|td|th)__x>/g, (m, slash, t) => `<${slash}${t === "tbl" ? "table" : t}>`);
}

const NAMED = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", ensp: " ", emsp: " ", thinsp: " ", hellip: "…", mdash: "—", ndash: "–", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·" };
const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });

const INVISIBLE = /[\s​-‏⁠﻿　]+/g;

/** Visible text length of an HTML fragment (comments, scripts and styles dropped, whitespace removed). */
export function textLength(html) {
  const t = decodeEntities(
    String(html || "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, ""),
  );
  return t.replace(INVISIBLE, "").length;
}

/** Visible text length of Markdown (links, images and markup removed). */
export function markdownTextLength(md) {
  return String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[#>*_`|\\-]/g, "")
    .replace(INVISIBLE, "").length;
}

// WeChat UI strings that can end up inside the body container. Only whole lines are removed, and only
// strings that never read as article text (a lone "知道了" or "分享" could be real content).
const UI_NOISE = new RegExp(
  "^(" +
    [
      "预览时标签不可点",
      "微信扫一扫\\s*(关注该公众号|可打开此内容，使用完整服务|使用小程序)",
      "继续滑动看下一个",
      "向上滑动看下一个",
      "轻点两下取消赞",
      "轻点两下取消在看",
      "[，,]?\\s*轻点两下取消赞[，,]?\\s*轻点两下取消在看",
      "视频\\s*小程序\\s*赞[，,]?\\s*轻点两下取消赞\\s*在看[，,]?\\s*轻点两下取消在看",
      "Scan to Follow",
      "Scan with Weixin to\\s*use this Mini Program",
    ].join("|") +
    ")$",
);

// Zero-width characters editors leave behind (built from code points so the source stays readable).
const ZW = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((c) => String.fromCharCode(c)).join("");
const ZW_STRIP = new RegExp(`[${String.fromCharCode(0x200b, 0xfeff)}]`, "g");
// The same characters written as numeric entities.
const ZW_ENTITY = /&#(?:8203|8204|8205|8288|65279|x200b|x200c|x200d|x2060|xfeff);/gi;

/** Clean turndown's output. Fenced code blocks (also indented ones, inside list items) stay as they are. */
function tidyMarkdown(md) {
  const parts = [];
  // the opening fence may follow a list marker ("-   ```"); the closing one is indented like the code
  const fence = /^[ \t]*(?:(?:[-*+]|\d+\.)[ \t]+)?(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/gm;
  let pos = 0;
  for (let m; (m = fence.exec(md)); ) {
    parts.push(tidyText(md.slice(pos, m.index)), m[0]);
    pos = m.index + m[0].length;
  }
  parts.push(tidyText(md.slice(pos)));
  return parts.join("").trim();
}

function tidyText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => {
      const t = l.replace(ZW_STRIP, "");
      // two trailing spaces are turndown's hard line break (<br>); other trailing space goes
      const hard = / {2}$/.test(t) && t.trim() !== "";
      return t.replace(/\s+$/, "") + (hard ? "  " : "");
    })
    .filter((l) => !UI_NOISE.test(l.trim()))
    .map((l) => (INVISIBLE_ONLY.test(l) ? "" : l))
    .filter((l) => !/^\s*\*{1,2}\s*$/.test(l)) // a lone "*" / "**": what an empty emphasis leaves
    // A lone "#" is text (empty headings are removed before conversion), so it stays visible.
    .map((l) => (/^\s*#{1,6}\s*$/.test(l) ? l.replace("#", "\\#") : l))
    // a bold run broken by an image or a line break leaves an odd "**" in front of the image
    .map((l) => ((l.match(/\*\*/g) || []).length % 2 ? l.replace(/^(\s*)\*\*(?=!\[)/, "$1") : l))
    .map((l) => outsideCode(l, tidyInline));
  // A hard break only matters when the paragraph goes on in the next line.
  for (let i = 0; i < lines.length; i++) if (lines[i].endsWith("  ") && !(lines[i + 1] ?? "").trim()) lines[i] = lines[i].trimEnd();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Apply fn to the parts of a line outside `inline code` spans (code is left as it is). */
function outsideCode(line, fn) {
  if (!line.includes("`")) return fn(line);
  return line
    .split(/(`+[^`]+`+)/)
    .map((p, i) => (i % 2 ? p : fn(p)))
    .join("");
}

function tidyInline(s) {
  return fixFlanking(
    s
      .replace(/(\S)\*\*\*\*(?=\S)/g, "$1") // "a****b": back-to-back bold runs
      // turndown escapes a "-" that starts a text node ("为\-15.2%", "2026\-10-25"): mid-line, or
      // before a digit at the start of a line or table cell, it can never start a list.
      .replace(/([^\s\\])\\-/g, "$1-")
      .replace(/(^|\| )\\-(?=\d)/g, "$1-"),
  );
}

// CommonMark closes "**" (or "*") only when it is not preceded by punctuation, or is followed by a
// space or punctuation; it opens one only when it is not followed by punctuation, or is preceded by a
// space or punctuation. Chinese has no spaces, so "**1.**正文" or "说**“核心”**是" would show the
// asterisks. Moving the punctuation at the edge of the run outside it fixes that; a run made only of
// punctuation loses its markers instead. The text itself never changes.
const PUNCT = /[\p{P}\p{S}]/u;
const NEVER_MOVE = /[\\*_`[\]<|~]/; // Markdown syntax; "(" and ")" move only when the run holds no link
const OPENER = { "）": "（", ")": "(", "】": "【", "》": "《", "”": "“", "’": "‘", "」": "「", "』": "『", "〉": "〈" };
const lastChar = (t) => {
  if (!t) return "";
  const lo = t.charCodeAt(t.length - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && t.length > 1 ? t.slice(-2) : t.slice(-1);
};
const firstChar = (t) => (t ? String.fromCodePoint(t.codePointAt(0)) : "");

function fixFlanking(s) {
  if (!s.includes("*")) return s;
  let out = s;
  if ((out.match(/\*\*/g) || []).length % 2 === 0) out = fixRuns(out, /\*\*([^*\n]+?)\*\*/g, "**");
  // single "*" runs (italics); skipped when the line's single asterisks do not pair up
  const singles = out.replace(/\\\*/g, "").replace(/\*\*/g, "").split("*").length - 1;
  if (singles && singles % 2 === 0) out = fixRuns(out, /(?<![\\*])\*(?![*\s])([^*\n]+?)(?<![\\*\s])\*(?!\*)/g, "*");
  return out;
}

function fixRuns(s, re, d) {
  const word = (c) => c !== "" && !/\s/.test(c) && !PUNCT.test(c);
  return s.replace(re, (m, inner, idx, str) => {
    const before = lastChar(str.slice(0, idx));
    const after = firstChar(str.slice(idx + m.length));
    const chars = Array.from(inner);
    const hasLink = inner.includes("](");
    const movable = (c) => PUNCT.test(c) && !NEVER_MOVE.test(c) && !(hasLink && (c === "(" || c === ")"));
    // a run of punctuation only (a bold colon): moving cannot help, drop the markers
    if (chars.every((c) => PUNCT.test(c))) return word(before) || word(after) ? inner : m;
    let lead = "";
    let trail = "";
    while (chars.length > 1 && word(after) && movable(chars.at(-1)) && chars.at(-2) !== "\\") trail = chars.pop() + trail;
    // a closing bracket that moved out takes its opening bracket along, so the pair stays together
    const open = OPENER[firstChar(trail)];
    if (open && chars[0] === open && chars.length > 1) lead = chars.shift();
    while (chars.length > 1 && word(before) && movable(chars[0])) lead += chars.shift();
    const body = chars.join("");
    // Still not a valid run (an edge character that cannot move, like a link's ")")? A run that is one
    // whole link gets the emphasis inside the link text; anything else loses the markers, never text.
    const openOk = lead !== "" || !(PUNCT.test(chars[0]) && word(before));
    const closeOk = trail !== "" || !(PUNCT.test(chars.at(-1)) && word(after));
    if (!openOk || !closeOk) {
      const link = body.match(/^\[([^\]]+)\](\([^)\s]*\))$/);
      return link ? `${lead}[${d}${link[1]}${d}]${link[2]}${trail}` : `${lead}${body}${trail}`;
    }
    return `${lead}${d}${body}${d}${trail}`;
  });
}

/** Wrappers with nothing visible inside (WeChat editors leave many) would become stray "****" or "#". */
function dropEmptyInline(html) {
  const blankChar = `(?:\\s|&nbsp;|&#160;|[${ZW}])`;
  const empty = new RegExp(`<(strong|b|em|i|u|span|font)\\b[^>]*>${blankChar}*<\\/\\1>`, "gi");
  // A heading with no visible text and no picture (only line breaks, zero-width characters, empty
  // spans) would become a lone "#".
  const blank = new RegExp(`[\\s${ZW}]|&nbsp;|&#160;`, "gi");
  const dropBlankHeading = (all, tag, inner) =>
    /<img\b/i.test(inner) || inner.replace(/<[^>]+>/g, "").replace(ZW_ENTITY, "").replace(blank, "") ? all : "";
  let prev;
  let cur = html;
  for (let i = 0; i < 10 && cur !== prev; i++) {
    prev = cur;
    cur = cur
      .replace(empty, "")
      .replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, dropBlankHeading)
      // back-to-back bold (or italic) runs become one run
      .replace(/<\/(strong|b)>(\s*)<(?:strong|b)\b[^>]*>/gi, "$2")
      .replace(/<\/(em|i)>(\s*)<(?:em|i)\b[^>]*>/gi, "$2");
  }
  return cur.replace(/<!\[CDATA\[|\]\]>/g, "");
}

/**
 * Elements hidden with display:none / visibility:hidden go, with everything inside them; a hidden
 * table cell becomes an empty cell so the columns stay aligned. Exceptions: the body container itself
 * (WeChat shows it after loading) and lazy-image elements, which WeChat's script reveals (real pages
 * carry photo captions inside such a span). An element whose closing tag cannot be found is left
 * alone, so a broken page never loses the rest of the article. Runs on the raw fragment, before
 * images and tables are rewritten.
 */
const STYLE_ATTR = /(?:^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const HIDDEN_VALUE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!\s*important\s*)?(?:;|$)/i;
const LAZY_IMAGE = /(?:^|\s)data-src\s*=|(?:^|\s)class\s*=\s*["'][^"']*\b(?:wxw-img|rich_pages)\b/i;
const isHidden = (attrs) => {
  const m = attrs.match(STYLE_ATTR);
  return Boolean(m) && HIDDEN_VALUE.test(decodeEntities(m[1] ?? m[2] ?? m[3] ?? ""));
};
function dropHidden(html) {
  const open = /<(span|p|section|div|strong|b|em|i|font|h[1-6]|li|ul|ol|a|blockquote|table|thead|tbody|tfoot|tr|td|th|code|pre|figure|figcaption|img)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let out = "";
  let pos = 0;
  for (let m; (m = open.exec(html)); ) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    if (!isHidden(attrs) || LAZY_IMAGE.test(attrs) || /(?:^|\s)id\s*=\s*["']?js_content\b/i.test(attrs)) continue;
    let end = -1;
    if (tag === "img" || /\/\s*$/.test(attrs)) end = m.index + m[0].length; // void or self-closing
    else {
      const tags = new RegExp(`<${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>|<\\/${tag}\\s*>`, "gi");
      tags.lastIndex = m.index + m[0].length;
      let depth = 1;
      for (let t; (t = tags.exec(html)); ) {
        if (t[0][1] === "/") depth -= 1;
        else if (!/\/\s*>$/.test(t[0])) depth += 1;
        if (depth === 0) {
          end = t.index + t[0].length;
          break;
        }
      }
    }
    if (end < 0) continue;
    out += html.slice(pos, m.index) + (tag === "td" || tag === "th" ? `<${tag}></${tag}>` : "");
    pos = end;
    open.lastIndex = end;
  }
  return out + html.slice(pos);
}

// A line made only of spaces and invisible characters (zero-width joiners left by editors).
const INVISIBLE_ONLY = new RegExp(
  "^[" + [0x20, 0x09, 0xa0, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0x3000].map((c) => String.fromCharCode(c)).join("") + "]*$",
);

/**
 * Convert a #js_content fragment to Markdown.
 * Returns { markdown, chars (visible body chars), images (image links), media (video/audio cards) }.
 */
export async function fragmentToMarkdown(fragment) {
  const { html, media } = mediaPlaceholders(fixLazyImages(dropHidden(fragment)));
  const fixed = dropEmptyInline(normalizeTables(html))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/\sstyle\s*=\s*(["'])[^"']*?visibility:\s*hidden[^"']*?\1/i, "");
  const markdown = tidyMarkdown(htmlToMarkdown(fixed) || "");
  return {
    markdown,
    chars: textLength(fragment),
    images: (markdown.match(/!\[[^\]]*\]\(/g) || []).length,
    media,
  };
}

/** Path of a raw page that weread-omni cached in its content library. */
export function libraryBlobPath(sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256 || "")) return undefined;
  const base = process.env.WEREAD_LIBRARY_DIR || join(homedir(), ".local", "share", "weread", "library");
  const p = join(base, "blobs", "sha256", sha256.slice(0, 2), sha256);
  return existsSync(p) ? p : undefined;
}

export function readMaybeGz(path) {
  const buf = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
}
