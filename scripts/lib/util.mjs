// Small pure helpers shared by the CLI and the tests.
import { createHash } from "node:crypto";

/** Epoch seconds → Beijing time "YYYY-MM-DD HH:mm" (or "YYYY-MM-DD" when withTime is false). */
export function bj(ts, withTime = true) {
  if (ts === undefined || ts === null || ts === "" || Number.isNaN(Number(ts))) return "";
  const s = new Date((Number(ts) + 8 * 3600) * 1000).toISOString().replace("T", " ");
  return withTime ? s.slice(0, 16) : s.slice(0, 10);
}

/** Any instant (ms, ISO string, or now) as Beijing-time ISO: 2026-11-07T07:49:47+08:00. */
export function toBjIso(when = Date.now()) {
  const ms = typeof when === "number" ? when : Date.parse(when);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 19) + "+08:00";
}

/** ISO stamp (UTC or +08:00) shown as Beijing time "YYYY-MM-DD HH:mm". */
export function bjIso(iso) {
  const ms = Date.parse(iso || "");
  return Number.isNaN(ms) ? "" : bj(Math.floor(ms / 1000));
}

/** "YYYY-MM-DD" (Beijing calendar day) → epoch seconds at 00:00 Beijing time. */
export function parseDate(s) {
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`日期格式应为 YYYY-MM-DD：${s}`);
  const t = Date.parse(`${s}T00:00:00+08:00`);
  // Date.parse accepts some impossible days (e.g. 02-30); round-tripping catches them.
  if (Number.isNaN(t) || bj(Math.floor(t / 1000), false) !== s) throw new Error(`不是有效日期：${s}（格式 YYYY-MM-DD）`);
  return Math.floor(t / 1000);
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A string that is safe as a file or folder name on Windows, macOS and Linux. */
export function safeName(s, max = 60) {
  let t = String(s ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  t = [...t].slice(0, max).join("").replace(/[. ]+$/, "").replace(/^[. ]+/, "");
  if (!t || RESERVED.test(t)) t = `_${t}`;
  return t;
}

/** 8 lowercase hex characters derived from the whole review ID: unique and safe on case-insensitive disks. */
export const ridTag = (rid) => createHash("sha1").update(String(rid)).digest("hex").slice(0, 8);

/** Pad to a display width where CJK characters count as 2. */
export function pad(s, n) {
  const str = String(s ?? "");
  const w = [...str].reduce((a, c) => a + (c.codePointAt(0) > 255 ? 2 : 1), 0);
  return str + " ".repeat(Math.max(0, n - w));
}

/** Collapse whitespace and cut to n characters with an ellipsis. */
export function clip(s, n) {
  const chars = [...String(s ?? "").replace(/\s+/g, " ")];
  return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : chars.join("");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
