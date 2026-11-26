// Turning an article's #js_content into Markdown.
import { test } from "node:test";
import assert from "node:assert/strict";

const { fragmentToMarkdown } = await import("../scripts/lib/extract.mjs");
const md = async (html) => (await fragmentToMarkdown(`<div id="js_content">${html}</div>`)).markdown;

test("bold: nested and back-to-back runs keep their delimiters balanced", async () => {
  assert.equal(await md("<p><b>bold<b> nested</b></b> end</p>"), "**bold nested** end");
  assert.equal(await md("<p><strong>某日20时至次日20时，</strong><strong>北方有大风</strong>降温</p>"), "**某日20时至次日20时，北方有大风**降温");
  assert.equal(await md("<p><em>甲</em><em>乙</em>丙</p>"), "*甲乙*丙");
  // Real page structure (a news account's weather item): a <b> that wraps text plus a picture section.
  assert.equal(
    await md('<ul><li><span><b><span>某日20时至次日20时</span></b></span><b><span>，北方有雪。</span><section><img src="https://e.example/a.png"></section><section><span><br></span></section></b></li></ul>'),
    "-   **某日20时至次日20时，北方有雪。**\n\n    ![](https://e.example/a.png)",
  );
  assert.equal(await md('<b><p>第一段</p><p>第二段</p><section><img src="https://e.example/b.png"></section></b><p>普通</p>'), "**第一段**\n\n**第二段**\n\n![](https://e.example/b.png)\n\n普通");
  const img = await md('<p><b><img src="https://e.example/y.png"><br></b></p><h2></h2><p>尾</p>');
  assert.doesNotMatch(img, /^\s*\*\*\s*$|^#+\s*$|\*\*!\[/m, "no lone ** or empty heading");
});

test("tables: rowspan keeps columns aligned; a layout table around a data table keeps the inner table", async () => {
  const rs = await md('<table><tr><th>X</th><th>Y</th><th>Z</th></tr><tr><td rowspan="2">R1</td><td>A</td><td>C</td></tr><tr><td>B</td><td>D</td></tr></table>');
  assert.match(rs, /\| R1 \| A \| C \|\n\|  \| B \| D \|/);
  const nested = await md("<table><tr><th>outer</th></tr><tr><td><table><tr><th>h1</th><th>h2</th></tr><tr><td>i1</td><td>i2</td></tr></table></td></tr></table>");
  assert.match(nested, /\| h1 \| h2 \|\n\| --- \| --- \|\n\| i1 \| i2 \|/);
});

test("markup edge cases: > inside alt, <video src>, hidden spans, CDATA, zero-width lines, escaped minus", async () => {
  assert.equal(await md('<p><img alt="a>b c" data-src="https://e.example/x.png"></p>'), "![a>b c](https://e.example/x.png)");
  assert.equal(await md('<video poster="p.jpg" src="https://cdn.example/v.mp4"></video>'), "【视频：[打开](https://cdn.example/v.mp4)】");
  assert.equal(await md("<p>见<![CDATA[ x ]]>了</p>"), "见 x 了");
  // Real page structure (a news account): a caption inside a lazy-image span that is display:none until
  // WeChat's script runs. Readers see the caption, so it must stay.
  const caption = await md(
    '<section><span class="rich_pages wxw-img" data-src="https://e.example/p.jpg" style="width:100%;display:none;"><span leaf="">示例社发（</span><span leaf=""><span style="font-size:14px">王五 摄）</span></span><span leaf=""><br></span></span></section>',
  );
  assert.match(caption, /示例社发（王五 摄）/);
  const zw = String.fromCharCode(0x200d);
  assert.equal(await md(`<p>甲</p><p>${zw}${zw}</p><h3></h3><p>乙</p>`), "甲\n\n乙");
  assert.equal(await md("<p>同比<span>-15.2%</span>，日期 2026<span>-10-25</span></p><p><span>-3.5%</span> 开头</p>"), "同比-15.2%，日期 2026-10-25\n\n-3.5% 开头");
  assert.equal(await md("<p>- 这一行看起来像列表</p>"), "\\- 这一行看起来像列表", "a real list-like line stays escaped");
});

test("bold next to Chinese punctuation still renders: edge punctuation moves outside the run", async () => {
  assert.equal(await md("<p><strong>1.</strong>成长指数</p>"), "**1**.成长指数");
  assert.equal(await md("<p>说<strong>“核心观点”</strong>是本文重点</p>"), "说“**核心观点**”是本文重点");
  assert.equal(await md("<p><strong>（注）</strong>数据截至10月</p>"), "（**注**）数据截至10月", "a bracket pair moves out together");
  assert.equal(await md("<p><strong>注意：</strong>后文</p>"), "**注意**：后文");
  assert.equal(await md("<p><strong>完整的一句。</strong></p>"), "**完整的一句。**", "nothing to fix at the end of a line");
  assert.equal(await md("<p><b>第一段<br><br>第二段</b></p>"), "**第一段**\n\n**第二段**");
});

test("preformatted text and inline code are kept verbatim", async () => {
  assert.equal(await md("<pre>#\n*\n######\nx\\-y a****b</pre>"), "```\n#\n*\n######\nx\\-y a****b\n```");
  assert.equal(await md("<pre>line1<br>line2</pre>"), "```\nline1\nline2\n```");
  assert.equal(await md("<p>看<code>\\-1</code>结束</p>"), "看`\\-1`结束");
});

test("a lone # is text; empty headings disappear", async () => {
  assert.equal(await md("<p>#</p><p>正文</p><h2></h2><h3><br></h3><p>尾</p>"), "\\#\n\n正文\n\n尾");
});

test("hidden elements are dropped, except the body container and lazy-image elements", async () => {
  assert.equal(
    await md('<p>正文<span style="display: none;">预览时标签不可点</span>后文</p><p style="display:none">隐藏的重复标题</p><p><span style="visibility: hidden">看不见</span>可见</p>'),
    "正文后文\n\n可见",
  );
  assert.match(await md('<section><span class="rich_pages wxw-img" data-src="https://e.example/p.jpg" style="display:none;"><span>示例社发（</span><span>王五 摄）</span></span></section>'), /示例社发（王五 摄）/);
  assert.equal((await fragmentToMarkdown('<div id="js_content" style="visibility: hidden;"><p>容器里的正文</p></div>')).markdown, "容器里的正文");
  assert.equal(await md('<p>前<span style="display:none">没有结束</p><p>后面还在</p>'), "前没有结束\n\n后面还在");
});

test("hidden lists, cells, code and pictures are dropped; quoted styles are read; data-style is not a style", async () => {
  assert.equal(await md('<ul style="display:none"><li>X</li></ul><p>Y</p>'), "Y");
  assert.equal(await md('<table><tr><th>h1</th><th>h2</th></tr><tr><td>a</td><td style="display:none">X</td></tr></table>'), "| h1 | h2 |\n| --- | --- |\n| a |  |");
  assert.equal(await md('<p>A<code style="display:none">X</code>B</p>'), "AB");
  assert.equal(await md('<p>A<img style="display:none" src="https://e.example/x.png">B</p>'), "AB");
  assert.equal(await md('<p><img style="display:none" data-src="https://e.example/y.png" class="rich_pages wxw-img"></p>'), "![](https://e.example/y.png)");
  assert.equal(await md("<p>A<span style=\"font-family:'Microsoft YaHei';display:none\">X</span>Y</p>"), "AY");
  assert.equal(await md('<p><span data-style="display:none">Visible</span></p>'), "Visible");
});

test("emphasis edges: italics, punctuation-only runs, ASCII brackets, emoji, bracket pairs, links", async () => {
  assert.equal(await md("<p>前<i>注意！</i>后</p>"), "前*注意*！后");
  assert.equal(await md("<p>说明<b>：</b>内容</p>"), "说明：内容");
  assert.equal(await md("<p>前<b>(注)</b>数据</p>"), "前(**注**)数据");
  assert.equal(await md("<p>前<b>😀重点</b>后</p>"), "前😀**重点**后");
  assert.equal(await md("<p><b>（注）</b>数据</p>"), "（**注**）数据");
  assert.equal(await md('<p><b><a href="https://e.example/">链接</a></b>后文</p>'), "[**链接**](https://e.example/)后文");
  assert.equal(await md("<p><b>15%</b>的增长</p>"), "**15**%的增长", "text unchanged, only the marker moves");
});

test("code blocks inside list items and blank lines inside code are kept; entity zero-width headings go; <br> stays a line break", async () => {
  assert.equal(await md("<ul><li><pre>a\n*\nb</pre></li></ul>"), "-   ```\n    a\n    *\n    b\n    ```");
  assert.equal(await md("<pre>a\n\n\n\nb</pre>"), "```\na\n\n\n\nb\n```");
  assert.equal(await md("<h2>&#8203;</h2><p>after</p>"), "after");
  assert.equal(await md("<p><b>第一段<br>第二段</b></p>"), "**第一段  \n第二段**");
  assert.equal(await md("<p>行尾<br></p><p>下一段</p>"), "行尾\n\n下一段", "a break at the end of a paragraph is dropped");
});
