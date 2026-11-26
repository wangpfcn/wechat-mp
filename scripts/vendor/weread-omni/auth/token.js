import { randomInt } from "node:crypto";
import { MAX_JSON_RESPONSE_BYTES, ResponseBodyReadError, ResponseBodyTooLargeError, readJsonResponse, } from "../api/response-body.js";
import { requestSignal, waitUnlessAborted } from "../api/signal.js";
import { AuthError, toTransportError } from "../errors.js";
import { emitLog } from "../logger.js";
import { resolveProfile } from "../profile.js";
const DEFAULT_BASE_URL = "https://i.weread.qq.com";
const MINT_LABEL = "WeRead access-token mint";
const loginUrl = (baseUrl) => `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/login`;
function requireIdentityValue(value, field) {
    if (typeof value === "string") {
        if (value.length === 0)
            throw new AuthError(`WeRead access-token mint returned an empty ${field}`);
        return value;
    }
    if (typeof value === "number" && Number.isInteger(value))
        return String(value);
    throw new AuthError(`WeRead access-token mint returned a non-scalar ${field}`);
}
function requireToken(value, field) {
    if (typeof value === "string" && value.length > 0)
        return value;
    throw new AuthError(`WeRead access-token mint returned an invalid ${field}`);
}
export async function mintAccessToken(credentials, fetchImpl = fetch, options = {}) {
    const profile = resolveProfile(options);
    const timestamp = Date.now();
    const random = randomInt(1, 1001);
    const body = {
        deviceId: credentials.deviceId,
        deviceName: profile.deviceName,
        inBackground: 0,
        kickType: 1,
        random,
        refCgi: "",
        refreshToken: credentials.refreshToken,
        signature: profile.refreshSignature(credentials.deviceId, timestamp, random, credentials.refreshToken),
        timestamp,
        trackId: "",
        ...profile.loginBodyExtras(),
        deviceType: profile.deviceType,
    };
    // Disposed only after the body is read: on the fallback composition path `dispose()` unhooks
    // the caller's signal, so releasing it before the response body is read would leave that read
    // uncancellable.
    const combined = requestSignal(options.signal, options.timeoutMs ?? 30_000);
    try {
        let response;
        try {
            response = await fetchImpl(loginUrl(options.baseUrl), {
                method: "POST",
                headers: {
                    ...profile.versionHeaders,
                    "content-type": "application/json; charset=UTF-8",
                },
                body: JSON.stringify(body),
                redirect: "error",
                signal: combined.signal,
            });
        }
        catch (error) {
            throw toTransportError(error, MINT_LABEL);
        }
        let result;
        try {
            result = (await readJsonResponse(response));
        }
        catch (error) {
            if (error instanceof ResponseBodyTooLargeError) {
                throw new AuthError(`${MINT_LABEL}: response exceeds ${MAX_JSON_RESPONSE_BYTES} bytes`);
            }
            if (error instanceof ResponseBodyReadError) {
                throw toTransportError(error.cause, MINT_LABEL);
            }
            if (error instanceof SyntaxError || error?.name === "SyntaxError") {
                throw new AuthError("WeRead access-token mint returned a non-JSON response", { cause: error });
            }
            throw toTransportError(error, MINT_LABEL);
        }
        // A literal `null` body reached the property read below and threw a raw TypeError instead of
        // the typed AuthError every other failure on this path produces.
        if (result === null || typeof result !== "object") {
            throw new AuthError("WeRead access-token mint returned an unusable response body");
        }
        if (!response.ok || typeof result.accessToken !== "string" || result.accessToken.length === 0) {
            throw new AuthError(`WeRead access-token mint failed: ${String(result.errCode ?? response.status)} ${String(result.errMsg ?? "")}`.trim());
        }
        const vid = result.vid === undefined ? credentials.vid : requireIdentityValue(result.vid, "vid");
        if (vid !== credentials.vid) {
            throw new AuthError("WeRead access-token mint returned credentials for a different account");
        }
        return {
            vid,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken === undefined
                ? credentials.refreshToken
                : requireToken(result.refreshToken, "refreshToken"),
        };
    }
    finally {
        combined.dispose();
    }
}
export class TokenManager {
    credentials;
    cached;
    pending;
    credentialsToPersist;
    pendingPersistence;
    fetchImpl;
    onCredentials;
    timeoutMs;
    baseUrl;
    profile;
    logger;
    constructor(credentials, options = {}) {
        this.credentials = { ...credentials };
        if (credentials.accessToken) {
            this.cached = {
                vid: credentials.vid,
                accessToken: credentials.accessToken,
                refreshToken: credentials.refreshToken,
            };
        }
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.onCredentials = options.onCredentials;
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.baseUrl = options.baseUrl;
        this.profile = resolveProfile(options);
        this.logger = options.logger;
    }
    /**
     * `signal` cancels *this caller's wait*, never the mint.
     *
     * The mint is single-flight: several requests share one in-flight `/login`. Forwarding a
     * caller's signal into it would let whoever aborts first cancel a mint the other waiters are
     * still depending on — and the token it would have cached, and the credential rotation it
     * would have persisted. So an aborting caller only stops listening; the mint runs to
     * completion for everybody else.
     *
     * The same rule covers the persistence retry on the cached path below. `onCredentials` is
     * user-supplied and may be arbitrarily slow (a network-backed secret store, say), and it is
     * shared the same way the mint is — so an aborting caller stops waiting on it, and the write
     * still lands for everyone else.
     */
    async get(force = false, signal) {
        if (this.pending)
            return waitUnlessAborted(this.pending, MINT_LABEL, signal);
        if (this.cached) {
            if (force)
                this.cached = undefined;
            // Started before the abort check, not after: the retry is deliberately kicked off even for
            // a caller that has already gone, because the queued credentials belong to the manager
            // rather than to whoever happened to walk past it.
            if (this.credentialsToPersist)
                await waitUnlessAborted(this.retryPersistence(), MINT_LABEL, signal);
            if (this.pending)
                return waitUnlessAborted(this.pending, MINT_LABEL, signal);
            if (!force && this.cached) {
                if (signal?.aborted)
                    throw toTransportError(signal.reason, MINT_LABEL);
                return this.cached;
            }
        }
        // Started without `signal` on purpose — see the note above.
        const started = this.mint();
        // The slot is released when the *mint* settles, not when a waiter stops waiting: clearing it
        // on abort would let the next caller start a second, concurrent mint.
        const pending = started.then((token) => {
            this.release(pending);
            return token;
        }, (error) => {
            this.release(pending);
            throw error;
        });
        this.pending = pending;
        return waitUnlessAborted(pending, MINT_LABEL, signal);
    }
    release(pending) {
        if (this.pending === pending)
            this.pending = undefined;
    }
    async mint() {
        emitLog(this.logger, "debug", `${MINT_LABEL}: started`);
        const previous = this.credentials;
        const token = await mintAccessToken(this.credentials, this.fetchImpl, {
            timeoutMs: this.timeoutMs,
            baseUrl: this.baseUrl,
            profile: this.profile,
        });
        const changed = token.vid !== previous.vid ||
            token.accessToken !== previous.accessToken ||
            token.refreshToken !== previous.refreshToken;
        this.credentials = {
            vid: token.vid,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            deviceId: previous.deviceId,
        };
        this.cached = token;
        if (changed) {
            this.credentialsToPersist = { ...this.credentials };
            await this.persistCredentials();
            emitLog(this.logger, "info", `${MINT_LABEL}: credentials rotated`);
        }
        return token;
    }
    persistCredentials() {
        if (!this.credentialsToPersist || !this.onCredentials)
            return Promise.resolve();
        if (this.pendingPersistence)
            return this.pendingPersistence;
        const credentials = this.credentialsToPersist;
        const pending = Promise.resolve(this.onCredentials({ ...credentials })).then(() => {
            if (this.credentialsToPersist === credentials)
                this.credentialsToPersist = undefined;
        });
        this.pendingPersistence = pending;
        return pending.finally(() => {
            if (this.pendingPersistence === pending)
                this.pendingPersistence = undefined;
        });
    }
    async retryPersistence() {
        try {
            await this.persistCredentials();
        }
        catch {
            // The first failed persistence has already been reported; keep the valid token usable.
            emitLog(this.logger, "warn", `${MINT_LABEL}: credential persistence retry failed`);
        }
    }
}
