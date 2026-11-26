// Bridge to WeRead. wxmp talks to WeRead through its own client (lib/embedded/cli.mjs, built on the
// request and login modules taken from weread-omni, see scripts/vendor/weread-omni). One child process
// runs per call, and every call is read-only (WEREAD_READONLY=1).
//
// WXMP_WEREAD_ROOT, the directory of an installed weread-omni package, makes wxmp run that package's
// command line instead: a way out if the embedded client stops working.
// Override for tests: WXMP_WEREAD_CLI (a JS file run instead of the client).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedRoot;

/** The weread-omni release the embedded client's request and login modules were taken from. */
export const EMBEDDED_FROM = "0.1.2";

/** wxmp's own client. */
const embeddedCli = () => fileURLToPath(new URL("./embedded/cli.mjs", import.meta.url));

/**
 * Directory of the external weread-omni package named by WXMP_WEREAD_ROOT, or undefined when the
 * embedded client is in use. Throws when the variable points somewhere without a weread-omni.
 */
export function wereadRoot() {
  if (cachedRoot) return cachedRoot;
  const fromEnv = process.env.WXMP_WEREAD_ROOT;
  if (!fromEnv) return undefined;
  if (!existsSync(join(fromEnv, "dist", "cli.js"))) {
    throw new WereadError("NO_WEREAD", `WXMP_WEREAD_ROOT=${fromEnv} 下没有 dist/cli.js，请检查路径`);
  }
  return (cachedRoot = fromEnv);
}

/** Which client runs: "test" (WXMP_WEREAD_CLI), "external" (WXMP_WEREAD_ROOT) or "embedded". */
export function wereadSource() {
  if (process.env.WXMP_WEREAD_CLI) return "test";
  return process.env.WXMP_WEREAD_ROOT ? "external" : "embedded";
}

/** Version of the external weread-omni, or of the release the embedded modules came from. */
export function wereadVersion() {
  const root = wereadRoot();
  if (!root) return EMBEDDED_FROM;
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/** Path of the entry that runWeread spawns. */
export function wereadCli() {
  const mock = process.env.WXMP_WEREAD_CLI;
  if (mock) {
    if (!existsSync(mock)) throw new WereadError("NO_WEREAD", `WXMP_WEREAD_CLI=${mock} 不存在`);
    return mock;
  }
  const root = wereadRoot();
  if (root) return join(root, "dist", "cli.js");
  const cli = embeddedCli();
  if (!existsSync(cli)) throw new WereadError("NO_WEREAD", "找不到内置的微信读书客户端（scripts/lib/embedded/cli.mjs）");
  return cli;
}

/** Error from the CLI, with the upstream errCode / code / diagnostics when present. */
export class WereadError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

// Stop the whole run: WeRead risk control (-2041 human verification, -2010 rate limit), a lost
// login, or WeChat's anti-bot page. -2013 (no entitlement, e.g. paid content) only affects one
// article and is handled by the caller.
const FATAL_ERR_CODES = new Set([-2041, -2010]);
// TIMEOUT / PARSE / SPAWN mean the WeRead client itself is not working; retrying article after article
// would only burn time and mark good articles failed.
const FATAL_LOCAL = new Set(["AUTH", "NO_WEREAD", "TIMEOUT", "PARSE", "SPAWN"]);
const FATAL_TEXT = /CHALLENGE|SOURCE_BLOCKED|环境异常|访问过于频繁|操作频繁|was blocked/i;

export function isFatal(err) {
  if (!(err instanceof WereadError)) return false;
  if (FATAL_ERR_CODES.has(err.code)) return true;
  if (FATAL_LOCAL.has(err.code)) return true;
  const text = `${err.code} ${err.message} ${JSON.stringify(err.detail?.article?.diagnostics ?? err.detail?.diagnostics ?? "")}`;
  return FATAL_TEXT.test(text);
}

export function parseJsonLoose(text) {
  const t = (text || "").trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    const i = t.search(/[[{]/);
    if (i >= 0) {
      try {
        return JSON.parse(t.slice(i));
      } catch {
        /* fall through */
      }
    }
  }
  return undefined;
}

const AUTH_TEXT = /no WeRead accounts are configured|weread-omni login|wxmp login|not logged in|log in again|unauthori[sz]ed|登录超时|登录失效|-2012/i;

/** Turn the CLI's stderr into a WereadError. */
export function errorFromStderr(stderr, status) {
  let err;
  for (const line of String(stderr || "").split(/\r?\n/).reverse()) {
    const j = parseJsonLoose(line);
    if (j && typeof j === "object") {
      err = j;
      break;
    }
  }
  // Without a JSON payload, keep only the first meaningful line (never a stack trace).
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^node:internal|^\^+$|^file:\/\/|^Node\.js v\d/.test(l));
  const firstLine = lines.find((l) => /^[A-Za-z]*Error\b:?/.test(l)) ?? lines[0];
  const message = err?.error ?? (firstLine ? firstLine.slice(0, 200) : `微信读书接口异常退出（代码 ${status}）`);
  let code = err?.errCode ?? err?.code;
  if (code === undefined) code = AUTH_TEXT.test(message) ? "AUTH" : "CLI";
  // -2012 means "login timed out" everywhere except the paid-content route, where upstream notes it
  // is returned for healthy sessions too.
  else if ((code === -2012 && !/getpaidinfo/.test(JSON.stringify(err))) || (typeof code === "string" && AUTH_TEXT.test(message) && !/^SOURCE_/.test(code))) code = "AUTH";
  return new WereadError(code, message, err);
}

/** Run the WeRead client with `<args> --json`; returns parsed stdout or throws WereadError. */
export function runWeread(args, { timeoutMs = 90_000 } = {}) {
  const cli = wereadCli();
  if (Number(process.env.WXMP_TIMEOUT_MS) > 0) timeoutMs = Number(process.env.WXMP_TIMEOUT_MS);
  const r = spawnSync(process.execPath, ["--no-warnings", cli, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, WEREAD_READONLY: "1", NODE_NO_WARNINGS: "1" },
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) {
    const timedOut = r.error.code === "ETIMEDOUT";
    throw new WereadError(timedOut ? "TIMEOUT" : "SPAWN", timedOut ? `微信读书接口超过 ${Math.round(timeoutMs / 1000)} 秒没有响应` : r.error.message);
  }
  if (r.status === 0) {
    const out = parseJsonLoose(r.stdout);
    if (out === undefined || out === null || typeof out !== "object") {
      // Do not echo the output: it may be a huge or half-written document.
      throw new WereadError("PARSE", "微信读书接口输出格式不对：返回的不是完整的 JSON（可能输出被截断，或接口变了）");
    }
    // An error report on stdout with exit code 0 is still an error (and may be risk control).
    if (typeof out.error === "string" && (out.errCode !== undefined || typeof out.code === "string")) throw errorFromStderr(JSON.stringify(out), 0);
    return out;
  }
  throw errorFromStderr(r.stderr, r.status);
}

/** Decode the __biz parameter of an mp.weixin.qq.com URL into a WeRead account ID. */
export function accountIdFromUrl(url) {
  let host;
  try {
    host = new URL(String(url ?? "")).hostname;
  } catch {
    return undefined;
  }
  if (host !== "mp.weixin.qq.com") return undefined;
  const m = String(url).match(/[?&]__biz=([^&#]+)/);
  if (!m) return undefined;
  let digits;
  try {
    digits = Buffer.from(decodeURIComponent(m[1]), "base64").toString("utf8");
  } catch {
    return undefined;
  }
  return /^\d+$/.test(digits) ? `MP_WXS_${digits}` : undefined;
}

export const ACCOUNT_ID = /^MP_WXS_\d+$/;
export const accountOfReview = (reviewId) => String(reviewId ?? "").match(/^(MP_WXS_\d+)_/)?.[1];
