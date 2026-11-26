// Test harness: every run gets a throw-away data dir, library dir and the mock weread CLI.
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";

export const TESTS = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(TESTS, "..");
export const WXMP = join(ROOT, "scripts", "wxmp.mjs");
export const MOCK = join(TESTS, "mock-weread.mjs");
export const WORLD = join(TESTS, "fixtures", "world.json");

/**
 * A sandbox: isolated WXMP_HOME + WEREAD_LIBRARY_DIR + mock CLI. Never touches real data.
 * The WeRead login directory is a folder of the sandbox too, and the API and article hosts point at a
 * closed local port, so a test that runs the embedded client (WXMP_WEREAD_CLI: "") can reach neither
 * the real login nor the real servers unless it names a local stand-in itself.
 */
export function sandbox(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wxmp-test-"));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("WXMP_")) delete env[k];
  Object.assign(env, {
    WXMP_HOME: join(dir, "home"),
    WEREAD_LIBRARY_DIR: join(dir, "library"),
    WXMP_WEREAD_CLI: MOCK,
    WXMP_MOCK_WORLD: WORLD,
    WXMP_MOCK_LOG: join(dir, "calls.log"),
    WEREAD_CONFIG_DIR: join(dir, "weread-config"),
    WXMP_WEREAD_API: "http://127.0.0.1:9",
    WXMP_WEREAD_ARTICLE_ORIGIN: "http://127.0.0.1:9",
    NODE_NO_WARNINGS: "1",
    ...extraEnv,
  });
  if (!env.WXMP_HOME.startsWith(dir)) throw new Error("refusing to run: WXMP_HOME is not inside the sandbox");
  if (!env.WEREAD_CONFIG_DIR.startsWith(dir)) throw new Error("refusing to run: WEREAD_CONFIG_DIR is not inside the sandbox");
  for (const k of ["WXMP_WEREAD_API", "WXMP_WEREAD_ARTICLE_ORIGIN"]) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(env[k])) throw new Error(`refusing to run: ${k} is not a local address`);
  }

  /** Run wxmp asynchronously (the image server lives in this process, so no spawnSync). */
  const run = (args, more = {}) =>
    new Promise((res) => {
      const child = spawn(process.execPath, ["--no-warnings", WXMP, ...args], { env: { ...env, ...more }, windowsHide: true });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => child.kill(), 180_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        res({ code, out, err, all: out + err });
      });
    });

  const calls = () =>
    existsSync(env.WXMP_MOCK_LOG)
      ? readFileSync(env.WXMP_MOCK_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];

  /** Query the sandbox DB read-only and close it right away. */
  const q = (sql, ...params) => {
    const db = new DatabaseSync(join(env.WXMP_HOME, "wxmp.db"), { readOnly: true });
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  };

  /** Ask the mock directly (to learn fixture URLs etc.). */
  const mock = (args) =>
    new Promise((res) => {
      const child = spawn(process.execPath, [MOCK, ...args, "--json"], { env: { ...env, WXMP_MOCK_LOG: "" }, windowsHide: true });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => res(JSON.parse(out)));
    });

  /** Absolute path of a path stored in the DB (stored paths are relative to WXMP_HOME). */
  const file = (p) => join(env.WXMP_HOME, p);

  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* a locked temp dir on Windows is harmless */
    }
  };
  return { dir, env, run, calls, q, mock, file, cleanup };
}

/** A local HTTP server that answers /img/* with a tiny image and counts hits. */
export async function imageServer() {
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d4944415478da63f8cfc0f01f0005000201e2214bcf0000000049454e44ae426082", "hex");
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits += 1;
    if (req.url.startsWith("/img/")) {
      res.writeHead(200, { "content-type": req.url.includes(".jpg") ? "image/jpeg" : "image/png" });
      res.end(png);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, hits: () => hits, close: () => new Promise((r) => srv.close(r)) };
}

/** Epoch seconds → "YYYY-MM-DD HH:mm" Beijing time (independent re-implementation for asserts). */
export const bjText = (ts) => {
  const d = new Date(Number(ts) * 1000 + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};
