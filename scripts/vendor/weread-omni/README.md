# Modules taken from weread-omni

These files come from [weread-omni](https://github.com/teng-lin/weread-omni) 0.1.2 (`dist/`), by Teng Lin,
under the MIT license in `LICENSE` next to this file. They are copied as published; the only change is that
the trailing `//# sourceMappingURL=` line of each file is removed, because the source maps are not shipped.

| File | What it does |
|---|---|
| `auth/qrlogin.js` | WeChat QR login for WeRead (as an e-ink device) |
| `auth/token.js` | access-token mint and refresh, one mint at a time |
| `api/mobile.js` | the request layer: headers, business error codes, one replay after a token refresh |
| `api/response-body.js`, `api/signal.js` | bounded response reading, timeouts |
| `profile.js`, `device-ua.js` | the device identity sent with every request |
| `errors.js`, `logger.js`, `redact.js` | error classes, optional logging, secret redaction |

wxmp's own code on top of them is in `scripts/lib/embedded/`: the account files, the handful of
endpoints wxmp calls, and the article page download. The rest of weread-omni (its command line, its
40 operations, feeds, exports, its article extraction and its content library) is not included.

To update: copy the same files from a newer weread-omni `dist/`, remove the sourceMappingURL lines, and
run the tests (`npm test`).
