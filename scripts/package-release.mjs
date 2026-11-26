#!/usr/bin/env node
// Build a release zip of this skill: node scripts/package-release.mjs [out-dir]
// Only files meant for publication are included; it refuses to package anything that looks like
// personal data (databases, article folders, lock files) and checks the shipped text for leaks.
import { readdirSync, statSync, readFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir, userInfo } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const outDir = process.argv[2] || join(ROOT, "..", "wechat-mp-release");
const name = `wechat-mp-v${version}`;
const folder = "wechat-mp"; // the folder inside the zip: the skill name the docs tell people to copy

const INCLUDE = ["SKILL.md", "README.md", "CHANGELOG.md", "LICENSE", "package.json", ".gitignore", ".gitattributes", "wxmp", "wxmp.cmd", "scripts", "tests"];
const FORBIDDEN = /(^|\/)(node_modules|articles|raw|exports|test-fixtures-local)(\/|$)|\.db(-wal|-shm)?$|wxmp\.lock$/;

const files = [];
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
  else files.push(relative(ROOT, p).split(sep).join("/"));
};
for (const f of INCLUDE) if (existsSync(join(ROOT, f))) walk(join(ROOT, f));
const bad = files.filter((f) => FORBIDDEN.test(f));
if (bad.length) throw new Error(`refusing to package: ${bad.join(", ")}`);

// Text checks: no paths or names of the machine that builds the package (read at run time, so this
// file itself holds nothing personal), no Windows user paths, and no account IDs other than the
// fictional test ones.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let user = "";
try {
  user = userInfo().username;
} catch {
  /* no user entry: skip that check */
}
// On Windows the temp folder usually lies in the user's folder and often spells that folder in its
// 8.3 short form (six characters, a tilde and a digit): that path counts, and so does the short name.
const home = homedir();
const temp = /^[a-z]:[\\/]+users[\\/]+[^\\/]+/i.test(tmpdir()) ? tmpdir() : "";
const shortNames = temp.split(/[\\/]+/).filter((s) => /~\d/.test(s));
const local = [home, temp, dirname(ROOT), user, ...shortNames].filter((s) => s && s.length > 2).flatMap((s) => [s, s.replace(/\\/g, "/")]);
const LEAK = new RegExp([...new Set(local)].map(escapeRe).join("|") + "|C:[\\\\/]+Users[\\\\/]+[A-Za-z]+|MP_WXS_(\\d{7,})", "gi");
// Every shipped file is checked, whatever its type (read as UTF-8 and as UTF-16), and so is its name.
const leaks = [];
for (const f of files) {
  const bytes = readFileSync(join(ROOT, f));
  for (const [where, text] of [
    [`${f} (file name)`, f],
    [f, bytes.toString("utf8")],
    [`${f} (UTF-16)`, bytes.toString("utf16le")],
  ]) {
    for (const m of text.matchAll(LEAK)) {
      if (m[1] && /^(1234567890|9876543210)$/.test(m[1])) continue;
      leaks.push(`${where}: ${m[0]}`);
    }
  }
}
if (leaks.length) throw new Error(`possible personal data in shipped files:\n  ${leaks.join("\n  ")}`);

const stage = join(tmpdir(), `${name}-${process.pid}`);
rmSync(stage, { recursive: true, force: true });
for (const f of files) {
  mkdirSync(dirname(join(stage, folder, f)), { recursive: true });
  cpSync(join(ROOT, f), join(stage, folder, f));
}
mkdirSync(outDir, { recursive: true });
const zip = join(outDir, `${name}.zip`);
rmSync(zip, { force: true });
const r =
  process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${join(stage, folder)}' -DestinationPath '${zip}'`], { stdio: "inherit" })
    : spawnSync("zip", ["-qr", zip, folder], { cwd: stage, stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
if (r.status !== 0) throw new Error("zip failed");
console.log(`${files.length} files → ${zip}`);
