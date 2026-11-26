// HTML → Markdown via turndown (+ the GFM plugin for tables). Both ship with the skill in
// scripts/vendor/, together with turndown's HTML parser (domino), so nothing has to be installed.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const VENDOR = fileURLToPath(new URL("../vendor/", import.meta.url));

let state;

function vendored() {
  const req = createRequire(import.meta.url);
  try {
    return {
      Turndown: req("../vendor/turndown/lib/turndown.cjs.js"),
      version: req("../vendor/turndown/package.json").version,
      gfm: req("../vendor/turndown-plugin-gfm/lib/turndown-plugin-gfm.cjs.js").gfm,
      gfmVersion: req("../vendor/turndown-plugin-gfm/package.json").version,
    };
  } catch (e) {
    const err = new Error(`skill 自带的正文转换组件（scripts/vendor/turndown 等）不完整，请重新复制整个 wechat-mp 文件夹。原因：${e.message.split("\n")[0]}`);
    err.code = "NO_TURNDOWN";
    throw err;
  }
}

function load() {
  if (state) return state;
  const { Turndown, version, gfm, gfmVersion } = vendored();
  const td = new Turndown({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  // Text like "<尖括号>" would be read back as an HTML tag and vanish in most renderers.
  const baseEscape = td.escape.bind(td);
  td.escape = (s) => baseEscape(s).replace(/</g, "\\<");
  if (gfm) td.use(gfm);
  td.remove(["script", "style", "iframe", "noscript"]);
  // Links that are not web/mail/anchor links (javascript:, weixin://, data:) keep their text only.
  // Bold inside bold (or italic inside italic) would close the outer run early.
  const insideSame = (node, names) => {
    for (let p = node.parentNode; p; p = p.parentNode) if (names.includes(p.nodeName)) return true;
    return false;
  };
  td.addRule("nestedEmphasis", {
    filter: (node) =>
      (["STRONG", "B"].includes(node.nodeName) && insideSame(node, ["STRONG", "B"])) || (["EM", "I"].includes(node.nodeName) && insideSame(node, ["EM", "I"])),
    replacement: (content) => content,
  });
  // WeChat editors wrap whole blocks (paragraphs, picture sections, lines split by <br><br>) in
  // <b>. Markdown emphasis cannot span a blank line, so each text paragraph gets its own run, and
  // pictures, lists, headings, quotes, tables and code are left as they are.
  const isEmphasis = (node) => ["STRONG", "B", "EM", "I"].includes(node.nodeName);
  td.addRule("emphasisByParagraph", {
    filter: (node) => isEmphasis(node) && !insideSame(node, ["STRONG", "B"].includes(node.nodeName) ? ["STRONG", "B"] : ["EM", "I"]),
    replacement: (content, node) => {
      if (!content.trim()) return "";
      const d = ["STRONG", "B"].includes(node.nodeName) ? "**" : "*";
      return content
        .split(/(\n[ \t]*\n\s*)/)
        .map((part, i) => {
          if (i % 2) return part; // the paragraph break itself
          const m = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
          const body = m[2];
          if (!body || /^(!\[|\[!\[|[-*+] |\d+\. |#{1,6} |>|\||```|~~~|---)/.test(body)) return part;
          return `${m[1]}${d}${body}${d}${m[3]}`;
        })
        .join("");
    },
  });
  // A <pre> without <code> is preformatted text: keep it verbatim in a fenced block (line breaks
  // from <br> and block children included) instead of escaping it as a paragraph.
  const preText = (node) => {
    let s = "";
    for (const c of node.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeName === "BR") s += "\n";
      else if (c.nodeType === 1) s += /^(P|DIV|SECTION|LI)$/.test(c.nodeName) ? `${preText(c)}\n` : preText(c);
    }
    return s;
  };
  td.addRule("plainPre", {
    filter: (node) => node.nodeName === "PRE" && !(node.firstChild && node.firstChild.nodeName === "CODE"),
    replacement: (content, node) => {
      const text = preText(node).replace(/^\n+|\n+$/g, "");
      if (!text.trim()) return "";
      const fence = text.includes("```") ? "~~~" : "```";
      return `\n\n${fence}\n${text}\n${fence}\n\n`;
    },
  });
  // A link with no text and no picture renders as "[](url)" — noise.
  td.addRule("emptyLinks", {
    filter: (node) => node.nodeName === "A" && !node.textContent.trim() && !node.querySelector?.("img"),
    replacement: () => "",
  });
  td.addRule("unsafeLinks", {
    filter: (node) => node.nodeName === "A" && !/^(https?:|mailto:|#)/i.test((node.getAttribute("href") || "").trim()),
    replacement: (content) => content,
  });
  state = { td, info: { from: VENDOR, turndown: version, gfm: gfmVersion } };
  return state;
}

/** Where turndown was loaded from, and its versions (for `wxmp doctor`). */
export function markdownInfo() {
  return load().info;
}

export function htmlToMarkdown(html) {
  if (!html || !String(html).trim()) return "";
  return load().td.turndown(String(html));
}
