// Nothing to install: the bundled components load from any copy of the skill folder. Also login and
// which WeRead client runs. Every run uses a throw-away data and login directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, cpSync, mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire, builtinModules } from "node:module";
import { sandbox, ROOT } from "./helpers.mjs";

const SHIPPED = ["SKILL.md", "README.md", "CHANGELOG.md", "LICENSE", "package.json", "wxmp", "wxmp.cmd", "scripts", "tests"];

test("a copy of the skill folder works at once: no setup, in a path with spaces and Chinese", async () => {
  const S = sandbox();
  const base = mkdtempSync(join(tmpdir(), "wxmp 安装 测试-"));
  try {
    const skill = join(base, "我的 skills", "wechat-mp");
    for (const f of SHIPPED) cpSync(join(ROOT, f), join(skill, f), { recursive: true });
    const run = (args) =>
      new Promise((res) => {
        const child = spawn(process.execPath, ["--no-warnings", join(skill, "scripts", "wxmp.mjs"), ...args], { cwd: base, env: S.env, windowsHide: true });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (code) => res({ code, out }));
      });
    const d = await run(["doctor"]);
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /\[ OK \] 正文转换\s+turndown 7\.2\.5 \+ gfm 1\.0\.2/);
    // a whole download converts through the bundled turndown and its HTML parser
    await run(["sync", "--account", "MP_WXS_1001", "--delay", "0", "--page-delay", "0"]);
    const dl = await run(["download", "--account", "MP_WXS_1001", "--limit", "1", "--delay", "0"]);
    assert.equal(dl.code, 0, dl.out);
    assert.match(dl.out, /下载 1 篇|成功 1/);
    // the login QR code renders from the copy's bundled qrcode-terminal (no network)
    const qrcode = createRequire(join(skill, "scripts", "lib", "embedded", "cli.mjs"))("../../vendor/qrcode-terminal/lib/main.js");
    const image = await new Promise((res) => qrcode.generate("https://open.weixin.qq.com/connect/confirm?uuid=UUID1", { small: true }, res));
    const rows = image.split("\n").filter(Boolean);
    assert.ok(rows.length >= 15, `a QR code has rows (${rows.length})`);
    assert.match(image, /[▀▄█]/);
    // a missing bundled component is reported as an incomplete copy, not as something to install
    rmSync(join(skill, "scripts", "vendor", "domino"), { recursive: true, force: true });
    const broken = await run(["doctor"]);
    assert.equal(broken.code, 1);
    assert.match(broken.out, /\[FAIL\] 正文转换\s+skill 自带的正文转换组件.*不完整，请重新复制整个 wechat-mp 文件夹/);
    assert.equal(/setup|npm/.test(broken.out), false, broken.out);
  } finally {
    S.cleanup();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("the shipped code loads only Node built-ins and files of its own (no package to install)", () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.(m?js|cjs)$/.test(e.name)) files.push(join(d, e.name));
    }
  };
  walk(join(ROOT, "scripts"));
  assert.ok(files.length > 70, `${files.length} files`);
  const bare = [];
  let seen = 0;
  for (const f of files) {
    // comment lines are skipped (domino's config.js mentions require("domino") in one)
    const text = readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join("\n");
    const specs = [...text.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
    seen += specs.length;
    for (const s of specs) if (!s.startsWith(".") && !s.startsWith("node:") && !builtinModules.includes(s)) bare.push(`${f}: ${s}`);
  }
  assert.ok(seen > 150, `found ${seen} imports`);
  assert.deepEqual(bare, [], "every import is relative or a Node built-in");
});

test("there is no setup command", async () => {
  const S = sandbox();
  try {
    const r = await S.run(["setup"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /未知命令：setup/);
    assert.equal(/setup/.test((await S.run(["help"])).out), false, "help does not mention setup");
  } finally {
    S.cleanup();
  }
});

test("the embedded client runs by default; WXMP_WEREAD_ROOT switches to an external weread-omni", async () => {
  const S = sandbox();
  try {
    // embedded, and nobody is logged in (the sandbox has its own, empty login directory)
    const d = await S.run(["doctor"], { WXMP_WEREAD_CLI: "" });
    assert.match(d.out, /\[ OK \] 微信读书客户端\s+内置（请求和登录模块取自 weread-omni 0\.1\.2）/);
    assert.match(d.out, /\[FAIL\] 微信读书连接\s+未登录或登录已失效 → 在自己的终端里运行 wxmp login/);
    assert.equal(d.code, 1);
    // an external package
    const root = join(S.dir, "ext", "weread-omni");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "weread-omni", version: "9.9.9" }));
    writeFileSync(join(root, "dist", "cli.js"), 'process.stdout.write(JSON.stringify({ ok: true, auth: { status: "authenticated" } }));');
    const e = await S.run(["doctor"], { WXMP_WEREAD_CLI: "", WXMP_WEREAD_ROOT: root });
    assert.match(e.out, /微信读书客户端\s+外部 weread-omni 9\.9\.9 .*（WXMP_WEREAD_ROOT）/);
    assert.match(e.out, /已登录，连接正常/);
    const bad = await S.run(["doctor"], { WXMP_WEREAD_CLI: "", WXMP_WEREAD_ROOT: join(S.dir, "nowhere") });
    assert.match(bad.out, /\[FAIL\] 微信读书客户端\s+WXMP_WEREAD_ROOT=.*下没有 dist\/cli\.js/);
  } finally {
    S.cleanup();
  }
});

test("login runs the client's login", async () => {
  const S = sandbox();
  try {
    const r = await S.run(["login"]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /mock login ok/);
    assert.match(r.out, /登录完成/);
    assert.deepEqual(S.calls().at(-1), ["login"]);
    assert.equal((await S.run(["login", "extra"])).code, 1);
  } finally {
    S.cleanup();
  }
});

test("a copy without the embedded WeRead client says the folder is incomplete", async () => {
  const S = sandbox({ WXMP_WEREAD_CLI: "" });
  const copy = join(S.dir, "skill");
  try {
    for (const f of ["package.json", "scripts"]) cpSync(join(ROOT, f), join(copy, f), { recursive: true });
    rmSync(join(copy, "scripts", "lib", "embedded"), { recursive: true, force: true });
    const run = (args) =>
      new Promise((res) => {
        const child = spawn(process.execPath, ["--no-warnings", join(copy, "scripts", "wxmp.mjs"), ...args], { env: S.env, windowsHide: true });
        let all = "";
        child.stdout.on("data", (d) => (all += d));
        child.stderr.on("data", (d) => (all += d));
        child.on("close", (code) => res({ code, all }));
      });
    const s = await run(["search", "account", "示例"]);
    assert.equal(s.code, 2, s.all);
    assert.match(s.all, /skill 目录不完整（缺 scripts\/lib\/embedded）/);
    assert.doesNotMatch(s.all, /Cannot find module/);
    const d = await run(["doctor"]);
    assert.match(d.all, /\[FAIL\] 微信读书客户端.*skill 目录不完整/);
    assert.match(d.all, /\[FAIL\] 微信读书连接.*skill 目录不完整/);
  } finally {
    S.cleanup();
  }
});
