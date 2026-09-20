# Shipping a Mozilla-signed GoalGuard (`.xpi`)

Release-channel Firefox (Release, Beta, ESR) refuses to install any extension that
does not carry a **Mozilla signature**. Without one you get:

> *Add-on could not be installed because it has not been verified.*

Only Mozilla can produce that signature, via
[addons.mozilla.org (AMO)](https://addons.mozilla.org/developers/). This repo contains
everything else: a reproducible `.xpi` builder, the same static validator AMO runs,
and a one-command signing flow. The only thing you must bring is a (free) AMO
account — signing cannot be done offline and no key in this repo can substitute for it.

```bash
npm run package   # → dist/goalguard-0.1.0.{zip,xpi}  (unsigned, byte-identical)
npm run lint:amo  # Mozilla's addons-linter: must report 0 errors
npm run sign      # upload → AMO signs → web-ext-artifacts/*.xpi (installable)
```

## 1. Build the `.xpi`

```bash
npm run package
```

This runs the manifest checks (`scripts/check-manifest.mjs` — missing assets,
unresolved imports, CSP, version sync, add-on ID) and then writes two files with
**identical bytes**:

| File | Purpose |
| --- | --- |
| `dist/goalguard-<version>.zip` | Upload to AMO, or load via `about:debugging` → Load Temporary Add-on |
| `dist/goalguard-<version>.xpi` | What Firefox installs. An `.xpi` *is* a zip with a different extension |

Only the extension's runtime files are included (`manifest.json`, `src/`, `popup/`,
`options/`, `blocking/`, `ledger/`, `icons/`, `vendor/`, `models/`, `LICENSE` —
61 files, ≈27 MB). Tests, scripts, docs and `node_modules/` never ship; the file
list lives in one place (`INCLUDE` in `scripts/package.mjs`).

The bulk of the size is the offline-first design: the int8 ONNX model (≈34 MB
uncompressed) and the ONNX Runtime WASM binaries (≈19 MB). That is expected and
well under AMO's upload limits.

## 2. Validate like AMO does

```bash
npm run lint:manifest  # fast repo-local checks
npm run lint:amo       # web-ext lint — Mozilla's addons-linter over the shipped files
```

`npm run sign` runs both automatically first (via `presign`) and refuses to upload
on failure. A clean tree reports:

```
errors 0, notices 0, warnings 9
```

The 9 warnings are known, expected, and do **not** block signing:

| Warning | Where | Why it's fine |
| --- | --- | --- |
| `…_UNSUPPORTED_BY_MIN_VERSION` (×4) | `manifest.json` | `data_collection_permissions` needs FF 140+ and `optional_host_permissions` needs FF 128+, while `strict_min_version` is 115. Older Firefox ignores unknown keys; the extension still loads. |
| `UNSAFE_VAR_ASSIGNMENT` (×3) | `src/model/embeddingModel.js`, `src/llm/localLLM.js` | Lazy `await import(transformersUrl)` so the 900 KB Transformers.js parses only when AI runs. Production callers pass `runtime.getURL('vendor/transformers.min.js')` (same-extension URL); the parameter exists so Node tests can inject the npm module. No user input reaches it. |
| `DANGEROUS_EVAL` (×2) | `vendor/transformers.min.js` | Inside the pinned, unmodified upstream build of `@xenova/transformers@2.17.2` (Apache-2.0, see `vendor/LICENSE-transformers.txt`). Not our code; cannot be removed without forking the library. |

If `lint:amo` reports any **error**, fix it before signing — AMO's server-side
validation runs the same linter and rejects the upload otherwise.

## 3. Get AMO API credentials (one time)

1. Create/log in to your account at
   [addons.mozilla.org/developers](https://addons.mozilla.org/developers/).
2. Open the [API credentials page](https://addons.mozilla.org/developers/addon/api/key/)
   and generate credentials. You get:
   - **JWT issuer** (`user:12345:67`) → the API *key*
   - **JWT secret** (long hex) → the API *secret*
3. Export them (every shell you sign from, or your CI secrets — **never commit them**):

```bash
export WEB_EXT_API_KEY='user:12345:67'
export WEB_EXT_API_SECRET='<jwt-secret>'
```

`web-ext` reads these environment variables automatically.

## 4. Sign

### Option A — self-distribution (recommended for personal use)

```bash
npm run sign   # web-ext sign --channel=unlisted
```

AMO validates the upload automatically, signs it, and `web-ext` downloads the
result to `web-ext-artifacts/` (e.g. `goalguard_goal-based_screen_time-0.1.0.xpi`).
Total time is typically a few minutes for a package this size. Host that file
anywhere (GitHub Releases, your site) — it installs on any release Firefox.

`web-ext sign` rebuilds the submission zip from source itself; its exclude list in
`web-ext-config.mjs` is derived from the same `INCLUDE` allowlist as
`npm run package`, and the two outputs have been verified to contain the identical
61-file set.

### Option B — public listing on AMO

```bash
npm run sign:listed   # web-ext sign --channel=listed
```

Same flow, but the version enters the public-review queue (human review; can take
days). First-time listed submissions may ask for AMO listing metadata
(`--amo-metadata`, see the
[sign reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign))
and, because the package ships minified/WASM third-party code, a reviewer may ask
for build sources via
[`--upload-source-code`](https://extensionworkshop.com/documentation/publish/source-code-submission/).
If that happens, point at the pinned upstreams — nothing is forked or patched:

- `vendor/transformers.min.js` → unmodified browser build from the
  `@xenova/transformers@2.17.2` npm tarball
  ([GitHub tag `2.17.2`](https://github.com/xenova/transformers.js))
- `vendor/ort/*.wasm` → stock `onnxruntime-web@1.14.0` binaries
- `models/bge-small-en-v1.5/onnx/model_quantized.onnx` → `BAAI/bge-small-en-v1.5`
  (MIT) quantised as described in `models/README.md`

### Option C — no CLI: upload by hand

1. `npm run package`, then open the
   [Developer Hub submission flow](https://addons.mozilla.org/developers/addon/submit/distribution)
   and upload `dist/goalguard-<version>.zip`.
2. Choose **On your own** (unlisted) or **On this site** (listed).
3. For unlisted, approve the automatic validation and download the signed `.xpi`
   from the version page.

## 5. Install the signed `.xpi` in Firefox

In any release Firefox (115+):

1. Open `about:addons` → gear icon → **Install Add-on From File…** and pick the
   signed `.xpi` (equivalently: `File → Open File…`, or drag-drop the file onto
   Firefox).
2. Approve the permission prompt. `about:addons` now lists GoalGuard permanently —
   it survives restarts, unlike temporary installs.

To confirm the signature did its job: an *unsigned* build installed the same way
fails with *"has not been verified"*; the signed one installs silently.

> Developer Edition / Nightly can additionally install *unsigned* builds with
> `xpinstall.signatures.required = false`, but that never works on Release —
> signing is the only path there.

## 6. Updates and versioning

- **Listed** versions update automatically through AMO.
- **Unlisted** versions do *not* auto-update unless you add an update URL:
  set `browser_specific_settings.gecko.update_url` in `manifest.json` to an
  update manifest you host (format documented under
  [Enabling updates](https://extensionworkshop.com/documentation/manage/updating-your-extension/)),
  sign each release, and publish the new `.xpi` at the URL the manifest points to.
  Without it, users reinstall each release by hand.
- Every upload to AMO needs a **new version number** — re-uploading an existing
  version fails. Bump `version` in `manifest.json` **and** `package.json` together
  (`lint:manifest` errors if they disagree).
- Never change `browser_specific_settings.gecko.id`
  (`goalguard@local.extension`): Firefox treats a new ID as a different add-on and
  updates stop reaching existing installs.

## Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| *"has not been verified"* on install | File was never signed, or you grabbed `dist/` (unsigned) instead of `web-ext-artifacts/` (signed). Run `npm run sign` and install the downloaded file. |
| *"appears to be corrupt"* | Truncated download, or installing an *older* version over a newer one. Re-download; versions must always increase. |
| `Version 0.1.0 already exists` from `sign` | AMO keeps every upload. Bump the version (both manifests) and retry. |
| `sign` times out | Large uploads + validation can take minutes. Check the Developer Hub first — the signed file may already be ready for download. Otherwise retry (bumping the version if the first attempt registered one). |
| `lint:amo` errors after adding a file | AMO lints the same set; fix locally until `errors 0`. Files outside `INCLUDE` are automatically excluded from both lint and sign. |
| Credentials rejected | Regenerate at the API-key page; check for pasted whitespace; both env vars must be exported in the signing shell. |
| `xpinstall.signatures.required` has no effect | Expected on Release/Beta/ESR — that preference only exists on Nightly/Developer Edition. Sign the extension instead. |
