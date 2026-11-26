# Bundled third-party code

Everything wxmp needs besides Node.js itself ships in this folder, so the skill works as soon as it
is copied: there is no install step and no `node_modules`.

| Folder | Package | Version | License | Used for |
|---|---|---|---|---|
| `turndown/` | [turndown](https://github.com/mixmark-io/turndown) | 7.2.5 | MIT (includes code by Luc Thevenard, MIT) | HTML → Markdown |
| `turndown-plugin-gfm/` | [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) | 1.0.2 | MIT | Markdown tables |
| `domino/` | [@mixmark-io/domino](https://github.com/mixmark-io/domino) | 2.2.0 | BSD-2-Clause (includes `select.js` by Christopher Jeffrey, MIT; `style_parser.js` by Google LLC, MIT-style; `DOMException.js` text under the W3C Document License) | the HTML parser turndown uses under Node |
| `qrcode-terminal/` | [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) | 0.12.0 | Apache-2.0 (includes QRCode code by Kazuhiko Arase, MIT) | the login QR code in the terminal |
| `weread-omni/` | [weread-omni](https://github.com/teng-lin/weread-omni) | 0.1.2 | MIT | WeRead login, token renewal and requests: see [its own README](weread-omni/README.md) |

Each file keeps its original copyright and licence notices.

## turndown, turndown-plugin-gfm, domino, qrcode-terminal

These four are the packages' published files from the npm registry (tarballs checked against the
sha512 integrity values below), trimmed to what runs: each package's `LICENSE` and `package.json`
plus its CommonJS build (`lib/`; for qrcode-terminal also `vendor/QRCode/`). Tests, docs, browser and
ES builds are left out. The files are byte-for-byte as published (domino's use CRLF line endings).

One line is changed: in `turndown/lib/turndown.cjs.js`, `require('@mixmark-io/domino')` reads
`require('../../domino/lib/index.js')`, so turndown loads the bundled parser instead of looking for an
installed package.

npm integrity (sha512) of the published tarballs:

- turndown 7.2.5: `EKZvCCFHh8sWttpAMs10U6niZFJ2cpz8LkCPlylxoG4JcHF50J7EHnnBW3AY1qXtUMu7kDjCp7dnggB1sIbqEQ==`
- turndown-plugin-gfm 1.0.2: `vwz9tfvF7XN/jE0dGoBei3FXWuvll78ohzCZQuOb+ZjWrs3a0XhQVomJEb2Qh4VHTPNRO4GPZh0V7VRbiWwkRg==`
- @mixmark-io/domino 2.2.0: `Y28PR25bHXUg88kCV7nivXrP2Nj2RueZ3/l/jdx6J9f8J4nsEGcgX0Qe6lt7Pa+J79+kPiJU3LguR6O/6zrLOw==`
- qrcode-terminal 0.12.0: `EXtzRZmC+YGmGlDFbXKxQiMZNwCLEO6BANKXG4iCtSIM0yqc/pappSx3RIKr4r0uh5JsBckOXeKrB3Iz7mdQpQ==`
