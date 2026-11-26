// The WeRead endpoints wxmp calls, on top of the request layer taken from weread-omni. All of them
// are reads; nothing here adds to the shelf, subscribes or writes notes.
import { MobileClient } from "../../vendor/weread-omni/api/mobile.js";
import { TokenManager } from "../../vendor/weread-omni/auth/token.js";
import { login as qrLogin } from "../../vendor/weread-omni/auth/qrlogin.js";
import { einkProfile } from "../../vendor/weread-omni/profile.js";
import { AuthError, WeReadApiError } from "../../vendor/weread-omni/errors.js";
import { loadCredentials, loginAlias, saveCredentials, selectAccount } from "./account.mjs";

/** The API host; WXMP_WEREAD_API replaces it in the tests. */
const apiBase = (env) => env.WXMP_WEREAD_API || undefined;

function needArray(body, field, path, status) {
  if (!Array.isArray(body?.[field])) throw new WeReadApiError(`mobile ${path}: ${field} is not an array`, { path, status });
}

/** Open the saved account. Refreshed tokens are written back to the account file at once. */
export function openClient(env = process.env, { fetchImpl = fetch } = {}) {
  const alias = selectAccount(env);
  const credentials = loadCredentials(alias, env);
  if (!credentials) throw new AuthError("no WeRead accounts are configured; run wxmp login");
  const baseUrl = apiBase(env);
  const tokenManager = new TokenManager(credentials, { fetchImpl, baseUrl, onCredentials: (next) => saveCredentials(alias, next, env) });
  const mobile = new MobileClient({ tokenManager, fetchImpl, baseUrl });
  return {
    alias,
    identity: { vid: credentials.vid, deviceId: credentials.deviceId },

    /** A cheap authenticated read, to check that the login works. */
    async ping() {
      const r = await mobile.call("GET", "/shelf/sync");
      needArray(r.body, "books", "/shelf/sync", r.status);
    },

    /** scope 2 = public accounts, 4 = articles. The server takes nothing but these four parameters. */
    async search(keyword, { scope, count, maxIdx = 0 }) {
      const r = await mobile.call("GET", "/store/search", { query: { keyword, scope, count, maxIdx } });
      needArray(r.body, "books", "/store/search", r.status);
      return r.body;
    },

    /**
     * One page of an account's article list. The request has two shapes that the official clients
     * never mix: the first page carries a synckey and no offset, later pages an offset and no synckey.
     * offset and count are numbers of pushes (群发), and a page returns every article of those pushes;
     * a push whose article is gone still takes a place, so a page can hold fewer articles than count
     * without being the last. No "next offset" is reported here: the caller works it out (see
     * syncAccount in wxmp.mjs) and stops at an empty page.
     */
    async articles(accountId, { count = 50, offset } = {}) {
      const query = offset === undefined ? { bookId: accountId, count, synckey: 0 } : { bookId: accountId, count, offset };
      const r = await mobile.call("GET", "/mp/chapters", { query });
      needArray(r.body, "data", "/mp/chapters", r.status);
      const { data, nextOffset, nextSynckey, ...rest } = r.body;
      return { ...rest, accountId, articles: data, returnedCount: data.length, requestedOffset: offset ?? 0 };
    },

    /** Details of one article: mpInfo holds the link, title, account name, publish time and pay type. */
    async reviewSingle(reviewId) {
      const query = { reviewId, commentsCount: 10, commentsDirection: 0, likesCount: 10, likesDirection: 0, synckey: 0 };
      return (await mobile.call("GET", "/review/single", { query })).body;
    },

    /** Article link → review ID. Fails when WeRead does not know the article. */
    async resolveArticle(url) {
      const r = await mobile.call("POST", "/mp/getreviewid", { body: { urls: [url] }, idempotent: true });
      needArray(r.body, "reviewIds", "/mp/getreviewid", r.status);
      const hit = r.body.reviewIds[0];
      if (!hit || typeof hit.url !== "string" || typeof hit.reviewId !== "string") {
        throw new WeReadApiError("mobile /mp/getreviewid: no review ID for the requested article", { path: "/mp/getreviewid", status: r.status });
      }
      return hit;
    },

    /**
     * The entitlement check for a paid article: an account that bought it gets the full HTML, any
     * other gets a substitute link to the preview. This route answers -2012 for healthy sessions too,
     * so that code is reported as an ordinary error here, not as a lost login.
     */
    async paidContent(url) {
      const r = await mobile.call("POST", "/mp/getpaidinfo", {
        body: { urls: [url], need_content: true },
        idempotent: true,
        acceptArrayResponse: true,
        treatExpiredSessionAsBusinessError: true,
      });
      const entries = Array.isArray(r.body) ? r.body : Array.isArray(r.body?.data) ? r.body.data : undefined;
      if (!entries?.length) throw new WeReadApiError("mobile /mp/getpaidinfo: no entry for the requested article", { path: "/mp/getpaidinfo", status: r.status });
      return entries[0];
    },
  };
}

/**
 * Log in with a WeChat QR code and save the account. A login for an account that exists keeps its
 * device ID, so WeRead sees the same device again instead of a new one.
 */
export async function login(env = process.env, { fetchImpl = fetch, onQr, onStatus } = {}) {
  const alias = loginAlias(env);
  let previous;
  try {
    previous = loadCredentials(alias, env);
  } catch {
    /* an unreadable old login is replaced */
  }
  const credentials = await qrLogin({ fetchImpl, profile: einkProfile(), deviceId: previous?.deviceId, onQr, onStatus });
  saveCredentials(alias, credentials, env);
  return { account: alias, vid: credentials.vid, deviceId: credentials.deviceId };
}
