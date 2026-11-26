// Unit tests for the pure helpers. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { bj, toBjIso, bjIso, parseDate, safeName, ridTag, pad, clip } from "../scripts/lib/util.mjs";
import { jsContentFragment, fixLazyImages, textLength, markdownTextLength, fragmentToMarkdown } from "../scripts/lib/extract.mjs";
import { accountIdFromUrl, accountOfReview, errorFromStderr, isFatal, parseJsonLoose, WereadError } from "../scripts/lib/weread.mjs";

test("bj formats epoch seconds as Beijing time", () => {
  assert.equal(bj(0), "1970-01-01 08:00");
  assert.equal(bj(1793969059), "2026-11-06 20:44");
  assert.equal(bj(1793969059, false), "2026-11-06");
  assert.equal(bj(undefined), "");
  assert.equal(bj(null), "");
  assert.equal(bj("x"), "");
});

test("toBjIso / bjIso convert UTC and +08:00 stamps", () => {
  assert.equal(toBjIso("2026-11-06T23:49:47.240Z"), "2026-11-07T07:49:47+08:00");
  assert.equal(toBjIso(Date.parse("2026-01-01T00:00:00Z")), "2026-01-01T08:00:00+08:00");
  assert.equal(toBjIso("not a date"), undefined);
  assert.equal(bjIso("2026-11-06T23:49:47.240Z"), "2026-11-07 07:49");
  assert.equal(bjIso("2026-11-07T07:49:47+08:00"), "2026-11-07 07:49");
  assert.equal(bjIso(""), "");
});

test("parseDate reads Beijing calendar days and rejects impossible ones", () => {
  assert.equal(parseDate("2026-11-07"), Date.parse("2026-11-06T16:00:00Z") / 1000);
  assert.equal(parseDate(undefined), undefined);
  for (const bad of ["2026/11/07", "2026-13-01", "2026-02-30", "20261107", "2026-1-7"]) assert.throws(() => parseDate(bad), /日期/);
});

test("safeName keeps names valid on every OS", () => {
  assert.equal(safeName('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(safeName("CON"), "_CON");
  assert.equal(safeName("con.txt"), "_con.txt");
  assert.equal(safeName("LPT1"), "_LPT1");
  assert.equal(safeName("  ..hidden.. "), "hidden");
  assert.equal(safeName(""), "_");
  assert.equal(safeName(null), "_");
  assert.equal([...safeName("长".repeat(100))].length, 60);
  assert.equal(safeName("a\tb\nc"), "a_b_c");
});

test("pad and clip measure CJK as double width", () => {
  assert.equal(pad("中文", 6), "中文  ");
  assert.equal(pad("ab", 4), "ab  ");
  assert.equal(clip("一二三四五", 3), "一二…");
  assert.equal(clip("a  b\nc", 10), "a b c");
});

test("jsContentFragment cuts the body container with nested divs", () => {
  const html = '<div>head</div><div class="x" id="js_content" style="visibility: hidden;"><div><div>deep</div></div><p>tail</p></div><div>footer 预览时标签不可点</div>';
  const f = jsContentFragment(html);
  assert.ok(f.startsWith('<div class="x" id="js_content"'));
  assert.ok(f.endsWith("<p>tail</p></div>"));
  assert.ok(!f.includes("footer"));
  assert.equal(jsContentFragment("<p>正文里出现 js_content 这个词</p>"), null);
  assert.equal(jsContentFragment("<div id='js_content'><p>unclosed"), "<div id='js_content'><p>unclosed");
});

test("fixLazyImages promotes data-src over placeholder src", () => {
  const out = fixLazyImages('<img src="data:image/svg+xml,x" data-src="https://m/a.png" class="c"><img src="https://keep/b.png" alt="图">');
  assert.match(out, /<img src="https:\/\/m\/a.png">/);
  assert.match(out, /<img src="https:\/\/keep\/b.png" alt="图">/);
});

test("fixLazyImages handles unquoted data-src, data-original, and drops data: placeholders", () => {
  assert.equal(fixLazyImages("<img data-src=https://m/u.png>"), '<img src="https://m/u.png">');
  assert.equal(fixLazyImages('<img data-original="https://m/o.png" src="data:image/gif;base64,AAAA">'), '<img src="https://m/o.png">');
  assert.equal(fixLazyImages('<img src="data:image/gif;base64,AAAA">'), "");
});

test("jsContentFragment ignores data-id decoys, comments and scripts; follows the container's own tag", () => {
  const decoy = '<div data-id="js_content"><p>诱饵</p></div><div id="js_content"><p>真正文</p></div>';
  assert.equal(jsContentFragment(decoy), '<div id="js_content"><p>真正文</p></div>');
  const comment = '<div id="js_content"><p>a</p><!-- <div> --><p>b</p></div><div class="rich_media_tool">工具栏</div>';
  assert.ok(!jsContentFragment(comment).includes("工具栏"));
  const section = '<section id="js_content"><div><p>一</p></div><p>二</p></section><p>页脚</p>';
  assert.equal(jsContentFragment(section), '<section id="js_content"><div><p>一</p></div><p>二</p></section>');
  const script = '<script>var x = \'<div id="js_content">\';</script><div id="js_content"><p>真</p></div>';
  assert.equal(jsContentFragment(script), '<div id="js_content"><p>真</p></div>');
});

test("fragmentToMarkdown: body paragraphs that start like UI text are kept, real UI lines are dropped", async () => {
  const r = await fragmentToMarkdown('<div id="js_content"><p>知道了，这一段是正文。</p><p>赞，这也是正文。</p><p>微信扫一扫这个词出现在正文开头。</p><p>预览时标签不可点</p><p>轻点两下取消赞</p></div>');
  assert.match(r.markdown, /知道了，这一段是正文/);
  assert.match(r.markdown, /赞，这也是正文/);
  assert.match(r.markdown, /微信扫一扫这个词/);
  assert.doesNotMatch(r.markdown, /预览时标签不可点|轻点两下取消赞/);
});

test("fragmentToMarkdown: tables without a header row, unsafe links, literal angle brackets", async () => {
  const r = await fragmentToMarkdown('<div id="js_content"><table><tr><td>名称</td><td>值</td></tr><tr><td>甲</td><td>1</td></tr></table><p><a href="javascript:alert(1)">危险</a> <a href="weixin://x">微信内链</a> 文字&lt;尖括号&gt;</p></div>');
  assert.match(r.markdown, /\| 名称 \| 值 \|/);
  assert.match(r.markdown, /\| 甲 \| 1 \|/);
  assert.doesNotMatch(r.markdown, /<table|javascript:|weixin:\/\//);
  assert.match(r.markdown, /危险/);
  assert.ok(r.markdown.includes("\\<尖括号>"));
});

test("markup: layout tables, colspan, media cards, emoji, empty bold and links, lone 知道了, <style> inside the container", async () => {
  const layout = await fragmentToMarkdown('<div id="js_content"><table><tr><td><p>特别声明：本框只是排版</p><p>第二行</p></td></tr></table><p>正文</p></div>');
  assert.doesNotMatch(layout.markdown, /\|/);
  assert.match(layout.markdown, /特别声明：本框只是排版/);
  const span = await fragmentToMarkdown('<div id="js_content"><table><tr><td>项目</td><td>2025</td><td>2026E</td></tr><tr><td colspan="2">合并单元格</td><td>3</td></tr></table></div>');
  assert.match(span.markdown, /\| 合并单元格 \|\s*\| 3 \|/);
  const media = await fragmentToMarkdown('<div id="js_content"><p>前</p><mp-common-videosnap data-desc="号视频"></mp-common-videosnap><mpvoice name="一段语音"></mpvoice><iframe class="video_iframe" data-src="https://v.qq.com/x"></iframe><p>后</p></div>');
  assert.equal(media.media, 3);
  assert.match(media.markdown, /【视频号视频：号视频】/);
  assert.match(media.markdown, /【语音：一段语音】/);
  const misc = await fragmentToMarkdown('<div id="js_content"><p>知道了</p><p><img class="wx_emoji" src="https://res.wx.qq.com/mpres/emotion/smile.png" alt="[微笑]">好</p><p><strong></strong><strong>点赞！</strong><strong> </strong></p><p><a href="https://mp.weixin.qq.com/x"></a>空链接后</p></div>');
  assert.match(misc.markdown, /^知道了$/m, "a lone 知道了 inside the article is content");
  assert.match(misc.markdown, /微笑/);
  assert.equal(misc.images, 0, "emoji are not counted as pictures");
  assert.doesNotMatch(misc.markdown, /\*{3,}/);
  assert.match(misc.markdown, /\*\*点赞！\*\*/);
  assert.doesNotMatch(misc.markdown, /\[\]\(/);
  const style = '<div id="js_content"><style>.a::before{content:"<div>"}</style><p>正文</p></div><div class="rich_media_tool">工具栏</div>';
  assert.ok(!jsContentFragment(style).includes("工具栏"));
});

test("ridTag is unique per review ID and safe on case-insensitive disks", () => {
  const a = ridTag("MP_WXS_1002_ccc111_zz9999");
  const b = ridTag("MP_WXS_1002_ddd222_zz9999");
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.notEqual(ridTag("MP_WXS_1_AbCdEf"), ridTag("MP_WXS_1_abcdef"));
});

test("textLength decodes entities and ignores markup and scripts", () => {
  assert.equal(textLength("<p>&ldquo;中&rdquo;&nbsp;&#x4e2d;&#25991;&amp;</p><script>var a=1</script>"), 6);
  assert.equal(textLength("<p> a b </p>"), 2);
  // 标题 + 链接 + 粗 = 5 visible characters
  assert.equal(markdownTextLength("# 标题\n\n![图](https://x/y.png) [链接](https://z) **粗**"), 5);
});

test("fragmentToMarkdown keeps headings, emphasis, links, images and tables", async () => {
  const r = await fragmentToMarkdown(
    '<div id="js_content" style="visibility: hidden; opacity: 0;"><h2>小标题</h2><p>正文<strong>加粗</strong><em>斜体</em><a href="https://e/x">链接</a></p><p><img data-src="https://e/p.png"></p><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><script>evil()</script><p>预览时标签不可点</p></div>',
  );
  assert.match(r.markdown, /^## 小标题/m);
  assert.match(r.markdown, /\*\*加粗\*\*/);
  assert.match(r.markdown, /\*斜体\*/);
  assert.match(r.markdown, /\[链接\]\(https:\/\/e\/x\)/);
  assert.match(r.markdown, /!\[\]\(https:\/\/e\/p.png\)/);
  assert.match(r.markdown, /\| A \| B \|/);
  assert.doesNotMatch(r.markdown, /evil|预览时标签不可点/);
  assert.equal(r.images, 1);
});

test("accountIdFromUrl decodes __biz and rejects junk", () => {
  assert.equal(accountIdFromUrl("https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=1"), "MP_WXS_1234567890");
  assert.equal(accountIdFromUrl("https://mp.weixin.qq.com/s?mid=1&__biz=OTg3NjU0MzIxMA%3D%3D"), "MP_WXS_9876543210");
  assert.equal(accountIdFromUrl("https://mp.weixin.qq.com/s/abcdef"), undefined);
  assert.equal(accountIdFromUrl("https://x/?__biz=aGVsbG8="), undefined);
  assert.equal(accountIdFromUrl("https://example.com/x?__biz=MTAwMg=="), undefined, "only mp.weixin.qq.com links count");
  assert.equal(accountIdFromUrl("not a url"), undefined);
  assert.equal(accountIdFromUrl(undefined), undefined);
  assert.equal(accountOfReview("MP_WXS_123_abc"), "MP_WXS_123");
  assert.equal(accountOfReview("nope"), undefined);
});

test("errorFromStderr + isFatal classify real weread-omni error shapes", () => {
  const verify = errorFromStderr('{"error":"mobile /store/search: WeRead requires a human verification challenge in an official client (-2041)","errCode":-2041,"status":499,"path":"/store/search"}', 1);
  assert.equal(verify.code, -2041);
  assert.ok(isFatal(verify));
  assert.ok(isFatal(errorFromStderr('{"error":"rate limited","errCode":-2010}', 1)));
  const entitlement = errorFromStderr('{"error":"no entitlement","errCode":-2013}', 1);
  assert.equal(entitlement.code, -2013);
  assert.equal(isFatal(entitlement), false);
  const noLogin = errorFromStderr('{"error":"no WeRead accounts are configured; run weread-omni login"}', 1);
  assert.equal(noLogin.code, "AUTH");
  assert.ok(isFatal(noLogin));
  const challenge = errorFromStderr('{"error":"article source unavailable","code":"SOURCE_WECHAT_CHALLENGE","article":{"diagnostics":[{"code":"SOURCE_WECHAT_CHALLENGE"}]}}', 1);
  assert.ok(isFatal(challenge));
  const insufficient = errorFromStderr('{"error":"article source content was insufficient","code":"SOURCE_CONTENT_INSUFFICIENT","article":{"diagnostics":[{"code":"SOURCE_CONTENT_INSUFFICIENT"}]}}', 1);
  assert.equal(isFatal(insufficient), false);
  assert.ok(isFatal(errorFromStderr('{"error":"article source was blocked","code":"SOURCE_CONTENT_INSUFFICIENT"}', 1)));
  assert.equal(errorFromStderr('{"error":"login timeout","errCode":-2012,"path":"/mp/getpaidinfo"}', 1).code, -2012);
  assert.equal(errorFromStderr('{"error":"login timeout","errCode":-2012,"path":"/book/info"}', 1).code, "AUTH");
  const plain = errorFromStderr("Error: something odd\n", 1);
  assert.equal(plain.code, "CLI");
  assert.equal(isFatal(plain), false);
  const crash = errorFromStderr("file:///x/cli.js:3\n  throw new Error('boom');\n  ^\n\nError: boom\n    at file:///x/cli.js:3:9\n    at ModuleJob.run (node:internal/modules/esm/module_job:1:1)\n", 1);
  assert.doesNotMatch(crash.message, /\sat\s.*:\d+:\d+/, "no stack frames in the message");
  for (const code of ["TIMEOUT", "PARSE", "SPAWN"]) assert.ok(isFatal(new WereadError(code, "x")), `${code} stops the run`);
  assert.equal(isFatal(new Error("x")), false);
  assert.ok(isFatal(new WereadError("NO_WEREAD", "missing")));
});

test("parseJsonLoose tolerates log lines before the JSON", () => {
  assert.deepEqual(parseJsonLoose('Storing downloaded content in X\n{"a":1}'), { a: 1 });
  assert.equal(parseJsonLoose("nope"), undefined);
  assert.equal(parseJsonLoose(""), undefined);
});
