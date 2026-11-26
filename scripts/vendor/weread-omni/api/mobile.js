import { AuthError, toTransportError, WeReadApiError } from "../errors.js";
import { emitLog } from "../logger.js";
import { resolveProfile } from "../profile.js";
import { MAX_JSON_RESPONSE_BYTES, ResponseBodyReadError, ResponseBodyTooLargeError, readJsonResponse, readResponseBody, } from "./response-body.js";
import { requestSignal } from "./signal.js";
function errCode(body, path, status, ambiguous) {
    if (!body || typeof body !== "object")
        return undefined;
    const key = "errCode" in body ? "errCode" : "errcode" in body ? "errcode" : undefined;
    if (key === undefined)
        return undefined;
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    throw new WeReadApiError(`mobile ${path}: malformed ${key} (HTTP ${status})`, { path, status, ambiguous });
}
function errMessage(body) {
    if (!body || typeof body !== "object")
        return "";
    const value = "errMsg" in body ? body.errMsg : "errmsg" in body ? body.errmsg : "";
    return typeof value === "string" ? value : "";
}
function diagnosticPath(path) {
    const end = path.search(/[?#]/);
    return JSON.stringify(end === -1 ? path : path.slice(0, end));
}
/**
 * The failure half of WeRead's business-code contract, shared by the parsed and the byte path so
 * the two cannot drift. Returns for a response the caller may use; throws otherwise.
 *
 * Normally reached after the one permitted replay has been declined. Curated endpoints that use
 * `-2012` for a different failure can opt out and receive it as a response-level error instead.
 */
function throwIfFailed(response, path, body, code, ambiguous, expiredSessionIsAuthFailure = true) {
    if (response.status === 401 || (code === -2012 && expiredSessionIsAuthFailure)) {
        throw new AuthError(`mobile ${path}: authentication rejected after token refresh`);
    }
    if (code === -2041) {
        // A verification challenge, not throttling -- throttling is -2014. The official clients answer
        // this by running a human CAPTCHA and retrying with the resulting ticket, which is not
        // something a headless client can do, so it is reported rather than retried. Re-authenticating
        // does not help: the token is valid, and it is the session fingerprint being challenged.
        throw new WeReadApiError(`mobile ${path}: WeRead requires a human verification challenge in an official client (-2041)`, { path, status: response.status, errCode: code, ambiguous: false });
    }
    if (!response.ok || (code !== undefined && code !== 0)) {
        throw new WeReadApiError(`mobile ${path}: ${code ?? `HTTP ${response.status}`} ${errMessage(body)}`.trim(), {
            path,
            status: response.status,
            errCode: code,
            ambiguous: code !== undefined && code !== 0 ? false : ambiguous,
        });
    }
}
const utf8 = new TextDecoder("utf-8", { fatal: true });
const JSON_OBJECT_START = 0x7b; // "{"
/**
 * Read a byte body as a WeRead business envelope, or `undefined` when it is not one.
 *
 * WeRead reports failure as HTTP 200 carrying a negative `errCode`, so even a byte-returning call
 * has to look inside the body: without this an expired session (`-2012`) came back as a
 * successful download and never triggered the re-mint every other call path gets.
 *
 * The test is on the bytes, not on `content-type`. The header is the server's claim *about* the
 * body, and the responses this exists to catch — an auth envelope served where an EPUB was asked
 * for — are exactly the ones whose header is least trustworthy. A genuine binary asset cannot
 * pass: EPUB (`PK`), JPEG (`\xFF\xD8`), PNG (`\x89PNG`) and every other container fail on the
 * first non-whitespace byte, and a body that does start with `{` still has to be valid UTF-8 and
 * parse as JSON. Anything meeting all three is a JSON document however it was labelled, so it was
 * never usable as an asset — and the caller is better served by its `errCode` than by its bytes.
 */
function businessEnvelope(bytes) {
    let start = 0;
    while (bytes[start] === 0x20 || bytes[start] === 0x09 || bytes[start] === 0x0d || bytes[start] === 0x0a) {
        start += 1;
    }
    if (bytes[start] !== JSON_OBJECT_START)
        return undefined;
    try {
        return JSON.parse(utf8.decode(bytes));
    }
    catch {
        return undefined;
    }
}
function responseTooLarge(path, status, maxResponseBytes, ambiguous) {
    return new WeReadApiError(`mobile ${path}: response exceeds ${maxResponseBytes} bytes (HTTP ${status})`, {
        path,
        status,
        ambiguous,
    });
}
async function readRawBody(response, path, maxResponseBytes, ambiguous) {
    if (maxResponseBytes === undefined) {
        try {
            return new Uint8Array(await response.arrayBuffer());
        }
        catch (cause) {
            // The headers arrived but the body did not, so the outcome is still unknown.
            throw toTransportError(cause, `mobile ${path}`, { ambiguous });
        }
    }
    try {
        return await readResponseBody(response, maxResponseBytes);
    }
    catch (cause) {
        if (cause instanceof ResponseBodyTooLargeError) {
            throw responseTooLarge(path, response.status, maxResponseBytes, ambiguous);
        }
        throw toTransportError(cause instanceof ResponseBodyReadError ? cause.cause : cause, `mobile ${path}`, {
            ambiguous,
        });
    }
}
export class MobileClient {
    tokenManager;
    fetchImpl;
    baseUrl;
    timeoutMs;
    logger;
    versionHeaders;
    authHeaders;
    constructor(options) {
        this.tokenManager = options.tokenManager;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.baseUrl = (options.baseUrl ?? "https://i.weread.qq.com").replace(/\/+$/, "");
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.logger = options.logger;
        const profile = resolveProfile(options);
        this.versionHeaders = profile.versionHeaders;
        this.authHeaders = (token) => profile.authHeaders(token);
    }
    async vid(signal) {
        return (await this.tokenManager.get(false, signal)).vid;
    }
    /**
     * Resolve the token to retry an auth-rejected first attempt with, or refuse the retry.
     *
     * A write can be committed upstream and still answer 401 (or errCode -2012 on an HTTP 200),
     * so replaying it duplicates the write. Whether the refreshed token differs proves nothing
     * about that: the token being stale and the write having landed are independent events.
     */
    async tokenForReplay(token, path, status, replayable, signal, code) {
        const label = `mobile ${diagnosticPath(path)}`;
        if (!replayable) {
            emitLog(this.logger, "warn", `${label}: authentication rejected; request not replayed`);
            // Still refresh, so the caller's next request succeeds — just never repeat this one. If
            // that refresh also fails, keep it as the cause: otherwise the promise made by this branch
            // is silently false and the caller has no evidence auth was never repaired.
            //
            // Check the cache first, exactly as the replayable branch below does: several late write
            // rejections arriving after another caller already refreshed would otherwise each force a
            // fresh mint, and each mint can rotate and persist credentials.
            let refreshFailure;
            const cached = await this.tokenManager.get(false, signal).catch(() => undefined);
            if (!cached || cached.accessToken === token.accessToken) {
                await this.tokenManager.get(true, signal).catch((error) => {
                    refreshFailure = error;
                });
            }
            throw new WeReadApiError(`mobile ${path}: authentication failed; the outcome of this request is unknown`, {
                path,
                status,
                errCode: code,
                ambiguous: true,
                cause: refreshFailure,
            });
        }
        emitLog(this.logger, "debug", `${label}: authentication rejected; refreshing for replay`);
        // Another caller may already have refreshed while this request was in flight; reuse that
        // token instead of starting a second mint wave.
        const fresh = await this.tokenManager.get(false, signal);
        if (fresh.accessToken !== token.accessToken)
            return fresh;
        return this.tokenManager.get(true, signal);
    }
    /**
     * Issue a request and return its parsed JSON body as `T`.
     *
     * `T` describes the parsed body and nothing changes that. Byte-returning calls go through
     * `callRaw`, which is a separate method rather than a `raw: true` flag precisely so this
     * generic cannot lie: `call<Foo>(…, { raw: true })` used to type-check and hand back a
     * `Uint8Array`, because the flag and the type parameter were independent.
     */
    async call(method, path, options = {}) {
        return this.loggedRequest(method, path, options, false);
    }
    /**
     * Issue a request and return its body as bytes, for responses that are not JSON — a cover
     * image, an EPUB.
     *
     * Business-code handling still applies: a body that is in fact a WeRead error envelope is
     * rejected, and an expired session replays once, exactly as on `call`. See `businessEnvelope`
     * for how a genuine binary asset is told apart from an envelope.
     */
    async callRaw(method, path, options = {}) {
        if (options.maxResponseBytes !== undefined &&
            (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0)) {
            throw new TypeError("maxResponseBytes must be a positive safe integer");
        }
        return this.loggedRequest(method, path, options, true, options.maxResponseBytes);
    }
    async loggedRequest(method, path, options, raw, maxResponseBytes) {
        const label = `mobile ${method} ${diagnosticPath(path)}`;
        emitLog(this.logger, "debug", `${label}: started`);
        try {
            const response = await this.request(method, path, options, raw, maxResponseBytes);
            emitLog(this.logger, "debug", `${label}: HTTP ${response.status}`);
            return response;
        }
        catch (error) {
            emitLog(this.logger, "error", `${label}: failed`);
            throw error;
        }
    }
    async request(method, path, options, raw, maxResponseBytes) {
        if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\") || /%(?:2f|5c)/i.test(path)) {
            throw new TypeError("mobile path must start with exactly one slash and contain no encoded separators");
        }
        const base = new URL(`${this.baseUrl}/`);
        const requestUrl = new URL(path.slice(1), base);
        if (requestUrl.origin !== base.origin || !requestUrl.pathname.startsWith(base.pathname)) {
            throw new TypeError("mobile path must remain under the configured base URL");
        }
        if (options.signal?.aborted) {
            // Never ambiguous, whatever the method: nothing has been sent yet, so the outcome is known
            // to be "did not happen". Marking it would be the over-marking that makes the flag useless.
            throw toTransportError(options.signal.reason, `mobile ${path}`);
        }
        // The mint is inside the cancellation scope: a caller that aborts while a token is being
        // minted must not have to wait the mint out before its own request fails.
        let token = await this.tokenManager.get(false, options.signal);
        const replayable = options.idempotent === true || /^(?:GET|HEAD)$/i.test(method);
        const transportOptions = options;
        const expiredSessionIsAuthFailure = transportOptions.treatExpiredSessionAsBusinessError !== true;
        for (let attempt = 0; attempt < 2; attempt++) {
            const url = new URL(requestUrl);
            for (const [key, value] of Object.entries(options.query ?? {})) {
                if (value !== undefined)
                    url.searchParams.set(key, String(value));
            }
            const hasBody = options.body !== undefined;
            const combined = requestSignal(options.signal, this.timeoutMs);
            try {
                let response;
                try {
                    response = await this.fetchImpl(url, {
                        method,
                        headers: {
                            ...this.authHeaders(token),
                            ...this.versionHeaders,
                            ...(hasBody ? { "content-type": "application/json; charset=UTF-8" } : {}),
                        },
                        body: hasBody ? JSON.stringify(options.body) : undefined,
                        redirect: "error",
                        signal: combined.signal,
                    });
                }
                catch (cause) {
                    // No response was read at all, so nothing here can say whether the request reached the
                    // server. For a request that was not safe to send twice that is not an ordinary
                    // failure — the write may have landed — and the caller has to be told the difference.
                    throw toTransportError(cause, `mobile ${path}`, { ambiguous: !replayable });
                }
                if (attempt === 0 && response.status === 401) {
                    if (response.body)
                        await response.body.cancel().catch(() => undefined);
                    token = await this.tokenForReplay(token, path, response.status, replayable, options.signal);
                    continue;
                }
                const responseAmbiguous = !replayable && (response.ok || response.status >= 500);
                if (raw) {
                    const bytes = await readRawBody(response, path, maxResponseBytes, responseAmbiguous);
                    // Business-code handling runs BEFORE the success return, not after it. Returning bytes
                    // on `response.ok` alone meant an HTTP 200 carrying errCode -2012 was reported as a
                    // successful download, and the one re-mint-and-replay every other call path gets never
                    // happened.
                    const envelope = businessEnvelope(bytes);
                    const code = errCode(envelope, path, response.status, responseAmbiguous);
                    if (attempt === 0 && code === -2012) {
                        token = await this.tokenForReplay(token, path, response.status, replayable, options.signal, code);
                        continue;
                    }
                    throwIfFailed(response, path, envelope, code, responseAmbiguous);
                    return { status: response.status, headers: response.headers, body: bytes };
                }
                let body;
                try {
                    body = (await readJsonResponse(response));
                }
                catch (cause) {
                    if (cause instanceof ResponseBodyTooLargeError) {
                        throw responseTooLarge(path, response.status, MAX_JSON_RESPONSE_BYTES, responseAmbiguous);
                    }
                    if (cause instanceof ResponseBodyReadError) {
                        throw toTransportError(cause.cause, `mobile ${path}`, { ambiguous: responseAmbiguous });
                    }
                    // A cut-off body is a transport error; a complete non-JSON body is a protocol error.
                    // Either can leave an unsafe write's application outcome unknown.
                    if (!(cause instanceof SyntaxError || cause?.name === "SyntaxError")) {
                        throw toTransportError(cause, `mobile ${path}`, { ambiguous: responseAmbiguous });
                    }
                    throw new WeReadApiError(`mobile ${path}: non-JSON (HTTP ${response.status}): ${cause instanceof Error ? cause.message : String(cause)}`, { path, status: response.status, cause, ambiguous: responseAmbiguous });
                }
                const code = errCode(body, path, response.status, responseAmbiguous);
                if (attempt === 0 && code === -2012 && expiredSessionIsAuthFailure) {
                    token = await this.tokenForReplay(token, path, response.status, replayable, options.signal, code);
                    continue;
                }
                throwIfFailed(response, path, body, code, responseAmbiguous, expiredSessionIsAuthFailure);
                // Below every replay and auth branch on purpose: a 401 whose body is JSON null must
                // still refresh, not fail here. WeRead answers every curated operation with an object,
                // so null/primitives mean the response is unusable — returning them made 25 resource
                // methods resolve to a plausible-looking wrong value instead of failing.
                //
                // An array is rejected for the same reason, and needs saying separately because
                // `typeof [] === "object"` let it through. No curated operation is typed as a bare array;
                // an envelope is always an object. The seams whose fields are all optional
                // (`readData.detail`, `ai.suggest`) have no guard that an array can fail, so an array body
                // reached the caller typed as the response interface — with every field `undefined` and
                // nothing to show anything was wrong. This is the transport's contract to enforce, not
                // each of 25 resource methods'.
                if (body === null ||
                    typeof body !== "object" ||
                    (Array.isArray(body) && transportOptions.acceptArrayResponse !== true)) {
                    throw new WeReadApiError(`mobile ${path}: malformed response body`, {
                        path,
                        status: response.status,
                        ambiguous: responseAmbiguous,
                    });
                }
                return { status: response.status, headers: response.headers, body };
            }
            finally {
                combined.dispose();
            }
        }
        throw new WeReadApiError(`mobile ${path}: retry exhausted`, { path, status: 0 });
    }
}
