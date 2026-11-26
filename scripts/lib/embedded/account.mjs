// Where the WeRead login lives. These are the same files weread-omni uses, so a login made with
// weread-omni keeps working here and the other way round:
//   <config>/accounts/<alias>/account.json        { "version": 1, "client": "eink" }
//   <config>/accounts/<alias>/clients/eink.json   { "version": 1, "eink": { vid, refreshToken, deviceId, accessToken? } }
//   <config>/config.json                          { "version": 1, "defaultAccount"?: "<alias>" }
// <config> is $WEREAD_CONFIG_DIR, else ~/.config/weread.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AuthError } from "../../vendor/weread-omni/errors.js";

const ALIAS = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CLIENT = "eink";

export const configRoot = (env = process.env) => env.WEREAD_CONFIG_DIR || join(homedir(), ".config", "weread");
const accountDir = (alias, env) => join(configRoot(env), "accounts", alias);
export const statePath = (alias, env = process.env) => join(accountDir(alias, env), "clients", `${CLIENT}.json`);

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if (cause.code === "ENOENT") return undefined;
    throw new AuthError(`${label} could not be read`, { cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AuthError(`${label} is not valid JSON; log in again`, { cause });
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Aliases that have an account descriptor. */
export function listAccounts(env = process.env) {
  let entries;
  try {
    entries = readdirSync(join(configRoot(env), "accounts"), { withFileTypes: true });
  } catch (cause) {
    if (cause.code === "ENOENT") return [];
    throw new AuthError("account directory could not be read", { cause });
  }
  return entries
    .filter((e) => e.isDirectory() && ALIAS.test(e.name) && isObj(readJson(join(accountDir(e.name, env), "account.json"), `account ${e.name}`)))
    .map((e) => e.name)
    .sort();
}

/**
 * The account to use: the only one; else $WEREAD_ACCOUNT; else the recorded default. The wording of
 * the "not logged in" error is what wxmp recognises as "run wxmp login".
 */
export function selectAccount(env = process.env) {
  const all = listAccounts(env);
  if (!all.length) throw new AuthError("no WeRead accounts are configured; run wxmp login");
  if (all.length === 1) return all[0];
  const wanted = env.WEREAD_ACCOUNT?.trim();
  if (wanted && all.includes(wanted)) return wanted;
  const recorded = readJson(join(configRoot(env), "config.json"), "weread configuration")?.defaultAccount;
  if (typeof recorded === "string" && all.includes(recorded)) return recorded;
  throw new AuthError(`multiple WeRead accounts are configured (${all.join(", ")}); set WEREAD_ACCOUNT to the one to use`);
}

/** The alias a new login is stored under. */
export function loginAlias(env = process.env) {
  const wanted = env.WEREAD_ACCOUNT?.trim();
  if (wanted) {
    if (!ALIAS.test(wanted)) throw new AuthError(`invalid account alias ${JSON.stringify(wanted)}: use lowercase letters, digits, "-" or "_"`);
    return wanted;
  }
  const all = listAccounts(env);
  return all.length === 1 ? all[0] : "default";
}

function checkedCredentials(value, alias) {
  const c = isObj(value) && value.version === 1 && isObj(value.eink) ? value.eink : undefined;
  const ok = c && ["vid", "refreshToken", "deviceId"].every((k) => typeof c[k] === "string" && c[k].length > 0) && (c.accessToken === undefined || (typeof c.accessToken === "string" && c.accessToken.length > 0));
  if (!ok) throw new AuthError(`the saved login of account ${JSON.stringify(alias)} is incomplete; log in again`);
  return { vid: c.vid, refreshToken: c.refreshToken, deviceId: c.deviceId, ...(c.accessToken ? { accessToken: c.accessToken } : {}) };
}

/** Saved credentials of an account, or undefined when it has none yet. */
export function loadCredentials(alias, env = process.env) {
  const descriptor = readJson(join(accountDir(alias, env), "account.json"), `account ${alias}`);
  if (descriptor !== undefined && (!isObj(descriptor) || descriptor.version !== 1 || descriptor.client !== CLIENT)) {
    throw new AuthError(`account ${JSON.stringify(alias)} was created by another client (${JSON.stringify(descriptor?.client)}), which wxmp cannot use; log in again`);
  }
  const state = readJson(statePath(alias, env), `login of account ${alias}`);
  return state === undefined ? undefined : checkedCredentials(state, alias);
}

/** Write through a temp file and a rename, so a crash never leaves half a file where the login was. */
function writeJson(path, value) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Save credentials (after a login, or when a refresh returned new tokens). */
export function saveCredentials(alias, credentials, env = process.env) {
  if (!ALIAS.test(alias)) throw new AuthError(`invalid account alias ${JSON.stringify(alias)}`);
  const eink = checkedCredentials({ version: 1, eink: credentials }, alias);
  writeJson(statePath(alias, env), { version: 1, eink });
  writeJson(join(accountDir(alias, env), "account.json"), { version: 1, client: CLIENT });
}
