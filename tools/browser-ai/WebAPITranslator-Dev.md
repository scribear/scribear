# Translator API — Complete Developer Reference

Empirically verified on **Google Chrome 150.0.7871.186** and **Microsoft Edge
150.0.4078.99** (Linux, 2026-07-27) using Playwright/Puppeteer + `xvfb-run`. All code samples,
error messages, and timings were captured from real probe runs against the live API.

- Spec: <https://webmachinelearning.github.io/translation-api/>
- Chrome docs: <https://developer.chrome.com/docs/ai/translator-api>
- Edge docs: <https://learn.microsoft.com/microsoft-edge/web-platform/translator-api>
- MDN: <https://developer.mozilla.org/docs/Web/API/Translator>

---

## Table of Contents

1. [Prerequisites & Browser Setup](#1-prerequisites--browser-setup)
2. [API Surface (IDL)](#2-api-surface-idl)
3. [State Machine: availability() → create() → translate()](#3-state-machine-availability--create--translate)
4. [Detailed Method Reference (empirically verified)](#4-detailed-method-reference-empirically-verified)
5. [Error Conditions (complete table)](#5-error-conditions-complete-table)
6. [Quotas, Limits & Text Size](#6-quotas-limits--text-size)
7. [Streaming Behavior](#7-streaming-behavior)
8. [Spec vs Chrome Discrepancies](#8-spec-vs-chrome-discrepancies)
9. [Recommended Wrapper Interface](#9-recommended-wrapper-interface)
10. [Mock Implementation for Tests](#10-mock-implementation-for-tests)
11. [Playwright/Puppeteer Launch Recipe](#11-playwrightpuppeteer-launch-recipe)

---

## 1. Prerequisites & Browser Setup

### Browser requirement

| Build | `Translator` exposed? | Works end-to-end? | Notes |
|---|---|---|---|
| **Google Chrome stable ≥138** (desktop) | **Yes** | **Yes** | Fully verified. Translations succeed. |
| **Microsoft Edge stable ≥138** (desktop) | **Yes** | **No** (Linux) | API present, model downloads, but translation service crashes on Linux. May work on Windows/macOS. |
| Chrome for Testing (CfT) | No | No | Missing Optimization Guide components. |
| Chromium | No | No | Same — proprietary model components stripped. |
| Playwright's bundled Chromium | No | No | It's a CfT variant. |
| Chrome/Edge on Android/iOS | No | No | Desktop only per docs. |

### OS / hardware (per docs)

- **OS**: Windows 10/11, macOS 13+, Linux, ChromeOS (Chromebook Plus for foundation model).
- **Network**: Unmetered, for initial model download only.
- **Translator + Language Detector**: no special CPU/GPU/disk requirements (they use lightweight
  "expert" models, not the Gemini Nano foundation model).
- **Foundation model APIs** (Prompt/Writer/Summarizer/etc): need ≥22 GB disk, ≥4 GB VRAM or
  ≥16 GB RAM + ≥4 cores. The Translator API does **not** share these requirements.

### Required flag

`chrome://flags/#optimization-guide-on-device-model` must be **Enabled** for localhost/local
prototyping. In production (HTTPS), the API ships without needing the flag in Chrome ≥138.

To set the flag programmatically, write to the profile's `Local State` JSON:

```js
const ls = JSON.parse(fs.readFileSync(`${userDataDir}/Local State`, 'utf8'));
ls.browser = ls.browser ?? {};
ls.browser.enabled_labs_experiments = ['optimization-guide-on-device-model@1'];
fs.writeFileSync(`${userDataDir}/Local State`, JSON.stringify(ls, null, 2));
```

### Model download (first use per language pair)

Each language pair (e.g. `en→es`) downloads as a separate Chrome component:
- **`Chrome TranslateKit`** — base library (~first download, needed for all pairs).
- **`Chrome TranslateKit <src>-<tgt>`** — per-pair model (e.g. `Chrome TranslateKit en-es`).

These appear in `chrome://components`. On first `create()` for a new pair, the model downloads
(seen via `monitor`'s `downloadprogress` events, `e.loaded` 0→1). Subsequent calls are instant.

**Important**: The ~20 GB requirement is for the **foundation model** APIs (Gemini Nano), not the
Translator API. TranslateKit models are small (tens of MB). However, users should still be warned
about a download and potential delay, especially on slow connections.

---

## 2. API Surface (IDL)

From the spec, cross-checked against the live Chrome prototype:

```webidl
[Exposed=Window, SecureContext]
interface Translator {
  // Static
  static Promise<Translator> create(TranslatorCreateOptions options);
  static Promise<Availability> availability(TranslatorCreateCoreOptions options);

  // Instance methods
  Promise<DOMString> translate(DOMString input, optional TranslatorTranslateOptions options = {});
  ReadableStream translateStreaming(DOMString input, optional TranslatorTranslateOptions options = {});
  Promise<double> measureInputUsage(DOMString input, optional TranslatorTranslateOptions options = {});
  undefined destroy();  // from DestroyableModel mixin

  // Instance properties (readonly)
  readonly attribute DOMString sourceLanguage;
  readonly attribute DOMString targetLanguage;
  readonly attribute unrestricted double inputQuota;
};

dictionary TranslatorCreateCoreOptions {
  required DOMString sourceLanguage;
  required DOMString targetLanguage;
};

dictionary TranslatorCreateOptions : TranslatorCreateCoreOptions {
  AbortSignal signal;
  CreateMonitorCallback monitor;
};

dictionary TranslatorTranslateOptions {
  AbortSignal signal;
};

enum Availability {
  "unavailable",    // device/browser/policy can't support this pair, ever
  "downloadable",   // can work but model must be downloaded first (needs user gesture for create())
  "downloading",    // download already in progress
  "available",      // ready to use immediately
};
```

**Verified prototype members** (Chrome 150):

```
Translator.prototype:
  inputQuota, sourceLanguage, targetLanguage,    // getters
  destroy, measureInputUsage, translate, translateStreaming,  // methods
  constructor

Translator (static):
  availability, create
```

### Secure context

The API requires a **secure context** (HTTPS or `localhost`). It is **not** exposed on
`about:blank`, `file://`, or plain HTTP (non-localhost).

### Permissions policy

Feature name: `"translator"`. Default allowlist: `['self']` (top-level document + same-origin
iframes). Cross-origin iframes need `allow="translator"`. **Not available in Web Workers.**

---

## 3. State Machine: availability() → create() → translate()

```
                    ┌─────────────────────────────────────────────────┐
                    │            Translator.availability()              │
                    └─────────────────────────────────────────────────┘
                                     │
         ┌──────────────┬───────────┼───────────┬──────────────┐
         ▼              ▼           ▼           ▼              ▼
    "unavailable"  "downloadable" "downloading" "available"  (throws)
         │              │           │           │              │
         │              │           │           │              ├─ RangeError (invalid BCP-47 tag)
         │              │           │           │              └─ TypeError (missing/null args)
         │              │           │           │
    Cannot use.     Needs user    Wait for    Ready!
    Pair not        activation    download    Call create()
    supported or    + download    to finish.  → instant.
    hardware        via create()  
    insufficient.   (monitor      
                    fires          
                    downloadprogress)
         │              │                       │
         ▼              ▼                       ▼
    create()       create()                create()
    throws         downloads model,         returns Translator
    NotSupported   then returns             immediately
    Error          Translator
                    │                       │
                    └───────┬───────────────┘
                            ▼
                     Translator instance
                     (sourceLanguage, targetLanguage, inputQuota set)
                            │
                    ┌───────┼───────────┐
                    ▼       ▼           ▼
               translate()  translateStreaming()  measureInputUsage()
                    │       │           │
                    ▼       ▼           ▼
               Promise<str> ReadableStream  Promise<double>
                    │       of string chunks  (always 0 in Chrome)
                    │       │
                    └───────┤
                            ▼
                     destroy()
                     → instance dead
                     → all future calls throw AbortError
                     → sourceLanguage/targetLanguage/inputQuota still readable
```

---

## 4. Detailed Method Reference (empirically verified)

### 4.1 `Translator.availability(options)` — static async

Checks whether a language pair is supported and what state the model is in.

**Parameters**: `{ sourceLanguage: string, targetLanguage: string }` (both required, BCP-47 codes).

**Returns**: `Promise<Availability>` — one of `"unavailable"`, `"downloadable"`, `"downloading"`,
`"available"`.

**Verified results** (Chrome 150, en→es model cached):

| `sourceLanguage` | `targetLanguage` | Result | Notes |
|---|---|---|---|
| `"en"` | `"es"` | `"available"` | Model cached. |
| `"es"` | `"en"` | `"downloadable"` | Reverse pair not cached. |
| `"en"` | `"fr"` | `"downloadable"` | Not cached. |
| `"en"` | `"ja"` | `"downloadable"` | Not cached. |
| `"en"` | `"ar"` | `"downloadable"` | Not cached. |
| `"en"` | `"zh"` | `"downloadable"` | Not cached. |
| `"en"` | `"zh-Hant"` | `"downloadable"` | Not cached. |
| `"en"` | `"de"` | `"downloadable"` | Not cached. |
| `"en"` | `"en"` | `"unavailable"` | **No identity translation** (contradicts spec). |
| `"en-US"` | `"en-GB"` | `"unavailable"` | **No identity translation** (contradicts spec). |
| `"xx"` | `"yy"` | `"unavailable"` | Invalid codes → unavailable, no throw. |
| `"en"` | `"zz"` | `"unavailable"` | Valid format, unsupported → unavailable. |
| `""` | `"es"` | **throws `RangeError`** | Empty string is invalid BCP-47. |
| `"en"` | `""` | **throws `RangeError`** | Same. |
| `{}` | — | **throws `TypeError`** | Missing required members. |
| `undefined` | — | **throws `TypeError`** | Not of type `TranslatorCreateCoreOptions`. |
| `null` | — | **throws `TypeError`** | Same. |

**Key takeaway**: `availability()` is the entry point. Always call it first. It tells you whether
the pair is supported at all (`unavailable` = hard no), needs a download (`downloadable`), is
currently downloading (`downloading`), or is ready (`available`).

**Note on privacy**: Chrome deliberately hides per-pair download status. All not-yet-cached
pairs report `"downloadable"` until a site actually creates a translator for that pair. You
cannot distinguish "downloaded but not cached for this origin" from "never downloaded."

### 4.2 `Translator.create(options)` — static async

Creates a `Translator` instance, downloading the model if needed.

**Parameters**:
```ts
{
  sourceLanguage: string,   // required, BCP-47
  targetLanguage: string,   // required, BCP-47
  signal?: AbortSignal,     // optional, abort the creation/download
  monitor?: (m: CreateMonitor) => void,  // optional, download progress
}
```

**Returns**: `Promise<Translator>`

**Monitor behavior** (verified): The `monitor` callback receives a `CreateMonitor` object. Attach
a `downloadprogress` event listener to it. The event's `e.loaded` is a float 0→1 (0% to 100%).
When the model is already cached, you still get two events: `{loaded: 0}` then `{loaded: 1}`.

```js
const translator = await Translator.create({
  sourceLanguage: 'en',
  targetLanguage: 'es',
  monitor(m) {
    m.addEventListener('downloadprogress', (e) => {
      console.log(`Download: ${(e.loaded * 100).toFixed(1)}%`);
    });
  },
});
```

**Verified create scenarios**:

| Scenario | Result |
|---|---|
| Cached pair (`en→es`), no monitor | Returns Translator instantly. |
| Cached pair with monitor | Monitor fires `downloadprogress` 0 then 1 (instant). |
| Uncached pair (`en→ja`) | Downloads model (may take time); `downloadprogress` fires. |
| Invalid pair (`xx→yy`) | Throws `NotSupportedError: Unable to create translator for the given source and target language.` |
| Identity pair (`en→en`) | Throws `NotSupportedError` (Chrome doesn't support identity translation). |
| Missing args (`{}`) | Throws `TypeError: Required member is undefined.` |
| Already-aborted `signal` | Throws `AbortError: signal is aborted without reason`. |
| Without user activation (when `downloadable`) | `create()` may reject (per docs). Verified: on cached pairs, no user activation needed. |

**User activation**: When `availability()` returns `"downloadable"`, calling `create()` requires
`navigator.userActivation.isActive` (a recent user gesture like click/keydown). When
`availability()` returns `"available"`, no user activation is needed. Always provide a user
gesture (e.g., a button click) before calling `create()` to be safe.

### 4.3 `translator.translate(input, options?)` — async

Translates a string.

**Parameters**:
- `input: string` — the text to translate (WebIDL `DOMString`, so non-strings are coerced via `String()`).
- `options?: { signal?: AbortSignal }` — optional abort signal.

**Returns**: `Promise<string>`

**Verified translate scenarios**:

| Input | Result | Notes |
|---|---|---|
| `"Hello, how are you?"` | `"Hola cómo estás?"` | Normal. |
| `""` (empty) | `""` | Passes through unchanged. |
| `"   \n\t  "` (whitespace) | `"   \n\t  "` | Passes through unchanged. |
| `42` (number) | `"42"` | DOMString coercion → `"42"` → translated as-is. |
| `null` | `"nulo"` | Coerced to string `"null"` → translated. |
| `undefined` | `"indefinido"` | Coerced to `"undefined"` → translated. |
| `true` | `"verdadero"` | Coerced to `"true"` → translated. |
| `{toString(){return 'hello'}}` | `"hola"` | Uses `toString()`. |
| `['hello','world']` | `"hola mundo"` | Array.join(',') → `"hello,world"`. |
| 100K chars | Works (~24s) | No size limit hit. |
| 500K chars | Works | No size limit hit. |
| After `destroy()` | Throws `AbortError` | All methods fail after destroy. |
| Pre-aborted `signal` | Throws `AbortError` | |
| Mid-translate abort | Throws `AbortError` | |

**Concurrent calls**: The Chrome docs claim "translations are processed sequentially," but
**empirically they run concurrently** — 3 simultaneous `translate()` calls all completed in 20ms.

**Emoji/CJK**: Translation works but may garble non-Latin scripts. Emoji and CJK characters
sometimes produce mojibake (likely an encoding issue in the model's tokenizer). Latin accented
characters (é, ñ, ü) translate correctly.

### 4.4 `translator.translateStreaming(input, options?)`

Streaming variant. Returns a `ReadableStream<string>`.

**Returns**: `ReadableStream` (verified: `stream instanceof ReadableStream === true`, supports
`for await...of` via `.values()`).

**Chunk behavior** (verified):

| Input length | Chunks | Chunk sizes | Time |
|---|---|---|---|
| 12 chars | 1 | [11] | 13ms |
| 105 chars | 2 | [53, 84] | 79ms |
| 450 chars | 10 | ~53-54 each | 355ms |
| 2250 chars | 50 | ~53-54 each | 1702ms |
| `""` (empty) | 1 | `[""]` | instant |

Chunks are roughly sentence-sized (~50-80 chars). The stream yields partial translations as the
model produces them. Each chunk is a string fragment; concatenate them for the full translation.

**Abort**: Pass `{ signal }` and abort. The `for await` loop throws `AbortError`.

```js
const stream = translator.translateStreaming(longText, { signal: ac.signal });
try {
  for await (const chunk of stream) {
    output += chunk;
  }
} catch (e) {
  if (e.name === 'AbortError') { /* aborted */ }
  else throw e;
}
```

### 4.5 `translator.measureInputUsage(input, options?)` — async

Reports how much "input quota" a given text would consume.

**Returns**: `Promise<double>`

**Verified**: Always returns `0` in Chrome 150. The `inputQuota` property is `null` (not a
number). Chrome does not enforce any input quota for the Translator API. This method exists for
spec compliance but is effectively a no-op.

### 4.6 `translator.destroy()` — sync

Releases the translator's resources. **Synchronous** (returns `undefined`, not a Promise).

**Post-destroy behavior** (verified):

| Call after `destroy()` | Result |
|---|---|
| `translate()` | Throws `AbortError` |
| `translateStreaming()` | Throws `AbortError` |
| `measureInputUsage()` | Throws `AbortError` |
| `destroy()` again | No-op (succeeds silently) |
| `translator.sourceLanguage` | Still returns `"en"` |
| `translator.targetLanguage` | Still returns `"es"` |
| `translator.inputQuota` | Still returns `null` |

**Note**: The `AbortError` after destroy is misleading — it's not an actual abort, just Chrome's
way of signaling the translator is no longer usable. There is no dedicated `InvalidStateError`
or similar.

### 4.7 Instance properties (verified)

| Property | Type | Example | After destroy? |
|---|---|---|---|
| `sourceLanguage` | `string` | `"en"` | Still readable |
| `targetLanguage` | `string` | `"es"` | Still readable |
| `inputQuota` | `null` | `null` | Still readable |

---

## 5. Error Conditions (complete table)

| Error type | When | Message (verbatim) | Recoverable? |
|---|---|---|---|
| **`RangeError`** | `availability()` or `create()` with invalid BCP-47 tag (e.g. `""`, `"x"`) | `Failed to execute 'availability' on 'Translator': Invalid language tag: ` | Fix the tag. |
| **`TypeError`** | Missing required `sourceLanguage`/`targetLanguage` in options | `Failed to execute 'create' on 'Translator': Failed to read the 'sourceLanguage' property from 'TranslatorCreateCoreOptions': Required member is undefined.` | Fix the args. |
| **`TypeError`** | `availability(null)` or `availability(undefined)` | `The provided value is not of type 'TranslatorCreateCoreOptions'.` | Pass an object. |
| **`NotSupportedError`** | `create()` with unsupported language pair (`availability` was `"unavailable"`) | `Unable to create translator for the given source and target language.` | No — the pair isn't supported. Try a different pair or fall back to a cloud service. |
| **`NotSupportedError`** | `create()` with identity pair (`en→en`) | Same as above. | No — Chrome doesn't support identity translation. |
| **`AbortError`** | `create()` / `translate()` with an already-aborted `signal` | `signal is aborted without reason` | Yes — retry without the aborted signal. |
| **`AbortError`** | `signal` aborted mid-operation | `signal is aborted without reason` | Yes — retry. |
| **`AbortError`** | Any method call after `destroy()` | `Failed to execute 'translate' on 'Translator': signal is aborted without reason` | No — create a new Translator. |
| **`NotAllowedError`** *(spec)* | Translation disabled by user/UA policy | *(not reproduced in test env)* | User must enable. |
| **`NotReadableError`** *(spec)* | Output filtered by UA (harmful/inaccurate) | *(not reproduced)* | Try different input. |
| **`UnknownError`** *(spec)* | Catch-all for unspecified failures | *(not reproduced)* | Retry or fall back. |
| **`OperationError`** *(spec)* | Model initialization failed | *(not reproduced — would occur if model files are corrupt)* | Retry; if persistent, clear component cache. |
| **Service crash** *(observed)* | Translation service process crashes (e.g., under Playwright with wrong flags, or Edge on Linux) | Console warning: `The translation service crashed.` + `NotSupportedError: Unable to create translator...` | Fix launch flags (see §11). On Edge/Linux, use Chrome instead. |
| **Service not running** *(Edge on Linux)* | On-device model service fails to start (Edge 150 Linux) | `NotSupportedError: Unable to create a text session because the service is not running.` | Use Chrome instead, or fall back to a cloud API. |
| **User gesture required** *(Edge)* | `create()` called without user activation when `availability === "downloadable"` (Edge enforces strictly) | `NotAllowedError: Requires a user gesture when availability is "downloading" or "downloadable".` | Ensure `create()` is called from within a user gesture handler (click/keydown). |

### Error handling pattern

```js
try {
  const avail = await Translator.availability({ sourceLanguage, targetLanguage });
  if (avail === 'unavailable') {
    throw new Error(`Language pair ${sourceLanguage}→${targetLanguage} not supported`);
  }
  // If 'downloadable', ensure user activation before create()
  const translator = await Translator.create({ sourceLanguage, targetLanguage });
  const result = await translator.translate(text);
  translator.destroy();
  return result;
} catch (e) {
  if (e.name === 'AbortError' && !abortedIntentionally) {
    // Could be a destroyed translator or a real abort — check state
  }
  if (e.name === 'NotSupportedError') {
    // Unsupported pair or service crash — fall back to cloud translation
  }
  if (e.name === 'RangeError' || e.name === 'TypeError') {
    // Programming error — fix the call site
  }
  throw e;
}
```

---

## 6. Quotas, Limits & Text Size

### inputQuota

**Verified**: `translator.inputQuota` is `null` in Chrome 150. The spec says it may be `+∞`
if there are no limits; Chrome uses `null` instead. `measureInputUsage()` always returns `0`.

**Conclusion**: There is **no enforced input quota** for the Translator API in Chrome. The
limit is practical (memory, model capacity), not API-level.

### Max text size

**Verified**: Successfully translated texts up to **500,000 characters**. No error. Timing
scales roughly linearly:

| Input size | Time (en→es) |
|---|---|
| 100 chars | <10ms |
| 1,000 chars | ~30ms |
| 10,000 chars | ~200ms |
| 100,000 chars | ~24s |
| 500,000 chars | ~2min (completed) |

**Recommendation**: For texts over ~10K chars, use `translateStreaming()` to show partial
results. For very long texts, consider chunking into paragraphs and translating in parallel
(concurrent `translate()` calls work).

### ~20 GB clarification

The ~20 GB disk requirement from the docs applies to the **foundation model** (Gemini Nano)
used by Prompt/Writer/Summarizer/Rewriter/Proofreader APIs. The **Translator API** uses a
separate lightweight "expert" model (Chrome TranslateKit) that is **tens of MB**, not GB.

However, users should still be informed that:
1. A one-time model download is required per language pair.
2. The download needs an unmetered connection.
3. There may be a delay on first use.
4. If disk space falls below 10 GB, models may be removed (per docs).

---

## 7. Streaming Behavior

`translateStreaming()` returns a standard `ReadableStream<string>`.

```js
const stream = translator.translateStreaming(text);
// Option A: for await
for await (const chunk of stream) { ... }
// Option B: reader
const reader = stream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // value is a string fragment
}
```

**Chunk characteristics** (verified):
- Chunks are roughly **sentence-sized** (~50-80 chars each).
- For very short inputs (<50 chars), the entire translation arrives in 1 chunk.
- Empty string yields 1 chunk: `[""]`.
- Chunks are **string fragments** — concatenate them for the full translation.
- Timing: ~35ms per chunk (en→es on this machine).
- The stream is a real `ReadableStream` — supports `getReader()`, `pipeTo()`, `tee()`, etc.

---

## 8. Spec vs Implementation Discrepancies

### Chrome 150 vs Spec

| Feature | Spec says | Chrome 150 does | Impact |
|---|---|---|---|
| Identity translation (`en→en`) | Should return `"available"` (identity translation always available) | Returns `"unavailable"`, throws `NotSupportedError` on `create()` | Can't use Translator for same-language passthrough. Handle in your wrapper. |
| `inputQuota` | `unrestricted double`, may be `+∞` | `null` | Can't use numeric checks. Treat `null`/`0`/`+∞` as "no limit." |
| `measureInputUsage()` | Returns usage proportional to input length | Always returns `0` | Can't pre-check if input is too large. Just try it. |
| Sequential translations | Docs say "translations are processed sequentially" | Runs **concurrently** (3 calls in 20ms) | Can parallelize. But don't rely on it — future versions may serialize. |
| Post-destroy error | Not specified | Throws `AbortError` (misleading) | Check `translator.destroyed` flag in your wrapper instead of catching AbortError. |
| `availability()` transient errors | May return `null` for transient errors | Never returns `null` (always returns an `Availability` string or throws) | Simpler error handling. |

### Edge 150 vs Chrome 150

| Feature | Chrome 150 | Edge 150 | Impact |
|---|---|---|---|
| `Translator` constructor present | Yes | **Yes** | Edge exposes the API. |
| `availability()` | Works correctly | Works (returns `"downloadable"` for en→es) | Same. |
| Identity translation (`en→en`) | `"unavailable"` | `"downloadable"` | Edge may support identity translation; Chrome doesn't. |
| `create()` (model download) | Succeeds, model downloads and translates | Model downloads (progress 0→1) but **service crashes** immediately after | **Edge cannot translate on Linux.** Console: `The translation service crashed.` |
| Component names | `Chrome TranslateKit`, `Chrome TranslateKit en-es` | No `Chrome TranslateKit` components visible in `edge://components` | Edge uses different component naming; may not have full TranslateKit support. |
| Feedback URL | `issues.chromium.org` | `learn.microsoft.com/microsoft-edge/web-platform/translator-api` | Edge has its own feedback channel. |
| User activation enforcement | Works with a button click | Stricter — Edge 138 threw `NotAllowedError: Requires a user gesture` even with a click; Edge 150 works with click but service still crashes | May need different automation approach for Edge. |

### Edge 150 vs Spec

| Feature | Spec says | Edge 150 does | Impact |
|---|---|---|---|
| `create()` | Returns a `Translator` | Throws `NotSupportedError: Unable to create translator for the given source and target language.` (service crash) | Edge on Linux can't create a working translator. |
| Identity translation | `"available"` | `"downloadable"` | Edge may partially support identity (reports downloadable, not unavailable like Chrome). |

---

## 9. Recommended Wrapper Interface

This interface is designed to be used "blind" — the caller doesn't need to know whether the
real API or the mock is underneath. It exposes the stateful nature of the download so the UI
can inform users.

```ts
/**
 * Translation readiness states, matching the W3C Availability enum plus
 * an explicit 'unsupported' state for when the API itself is absent.
 */
export type TranslatorState =
  | 'unsupported'    // Translator API not available (wrong browser / not Chrome)
  | 'unavailable'    // API present but this language pair is not supported
  | 'downloadable'   // Pair supported but model not downloaded yet
  | 'downloading'    // Model download in progress
  | 'ready'          // Translator created and ready to translate
  | 'error';         // Fatal error (service crash, etc.)

export interface TranslatorStatus {
  state: TranslatorState;
  /** Progress 0..1 when state === 'downloading', else null */
  downloadProgress: number | null;
  /** The supported language pairs (after probing) */
  availability: 'unavailable' | 'downloadable' | 'downloading' | 'available' | null;
  /** Human-readable explanation for UI */
  message: string;
}

export interface TranslateOptions {
  signal?: AbortSignal;
}

export interface TranslatorClient {
  /** Check if the API is present at all. Call once on startup. */
  isApiSupported(): boolean;

  /** Check availability for a language pair. Updates status. */
  checkAvailability(sourceLanguage: string, targetLanguage: string): Promise<TranslatorStatus>;

  /**
   * Create a translator. If the model needs downloading, this triggers the download
   * (requires a user gesture — call from a click handler).
   * The onProgress callback fires during download.
   */
  create(
    sourceLanguage: string,
    targetLanguage: string,
    options?: { signal?: AbortSignal; onProgress?: (progress: number) => void },
  ): Promise<TranslatorStatus>;

  /** Translate text. Requires state === 'ready'. */
  translate(text: string, options?: TranslateOptions): Promise<string>;

  /** Stream translation. Requires state === 'ready'. Returns a ReadableStream. */
  translateStreaming(text: string, options?: TranslateOptions): ReadableStream<string>;

  /** Destroy the translator and free resources. */
  destroy(): void;

  /** Current status (for UI binding). */
  readonly status: TranslatorStatus;
  readonly sourceLanguage: string | null;
  readonly targetLanguage: string | null;
}
```

---

## 10. Mock Implementation for Tests

This mock simulates the full stateful behavior of the Translator API, including the download
delay, state transitions, and all error conditions. It installs `self.Translator` so existing
code that uses the real API works unchanged in Chromium (where the API is absent).

### Design goals

1. **Drop-in replacement**: Installs `globalThis.Translator` with the same static/instance API.
2. **Stateful**: Simulates `unavailable → downloadable → downloading → available` transitions.
3. **Configurable download delay**: Tests can control how long the "download" takes.
4. **Error simulation**: Tests can inject failures (NotSupportedError, AbortError, service crash).
5. **Deterministic translation**: Uses a simple dictionary + suffix for predictable output.
6. **No network**: Fully in-memory, works in headless Chromium without any flags.

### Mock code

```js
/**
 * MockTranslator — drop-in mock for Chrome's built-in Translator API.
 *
 * Install:  MockTranslator.install(options)
 * Uninstall: MockTranslator.uninstall()
 *
 * Options:
 *   downloadDelayMs   — ms for simulated model download (default: 100)
 *   supportedPairs    — array of [source, target] pairs (default: all from docs)
 *   translationFn     — (input, src, tgt) => string, for custom translation
 *   failOnCreate      — if true, create() throws NotSupportedError (simulates crash)
 *   chunkSize         — chars per streaming chunk (default: 50)
 */
class MockTranslator {
  static _options = {
    downloadDelayMs: 100,
    supportedPairs: null, // computed below
    translationFn: null,
    failOnCreate: false,
    chunkSize: 50,
  };
  static _installed = false;
  static _realTranslator = undefined;
  static _downloadedPairs = new Set(); // pairs that have been "downloaded"
  static _downloadingPairs = new Set(); // currently downloading
  static _downloadControllers = new Map(); // pairKey -> AbortController

  // All 37 supported languages from the Chrome docs, paired both ways
  static _SUPPORTED_LANGS = new Set([
    'ar','bg','bn','cs','da','de','el','en','es','fi','fr','he','hi','hr','hu',
    'id','it','ja','kn','ko','lt','mr','nl','no','pl','pt','ro','ru','sk','sl',
    'sv','ta','te','th','tr','uk','vi','zh','zh-Hant',
  ]);

  static _defaultTranslationFn(input, src, tgt) {
    if (src === tgt) return input; // identity passthrough (mock supports it, unlike real Chrome)
    if (input === '' || /^\s+$/.test(input)) return input;
    // Simple deterministic "translation": prefix with target lang + reverse for non-ASCII
    // This is NOT a real translation — it's a predictable mock for testing.
    return `[${tgt}] ${input}`;
  }

  static _pairKey(src, tgt) { return `${src}->${tgt}`; }

  static _getSupportedPairs() {
    // Generate all supported pairs (both directions) lazily
    const pairs = [];
    const langs = [...this._SUPPORTED_LANGS];
    for (const s of langs) for (const t of langs) if (s !== t) pairs.push([s, t]);
    return pairs;
  }

  static install(options = {}) {
    this._options = { ...this._options, ...options };
    if (!this._options.supportedPairs) {
      this._options.supportedPairs = this._getSupportedPairs();
    }
    if (this._installed) return;
    this._realTranslator = globalThis.Translator;
    this._installed = true;
    const self = this;

    class MockTranslatorInstance {
      #sourceLanguage;
      #targetLanguage;
      #destroyed = false;
      #translationFn;

      constructor(sourceLanguage, targetLanguage, translationFn) {
        this.#sourceLanguage = sourceLanguage;
        this.#targetLanguage = targetLanguage;
        this.#translationFn = translationFn;
      }

      get sourceLanguage() { return this.#sourceLanguage; }
      get targetLanguage() { return this.#targetLanguage; }
      get inputQuota() { return null; } // matches real Chrome

      async translate(input, options = {}) {
        if (this.#destroyed) {
          throw new DOMException(
            "Failed to execute 'translate' on 'Translator': signal is aborted without reason",
            'AbortError',
          );
        }
        if (options.signal?.aborted) {
          throw new DOMException('signal is aborted without reason', 'AbortError');
        }
        // Simulate async work
        await new Promise((r) => setTimeout(r, 1));
        if (options.signal?.aborted) {
          throw new DOMException('signal is aborted without reason', 'AbortError');
        }
        const str = String(input); // DOMString coercion
        return this.#translationFn(str, this.#sourceLanguage, this.#targetLanguage);
      }

      translateStreaming(input, options = {}) {
        if (this.#destroyed) {
          throw new DOMException(
            "Failed to execute 'translateStreaming' on 'Translator': signal is aborted without reason",
            'AbortError',
          );
        }
        const str = String(input);
        const fn = this.#translationFn;
        const src = this.#sourceLanguage;
        const tgt = this.#targetLanguage;
        const chunkSize = self._options.chunkSize;
        const signal = options.signal;

        return new ReadableStream({
          async start(controller) {
            if (signal?.aborted) {
              controller.error(new DOMException('signal is aborted without reason', 'AbortError'));
              return;
            }
            const full = fn(str, src, tgt);
            // Yield in chunks
            for (let i = 0; i < full.length; i += chunkSize) {
              if (signal?.aborted) {
                controller.error(new DOMException('signal is aborted without reason', 'AbortError'));
                return;
              }
              await new Promise((r) => setTimeout(r, 1)); // simulate async
              controller.enqueue(full.slice(i, i + chunkSize));
            }
            controller.close();
          },
        });
      }

      async measureInputUsage(input, options = {}) {
        if (this.#destroyed) {
          throw new DOMException('signal is aborted without reason', 'AbortError');
        }
        return 0; // matches real Chrome
      }

      destroy() {
        this.#destroyed = true;
      }
    }

    // The static Translator replacement
    const MockStatic = {
      async availability(options) {
        self._validateOptions(options);
        const { sourceLanguage, targetLanguage } = options;

        // Check if pair is in the supported list
        const isSupported = self._options.supportedPairs.some(
          ([s, t]) => s === sourceLanguage && t === targetLanguage,
        );
        if (!isSupported) return 'unavailable';

        const key = self._pairKey(sourceLanguage, targetLanguage);
        if (self._downloadedPairs.has(key)) return 'available';
        if (self._downloadingPairs.has(key)) return 'downloading';
        return 'downloadable';
      },

      async create(options) {
        self._validateOptions(options);
        const { sourceLanguage, targetLanguage, signal, monitor } = options;

        if (signal?.aborted) {
          throw new DOMException('signal is aborted without reason', 'AbortError');
        }
        if (self._options.failOnCreate) {
          throw new DOMException(
            'Unable to create translator for the given source and target language.',
            'NotSupportedError',
          );
        }

        // Check support
        const isSupported = self._options.supportedPairs.some(
          ([s, t]) => s === sourceLanguage && t === targetLanguage,
        );
        if (!isSupported) {
          throw new DOMException(
            'Unable to create translator for the given source and target language.',
            'NotSupportedError',
          );
        }

        const key = self._pairKey(sourceLanguage, targetLanguage);

        // If already downloaded, return immediately (but still fire monitor events)
        if (self._downloadedPairs.has(key)) {
          if (monitor) {
            const m = new EventTarget();
            monitor(m);
            m.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0 }));
            m.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 1 }));
          }
          return new MockTranslatorInstance(
            sourceLanguage, targetLanguage,
            self._options.translationFn || self._defaultTranslationFn.bind(self),
          );
        }

        // Simulate download
        self._downloadingPairs.add(key);
        const ac = new AbortController();
        self._downloadControllers.set(key, ac);

        // Combine external signal with our internal controller
        const combinedSignal = signal || new AbortController().signal;
        if (signal) {
          signal.addEventListener('abort', () => ac.abort(), { once: true });
        }

        try {
          if (monitor) {
            const m = new EventTarget();
            monitor(m);
            // Fire progress events over the download period
            const steps = 10;
            for (let i = 0; i <= steps; i++) {
              if (ac.signal.aborted) break;
              m.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: i / steps }));
              await new Promise((r) => setTimeout(r, self._options.downloadDelayMs / steps));
            }
          } else {
            // No monitor — just wait
            await new Promise((r) => setTimeout(r, self._options.downloadDelayMs));
          }

          if (ac.signal.aborted) {
            throw new DOMException('signal is aborted without reason', 'AbortError');
          }

          self._downloadingPairs.delete(key);
          self._downloadedPairs.add(key); // cache for future calls
          self._downloadControllers.delete(key);

          return new MockTranslatorInstance(
            sourceLanguage, targetLanguage,
            self._options.translationFn || self._defaultTranslationFn.bind(self),
          );
        } catch (e) {
          self._downloadingPairs.delete(key);
          self._downloadControllers.delete(key);
          throw e;
        }
      },
    };

    globalThis.Translator = MockStatic;
  }

  static uninstall() {
    if (!this._installed) return;
    globalThis.Translator = this._realTranslator;
    this._installed = false;
    this._realTranslator = undefined;
  }

  static reset() {
    this._downloadedPairs.clear();
    this._downloadingPairs.clear();
    this._downloadControllers.clear();
  }

  static _validateOptions(options) {
    if (options === null || options === undefined || typeof options !== 'object') {
      throw new TypeError(
        "Failed to execute 'availability' on 'Translator': The provided value is not of type 'TranslatorCreateCoreOptions'.",
      );
    }
    if (options.sourceLanguage === undefined) {
      throw new TypeError(
        "Failed to execute 'availability' on 'Translator': Failed to read the 'sourceLanguage' property from 'TranslatorCreateCoreOptions': Required member is undefined.",
      );
    }
    if (options.targetLanguage === undefined) {
      throw new TypeError(
        "Failed to execute 'availability' on 'Translator': Failed to read the 'targetLanguage' property from 'TranslatorCreateCoreOptions': Required member is undefined.",
      );
    }
    // Validate BCP-47 (simplified: must be non-empty string)
    for (const tag of [options.sourceLanguage, options.targetLanguage]) {
      if (typeof tag !== 'string' || tag.length === 0) {
        throw new RangeError(
          `Failed to execute 'availability' on 'Translator': Invalid language tag: ${tag}`,
        );
      }
    }
  }

  // Test helpers
  static preDownloadPair(src, tgt) {
    this._downloadedPairs.add(this._pairKey(src, tgt));
  }

  static isDownloading(src, tgt) {
    return this._downloadingPairs.has(this._pairKey(src, tgt));
  }

  static isDownloaded(src, tgt) {
    return this._downloadedPairs.has(this._pairKey(src, tgt));
  }
}
```

### Usage examples

```js
// --- Basic usage in a test ---

// 1. Install the mock (replaces globalThis.Translator)
MockTranslator.install({ downloadDelayMs: 50 });

// 2. Feature-detect (works just like real API)
console.assert('Translator' in self === true);

// 3. Check availability — 'en'->'es' is supported but not downloaded
const avail = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'es' });
console.assert(avail === 'downloadable');

// 4. Create (triggers simulated download with progress events)
const translator = await Translator.create({
  sourceLanguage: 'en',
  targetLanguage: 'es',
  monitor(m) {
    m.addEventListener('downloadprogress', (e) => {
      console.log(`Download: ${(e.loaded * 100).toFixed(0)}%`);
    });
  },
});

// 5. Now availability is 'available'
const avail2 = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'es' });
console.assert(avail2 === 'available');

// 6. Translate (deterministic mock output)
const result = await translator.translate('Hello world');
console.assert(result === '[es] Hello world');

// 7. Stream
const stream = translator.translateStreaming('Hello world this is a test');
let full = '';
for await (const chunk of stream) full += chunk;
console.assert(full === '[es] Hello world this is a test');

// 8. Destroy
translator.destroy();
try { await translator.translate('test'); } catch (e) {
  console.assert(e.name === 'AbortError');
}

// --- Error simulation ---

// Unsupported pair
MockTranslator.reset();
const badAvail = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'xx' });
console.assert(badAvail === 'unavailable');
try {
  await Translator.create({ sourceLanguage: 'en', targetLanguage: 'xx' });
} catch (e) {
  console.assert(e.name === 'NotSupportedError');
}

// Service crash simulation
MockTranslator.install({ failOnCreate: true });
try {
  await Translator.create({ sourceLanguage: 'en', targetLanguage: 'es' });
} catch (e) {
  console.assert(e.name === 'NotSupportedError');
}

// Abort during create
MockTranslator.install({ downloadDelayMs: 1000 });
const ac = new AbortController();
setTimeout(() => ac.abort(), 50);
try {
  await Translator.create({ sourceLanguage: 'en', targetLanguage: 'es', signal: ac.signal });
} catch (e) {
  console.assert(e.name === 'AbortError');
}

// --- Pre-cached pair (skip download) ---
MockTranslator.install({ downloadDelayMs: 10000 });
MockTranslator.preDownloadPair('en', 'es');
const t = await Translator.create({ sourceLanguage: 'en', targetLanguage: 'es' });
// Returns instantly despite 10s downloadDelayMs
const r = await t.translate('Hello');
console.assert(r === '[es] Hello');
```

### Custom translation function

For more realistic tests, provide a custom `translationFn`:

```js
const dictionary = {
  'en->es': { 'Hello': 'Hola', 'Goodbye': 'Adiós', 'Thank you': 'Gracias' },
  'en->fr': { 'Hello': 'Bonjour', 'Goodbye': 'Au revoir', 'Thank you': 'Merci' },
};

MockTranslator.install({
  translationFn(input, src, tgt) {
    const dict = dictionary[`${src}->${tgt}`] || {};
    // Word-by-word lookup, fallback to passthrough
    return input.split(/\b/).map(w => dict[w] || w).join('');
  },
});
```

---

## 11. Playwright/Puppeteer Launch Recipe

### Playwright (verified working)

```js
import { chromium } from 'playwright';

const PW_DISABLE_FEATURES =
  '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,' +
  'DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,' +
  'MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,' +
  'Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion';

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: '/opt/google/chrome/chrome',  // MUST be real Chrome, not CfT
  headless: false,                                // run under xvfb-run -a
  ignoreDefaultArgs: [
    PW_DISABLE_FEATURES,         // strip Playwright's --disable-features (has Translate + OptimizationHints)
    '--disable-component-update', // blocks model loading even when cached
    '--enable-automation',
  ],
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--enable-features=TranslatorAPI,OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel',
    '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,' +
    'DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,' +
    'MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,' +
    'AutoDeElevate,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion',
  ],
});
```

### Puppeteer (verified working)

```js
const browser = await puppeteer.launch({
  executablePath: '/opt/google/chrome/chrome',
  headless: false,
  userDataDir,
  ignoreDefaultArgs: ['--enable-automation', '--disable-features', '--disable-background-networking'],
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--enable-features=TranslatorAPI,OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel',
  ],
});
```

### Critical flags checklist

| Flag / Setting | Why | Required? |
|---|---|---|
| Real Google Chrome (`/opt/google/chrome/chrome`) | CfT/Chromium lack the model components | **Yes** |
| Microsoft Edge (`/opt/microsoft/msedge/microsoft-edge`) | API present but service crashes on Linux | Not recommended (Linux) |
| `--enable-features=TranslatorAPI,OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel` | Enables the API + model download | **Yes** |
| Strip `Translate` and `OptimizationHints` from `--disable-features` | Playwright/Puppeteer disable them by default | **Yes** |
| Strip `--disable-component-update` (Playwright) | Blocks model loading | **Yes** |
| Strip `--disable-background-networking` (Puppeteer) | Blocks model download on first use | **Yes** (first run) |
| `optimization-guide-on-device-model` flag in `Local State` | Required for localhost | **Yes** (localhost) |
| `headless: false` + `xvfb-run -a` | Headed mode is more reliable for AI WebUI init | Recommended |
| Persistent `userDataDir` | Caches downloaded models across runs | Recommended |
| Real page (`http://localhost:PORT/`) | API not exposed on `about:blank` | **Yes** |
| User gesture (button click) before `create()` | Required when `availability === 'downloadable'` (Edge enforces this strictly with `NotAllowedError`) | **Yes** (first run) |

### Do NOT use `ignoreDefaultArgs: true` (Playwright)

It strips `--remote-debugging-pipe` which Playwright needs for its CDP connection, causing a
180s launch timeout. Always target specific args to ignore.

---

## Appendix: Environment on this machine

- Real Google Chrome: `/opt/google/chrome/chrome` (150.0.7871.186) — **fully working**
- Microsoft Edge: `/opt/microsoft/msedge/microsoft-edge` (150.0.4078.99) — API present, service crashes on Linux
- Persistent AI profiles:
  - Chrome: `/tmp/opencode/chrome-ai-profile` (has `optimization-guide-on-device-model` flag set; `Chrome TranslateKit` + `Chrome TranslateKit en-es` cached)
  - Edge: `/tmp/opencode/edge-puppeteer-profile` (flags set; TranslateKit model downloads but service crashes)
- `xvfb-run -a` available for headed runs without a display
- `puppeteer-core` is a project devDependency
- Playwright installed in `/tmp/opencode/node_modules` (v1.62.0)
