// Local SQLite store: accounts, articles, search log.
import { createRequire } from "node:module";
import { mkdirSync, existsSync, accessSync, constants } from "node:fs";
import { join, isAbsolute, relative, sep } from "node:path";
import { homedir } from "node:os";
import { toBjIso } from "./util.mjs";

/** Data directory: $WXMP_HOME, else ~/wechat-mp-data. */
function resolveHome() {
  return process.env.WXMP_HOME || join(homedir(), "wechat-mp-data");
}
export const HOME = resolveHome();
export { toBjIso };

const SCHEMA = `
create table if not exists accounts (
  account_id  text primary key,
  name        text,
  intro       text,
  cover       text,
  watch       integer not null default 0,
  keywords    text,
  first_seen  text,
  last_sync   text,
  note        text,
  pending_cutoff integer,          -- an unfinished scan: how far back it has to go
  resume_offset  integer,          -- and the list offset to pick it up at
  initial_done   integer not null default 0  -- the default 30-day first look-back is done
);
create table if not exists articles (
  review_id     text primary key,
  account_id    text,
  title         text,
  abstract      text,
  list_time     integer,           -- WeRead listing createTime (ingest time for some accounts)
  pub_time      integer,           -- real publish time (review.mpInfo.time / publishedAt)
  doc_url       text,
  pay_type      integer,
  status        text not null default 'new',  -- new | ok | fixed | short | failed
  tool_chars    integer,           -- body chars weread-omni's own markdown had
  body_chars    integer,           -- body chars in #js_content
  images        integer,
  md_path       text,
  raw_path      text,
  source_sha256 text,
  first_seen    text,
  fetched_at    text,
  error         text
);
create index if not exists idx_articles_account on articles(account_id, list_time);
create index if not exists idx_articles_status on articles(status);
create table if not exists searches (
  id          integer primary key autoincrement,
  keyword     text,
  scope       integer,
  at          text,
  total       integer,
  result_ids  text,
  page_start  integer not null default 0,
  next_idx    integer
);
`;

export const nowIso = () => toBjIso();

/** The time an article is filed under everywhere (sorting, --since, "latest"): listing time, else publish time. */
export const ARTICLE_TIME = "coalesce(list_time, pub_time)";

/**
 * Rows that belong to the library. A hit that was only seen in `search article` (no listing time,
 * no publish time, no URL, never downloaded) stays out of download / list / export / status until it
 * is synced or asked for explicitly with --review.
 */
export const TRACKED = "not (list_time is null and pub_time is null and doc_url is null and status = 'new')";

/** Statuses of an article with a local copy (the same set wxmp calls GOOD). */
const HAS_COPY = new Set(["ok", "fixed", "short", "partial"]);

/**
 * Open the store. With { allowReadOnly }, a DB that cannot be written is opened
 * read-only instead of failing — enough for list / status / export.
 */
export function openStore({ allowReadOnly = false } = {}) {
  const path = join(HOME, "wxmp.db");
  // node:sqlite is loaded here, not at import time, so an old Node reaches wxmp's own version message.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  let db;
  try {
    mkdirSync(HOME, { recursive: true });
    // timeout: wait for another wxmp process holding the write lock instead of failing at once.
    db = new DatabaseSync(path, { timeout: 15_000 });
    initialize(db);
    // A read-only DB file opens fine and (in WAL mode) only fails on the first real write; find out
    // now, before any request is made or any file is replaced.
    accessSync(path, constants.W_OK);
    db.exec("begin immediate");
    db.exec("rollback");
  } catch (e) {
    if (/not a database|malformed|file is encrypted/i.test(e.message)) {
      throw new Error(`数据库文件损坏：${path}（${e.message}）。把它改名备份后重新运行，会建一个新库。`);
    }
    if (allowReadOnly && /readonly|read-only|EPERM|EACCES/i.test(`${e.code} ${e.message}`) && existsSync(path)) {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      return new Store(new DatabaseSync(path, { readOnly: true, timeout: 15_000 }), true);
    }
    if (/readonly|read-only/i.test(e.message) || (/^(EACCES|EPERM)$/.test(e.code ?? "") && e.path === path)) {
      throw new Error(`数据库是只读的，无法写入：${path}。去掉文件的只读属性或检查目录权限后再试`);
    }
    throw e;
  }
  return new Store(db);
}

/** Absolute path of a stored (data-dir relative) path. */
export const absPath = (p) => (p ? (isAbsolute(p) ? p : join(HOME, p)) : undefined);
/** Data-dir relative path with forward slashes, for storing in the DB. */
export const relPath = (p) => (p ? relative(HOME, absPath(p)).split(sep).join("/") : undefined);

/**
 * WAL mode and schema; both can safely run again. When several wxmp processes create the same new
 * database at once, SQLite may answer "database is locked" at once instead of waiting on the busy
 * timeout (it does so where waiting could deadlock): such an instant answer is retried after a short
 * pause. A lock that outlasted the busy timeout is reported as it is.
 */
function initialize(db) {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      db.exec("pragma journal_mode = wal;");
      db.exec(SCHEMA);
      return;
    } catch (e) {
      const instant = Date.now() - started < 1000;
      if (attempt >= 20 || !instant || !/database is locked|SQLITE_BUSY/i.test(e.message)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + Math.floor(Math.random() * 100));
    }
  }
}

class Store {
  constructor(db, readOnly = false) {
    this.db = db;
    this.readOnly = readOnly;
  }

  upsertAccount({ accountId, name, intro, cover, keyword }) {
    const cur = this.getAccount(accountId);
    if (!cur) {
      this.db
        .prepare("insert into accounts(account_id,name,intro,cover,keywords,first_seen) values(?,?,?,?,?,?)")
        .run(accountId, name ?? null, intro ?? null, cover ?? null, keyword ?? null, nowIso());
      return;
    }
    const keywords = new Set((cur.keywords || "").split("|").filter(Boolean));
    if (keyword) keywords.add(keyword);
    this.db
      .prepare("update accounts set name=coalesce(?,name), intro=coalesce(?,intro), cover=coalesce(?,cover), keywords=? where account_id=?")
      .run(name ?? null, intro ?? null, cover ?? null, [...keywords].join("|") || null, accountId);
  }

  getAccount(accountId) {
    return this.db.prepare("select * from accounts where account_id=?").get(accountId);
  }

  setWatch(accountId, on) {
    this.db.prepare("update accounts set watch=? where account_id=?").run(on ? 1 : 0, accountId);
  }

  watched() {
    return this.db.prepare("select * from accounts where watch=1 order by name").all();
  }

  touchSync(accountId) {
    this.db.prepare("update accounts set last_sync=? where account_id=?").run(nowIso(), accountId);
  }

  /** Remember an unfinished scan: how far back it had to go and where to pick it up. */
  setPending(accountId, cutoff, offset) {
    this.db
      .prepare("update accounts set pending_cutoff=min(coalesce(pending_cutoff, ?), ?), resume_offset=? where account_id=?")
      .run(cutoff, cutoff, offset ?? 0, accountId);
  }

  clearPending(accountId) {
    this.db.prepare("update accounts set pending_cutoff=null, resume_offset=null where account_id=?").run(accountId);
  }

  /** The default first look-back (30 days) has been completed for this account. */
  setInitialDone(accountId) {
    this.db.prepare("update accounts set initial_done=1 where account_id=?").run(accountId);
  }

  getArticle(reviewId) {
    return this.db.prepare("select * from articles where review_id=?").get(reviewId);
  }

  /**
   * Insert when new; otherwise fill in fields that were missing. Returns true when the article is
   * new to us, or — for a listing row (listTime given) — new to the listing (first seen via search).
   * An article with a downloaded copy keeps the title, publish time and link that copy was saved
   * with (only missing ones are filled in): they change with an accepted new copy (saveDownload), so
   * the database never disagrees with the Markdown file. Other articles take the newer values.
   */
  upsertArticle(a) {
    const cur = this.getArticle(a.reviewId);
    if (!cur) {
      this.db
        .prepare(
          "insert into articles(review_id,account_id,title,abstract,list_time,pub_time,doc_url,pay_type,first_seen) values(?,?,?,?,?,?,?,?,?)",
        )
        .run(a.reviewId, a.accountId ?? null, a.title ?? null, a.abstract ?? null, a.listTime ?? null, a.pubTime ?? null, a.docUrl ?? null, a.payType ?? null, nowIso());
      return true;
    }
    const keep = HAS_COPY.has(cur.status) && cur.md_path && existsSync(absPath(cur.md_path));
    const pick = (stored, given) => (keep ? stored ?? given : given ?? stored) ?? null;
    this.db
      .prepare(
        `update articles set account_id=coalesce(account_id,?), title=?, abstract=coalesce(abstract,?),
         list_time=coalesce(list_time,?), pub_time=?, doc_url=?, pay_type=coalesce(pay_type,?)
         where review_id=?`,
      )
      .run(a.accountId ?? null, pick(cur.title, a.title), a.abstract ?? null, a.listTime ?? null, pick(cur.pub_time, a.pubTime), pick(cur.doc_url, a.docUrl), a.payType ?? null, a.reviewId);
    return a.listTime != null && cur.list_time == null;
  }

  saveDownload(reviewId, f) {
    this.db
      .prepare(
        `update articles set status=?, tool_chars=?, body_chars=?, images=?, md_path=?, raw_path=?, source_sha256=?,
         fetched_at=?, error=?, pub_time=coalesce(?,pub_time), doc_url=coalesce(?,doc_url), title=coalesce(?,title),
         pay_type=coalesce(pay_type,?) where review_id=?`,
      )
      .run(f.status, f.toolChars ?? null, f.bodyChars ?? null, f.images ?? null, f.mdPath ?? null, f.rawPath ?? null, f.sha256 ?? null, f.fetchedAt ?? nowIso(), f.error ?? null, f.pubTime ?? null, f.docUrl ?? null, f.title || null, f.payType ?? null, reviewId);
  }

  markFailed(reviewId, error) {
    this.db.prepare("update articles set status='failed', error=?, fetched_at=? where review_id=?").run(String(error).slice(0, 500), nowIso(), reviewId);
  }

  /** Record a search page. With dedupe, an identical latest record (same page, same IDs) is not repeated. */
  logSearch(keyword, scope, total, ids, { pageStart = 0, nextIdx = null, dedupe = false } = {}) {
    const joined = ids.join(",");
    if (dedupe) {
      const same = this.db
        .prepare("select 1 from searches where keyword=? and scope=? and page_start=? and result_ids=? limit 1")
        .get(keyword, scope, pageStart, joined);
      if (same) return false;
    }
    this.db
      .prepare("insert into searches(keyword,scope,at,total,result_ids,page_start,next_idx) values(?,?,?,?,?,?,?)")
      .run(keyword, scope, nowIso(), total ?? null, joined, pageStart, nextIdx);
    return true;
  }

  /** Latest first-page live search for this keyword (paged and imported searches never serve as the cache). */
  lastSearch(keyword, scope) {
    return this.db.prepare("select * from searches where keyword=? and scope=? and page_start=0 order by id desc limit 1").get(keyword, scope);
  }

  /** Watched rows first, then by name — used to resolve --account by name. */
  accountsNamed(name) {
    return this.db.prepare("select account_id, name, watch from accounts where name=? order by watch desc, account_id").all(name);
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }
}
