# Summarizer API — Complete Developer Reference

Empirically verified on **Google Chrome 150.0.7871.186** and **Microsoft Edge
150.0.4078.99** (Linux, 2026-07-27) using Playwright/Puppeteer + `xvfb-run`. All code samples,
error messages, timings, and quota values were captured from real probe runs against the live API.

- Spec: <https://webmachinelearning.github.io/writing-assistance-apis/#summarizer>
- Chrome docs: <https://developer.chrome.com/docs/ai/summarizer-api>
- Edge docs: <https://learn.microsoft.com/microsoft-edge/web-platform/writing-assistance-apis>
- MDN: <https://developer.mozilla.org/en-US/docs/Web/API/Summarizer>

---

## Table of Contents

1. [Prerequisites & Browser Setup](#1-prerequisites--browser-setup)
2. [API Surface (IDL)](#2-api-surface-idl)
3. [State Machine: availability() → create() → summarize()](#3-state-machine-availability--create--summarize)
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

| Build | `Summarizer` exposed? | Works end-to-end? | Notes |
|---|---|---|---|
| **Google Chrome stable ≥138** (desktop) | **Yes** | **Yes** | Fully verified. Summaries generated successfully. |
| **Microsoft Edge stable ≥138** (desktop) | **Yes** | **No** (Linux) | API present, but on-device model service doesn't start on Linux. `availability()` returns `"unavailable"`. May work on Windows/macOS. |
| Chrome for Testing (CfT) | No | No | Missing Optimization Guide / Gemini Nano components. |
| Chromium | No | No | Same — proprietary model components stripped. |
| Playwright's bundled Chromium | No | No | CfT variant. |
| Chrome/Edge on Android/iOS | No | No | Desktop only. |

### CRITICAL: Foundation model requirements (unlike Translator API)

The Summarizer API uses **Gemini Nano**, a foundation language model. This is fundamentally
different from the Translator API (which uses lightweight expert models). The requirements:

- **OS**: Windows 10/11, macOS 13+, Linux, ChromeOS (Chromebook Plus only).
- **Storage**: At least **22 GB** free space on the volume containing your Chrome profile.
- **GPU or CPU**:
  - GPU: strictly more than **4 GB VRAM**.
  - CPU: **16 GB RAM** + **4+ cores**.
- **Network**: Unmetered, for initial model download (~1.8 GB, takes ~3 min on fast connection).
- If available storage falls below 10 GB after download, the model is **automatically removed**.

**Verified on this machine**: 6 CPU cores, 31 GB RAM, 155 GB disk, NVIDIA RTX 2080 Ti — all
requirements met. Model downloaded in ~200 seconds.

### Required flags (for localhost/local prototyping)

Two flags must be enabled in `chrome://flags`:

1. `chrome://flags/#optimization-guide-on-device-model` → **Enabled**
2. `chrome://flags/#prompt-api-for-gemini-nano` → **Enabled** (or **Enabled multilingual**)

To set programmatically, write to the profile's `Local State` JSON:

```js
const ls = JSON.parse(fs.readFileSync(`${userDataDir}/Local State`, 'utf8'));
ls.browser = ls.browser ?? {};
ls.browser.enabled_labs_experiments = [
  'optimization-guide-on-device-model@1',
  'prompt-api-for-gemini-nano@1',
];
fs.writeFileSync(`${userDataDir}/Local State`, JSON.stringify(ls, null, 2));
```

### Model download (first use)

The Gemini Nano foundation model downloads as a Chrome component on first use. Unlike the
Translator API (which downloads per-language-pair models of tens of MB each), the Summarizer
downloads a **single large model** (~1.8 GB) that is shared across all writing assistance APIs
(Summarizer, Writer, Rewriter, Proofreader, Prompt API).

The download is triggered when `availability()` or `create()` is first called. The
`availability()` method returns `"downloading"` while the download is in progress, then
`"available"` when complete.

### Supported languages

From Chrome 149: **`en`, `es`, `ja`, `de`, `fr`** for input, output, and context.

Unsupported languages cause `availability()` to return `"unavailable"` and `create()` to throw
`NotSupportedError`.

---

## 2. API Surface (IDL)

From the spec, cross-checked against the live Chrome prototype:

```webidl
[Exposed=Window, SecureContext]
interface Summarizer {
  // Static
  static Promise<Summarizer> create(optional SummarizerCreateOptions options = {});
  static Promise<Availability> availability(optional SummarizerCreateCoreOptions options = {});

  // Instance methods
  Promise<DOMString> summarize(DOMString input, optional SummarizerSummarizeOptions options = {});
  ReadableStream summarizeStreaming(DOMString input, optional SummarizerSummarizeOptions options = {});
  Promise<double> measureInputUsage(DOMString input, optional SummarizerSummarizeOptions options = {});
  undefined destroy();  // from DestroyableModel mixin

  // Instance properties (readonly)
  readonly attribute DOMString sharedContext;
  readonly attribute SummarizerType type;          // "tldr" | "teaser" | "key-points" | "headline"
  readonly attribute SummarizerFormat format;      // "plain-text" | "markdown"
  readonly attribute SummarizerLength length;      // "short" | "medium" | "long"
  readonly attribute PerformancePreference preference; // EXPERIMENTAL — not exposed by default
  readonly attribute FrozenArray<DOMString>? expectedInputLanguages;
  readonly attribute FrozenArray<DOMString>? expectedContextLanguages;
  readonly attribute DOMString? outputLanguage;
  readonly attribute unrestricted double inputQuota;
};

dictionary SummarizerCreateCoreOptions {
  SummarizerType type = "key-points";
  SummarizerFormat format = "markdown";
  SummarizerLength length = "short";
  PerformancePreference preference = "auto";  // EXPERIMENTAL
  sequence<DOMString> expectedInputLanguages;
  sequence<DOMString> expectedContextLanguages;
  DOMString outputLanguage;
};

dictionary SummarizerCreateOptions : SummarizerCreateCoreOptions {
  AbortSignal signal;
  CreateMonitorCallback monitor;
  DOMString sharedContext;
};

dictionary SummarizerSummarizeOptions {
  AbortSignal signal;
  DOMString context;  // per-call context (separate from sharedContext)
};

enum SummarizerType { "tldr", "teaser", "key-points", "headline" };
enum SummarizerFormat { "plain-text", "markdown" };
enum SummarizerLength { "short", "medium", "long" };
enum PerformancePreference { "auto", "speed", "capability" };
enum Availability { "unavailable", "downloadable", "downloading", "available" };
```

**Verified prototype members** (Chrome 150):

```
Summarizer.prototype:
  sharedContext, type, format, length,                    // getters
  expectedInputLanguages, expectedContextLanguages,       // getters
  outputLanguage, inputQuota,                             // getters
  destroy, measureInputUsage, summarize, summarizeStreaming,  // methods
  constructor

Summarizer (static):
  availability, create
```

**Note**: `preference` is **NOT** on the prototype in regular web contexts. The spec marks it
as `// **EXPERIMENTAL**: Only available in extension and experimental contexts.` Verified:
`'preference' in summarizer` → `false`.

### Key differences from Translator API

| Aspect | Translator | Summarizer |
|---|---|---|
| Model type | Expert (per language pair, ~tens of MB) | Foundation (Gemini Nano, ~1.8 GB) |
| `create()` options | `sourceLanguage` + `targetLanguage` **required** | All options **optional** (have defaults) |
| `inputQuota` | `null` (no limit) | `9216` (real, enforced) |
| `measureInputUsage()` | Always returns `0` | Returns real token count |
| Quota exceeded | Never | `QuotaExceededError` at ~9K tokens (~40K chars) |
| Supported languages | 37+ | 5 (en, es, ja, de, fr) |
| Disk requirement | ~tens of MB | ~22 GB |
| Per-call options | `{ signal }` | `{ signal, context }` (extra `context` param) |
| `preference` property | N/A | Exists in spec but experimental/not exposed |
| `sharedContext` default | N/A | `""` (empty string), not `null` |
| Edge support (Linux) | API present, model downloads, service crashes | API present, service doesn't start (`"unavailable"`) |

### Secure context

HTTPS or `localhost`. Not exposed on `about:blank`, `file://`, or non-localhost HTTP.

### Permissions policy

Feature name: `"summarizer"`. Default allowlist: `['self']`. Cross-origin iframes need
`allow="summarizer"`. **Not available in Web Workers.**

---

## 3. State Machine: availability() → create() → summarize()

```
                    ┌─────────────────────────────────────────────────┐
                    │            Summarizer.availability()             │
                    └─────────────────────────────────────────────────┘
                                     │
         ┌──────────────┬───────────┼───────────┬──────────────┐
         ▼              ▼           ▼           ▼              ▼
    "unavailable"  "downloadable" "downloading" "available"  (throws)
         │              │           │           │              │
         │              │           │           │              ├─ TypeError (invalid enum value)
         │              │           │           │              │
    Unsupported    Model not      Download    Ready!          │
    language or    downloaded     in progress  Call create()  │
    hardware.      yet. Needs     (auto-       → instant.     │
                   user gesture   triggered by                 │
                   + download     availability())              │
                   via create()                                 │
         │              │                       │
         ▼              ▼                       ▼
    create()       create()                create()
    throws         downloads model,         returns Summarizer
    NotSupported   fires monitor            immediately
    Error          downloadprogress,
                   then returns
                   Summarizer
                    │                       │
                    └───────┬───────────────┘
                            ▼
                     Summarizer instance
                     (type, format, length, sharedContext,
                      expectedInputLanguages, outputLanguage,
                      inputQuota=9216)
                            │
                    ┌───────┼───────────┐
                    ▼       ▼           ▼
               summarize()  summarizeStreaming()  measureInputUsage()
                    │       │           │
                    ▼       ▼           ▼
               Promise<str> ReadableStream  Promise<double>
                    │       of string chunks  (real token count)
                    │       │
                    └───────┤
                            ▼
                     destroy()
                     → instance dead
                     → all future calls throw AbortError
                     → all properties still readable
```

---

## 4. Detailed Method Reference (empirically verified)

### 4.1 `Summarizer.availability(options?)` — static async

Checks whether the model is available for a given configuration.

**Parameters** (all optional, with defaults):
```ts
{
  type?: SummarizerType,           // default "key-points"
  format?: SummarizerFormat,       // default "markdown"
  length?: SummarizerLength,       // default "short"
  expectedInputLanguages?: string[],
  expectedContextLanguages?: string[],
  outputLanguage?: string,
}
```

**Returns**: `Promise<Availability>` — `"unavailable" | "downloadable" | "downloading" | "available"`.

**Verified results** (Chrome 150, during model download):

| Configuration | Result | Notes |
|---|---|---|
| No options | `"downloading"` | Warns: "No output language was specified". |
| `{expectedInputLanguages:['en'], outputLanguage:'en'}` | `"downloading"` | |
| `{expectedInputLanguages:['ja'], outputLanguage:'ja'}` | `"downloading"` | |
| `{expectedInputLanguages:['es'], outputLanguage:'es'}` | `"downloading"` | |
| `{expectedInputLanguages:['de'], outputLanguage:'de'}` | `"downloading"` | |
| `{expectedInputLanguages:['fr'], outputLanguage:'fr'}` | `"downloading"` | |
| `{expectedInputLanguages:['zh'], outputLanguage:'zh'}` | `"unavailable"` | Warns: "The requested language options are not supported." |
| `{expectedInputLanguages:['xx'], outputLanguage:'xx'}` | `"unavailable"` | |
| `{type:'tldr', ...}` | `"downloading"` | All 4 types supported. |
| `{type:'teaser', ...}` | `"downloading"` | |
| `{type:'key-points', ...}` | `"downloading"` | |
| `{type:'headline', ...}` | `"downloading"` | |
| `{format:'plain-text', ...}` | `"downloading"` | Both formats supported. |
| `{format:'markdown', ...}` | `"downloading"` | |
| `{length:'short', ...}` | `"downloading"` | All 3 lengths supported. |
| `{length:'medium', ...}` | `"downloading"` | |
| `{length:'long', ...}` | `"downloading"` | |
| `{type:'invalid'}` | **throws `TypeError`** | Invalid enum value. |
| `{format:'invalid'}` | **throws `TypeError`** | |
| `{length:'invalid'}` | **throws `TypeError`** | |

After model download completes, all supported configurations return `"available"`.

**Important**: If no `outputLanguage` is specified, Chrome logs a console warning:
> "No output language was specified in a Summarizer API request. An output language should be
> specified to ensure optimal output quality and properly attest to output safety. Please
> specify a supported output language code: [de, en, es, fr, ja]"

Always specify `outputLanguage` in practice.

### 4.2 `Summarizer.create(options?)` — static async

Creates a `Summarizer` instance. Downloads the model if needed (first use only).

**Parameters** (all optional):
```ts
{
  type?: SummarizerType,           // default "key-points"
  format?: SummarizerFormat,       // default "markdown"
  length?: SummarizerLength,       // default "short"
  sharedContext?: string,          // default "" (empty string)
  expectedInputLanguages?: string[],
  expectedContextLanguages?: string[],
  outputLanguage?: string,
  signal?: AbortSignal,
  monitor?: (m: CreateMonitor) => void,
}
```

**Returns**: `Promise<Summarizer>`

**Default values** (verified when called with `{expectedInputLanguages:['en'], outputLanguage:'en'}`):

| Property | Default value |
|---|---|
| `type` | `"key-points"` |
| `format` | `"markdown"` |
| `length` | `"short"` |
| `sharedContext` | `""` (empty string, NOT null) |
| `expectedInputLanguages` | `["en"]` (if specified) |
| `expectedContextLanguages` | `null` (if not specified) |
| `outputLanguage` | `"en"` (if specified) |
| `inputQuota` | `9216` |
| `preference` | **not present** (experimental) |

**Monitor behavior**: Same as Translator — the `monitor` callback receives a `CreateMonitor`
object. Attach a `downloadprogress` event listener. `e.loaded` is a float 0→1.

**Verified create scenarios**:

| Scenario | Result |
|---|---|
| Default (with languages) | Returns Summarizer instantly (model cached). |
| With all options | Returns Summarizer with all props set correctly. |
| `type: 'invalid'` | Throws `TypeError: The provided value 'invalid' is not a valid enum value of type SummarizerType.` |
| `expectedInputLanguages: ['xx']` | Throws `NotSupportedError: The requested language options are not supported.` |
| Already-aborted `signal` | Throws `AbortError: signal is aborted without reason`. |

**User activation**: When `availability()` returns `"downloadable"`, `create()` requires
`navigator.userActivation.isActive`. When `"available"`, no user activation needed.

### 4.3 `summarizer.summarize(input, options?)` — async

Generates a summary string.

**Parameters**:
- `input: string` — text to summarize (DOMString coercion applies).
- `options?: { context?: string, signal?: AbortSignal }` — per-call context and abort signal.

**Returns**: `Promise<string>`

**Verified summarize scenarios**:

| Input | Options | Result | Notes |
|---|---|---|---|
| ~1K char article | — | 3 bullet points (548 chars, 9.7s) | Default type=key-points, length=short. |
| ~1K char article | `{context:'For a tech-savvy audience'}` | 3 bullet points (different content) | Context influences output. |
| `""` | — | `""` | Empty in → empty out. |
| `"   \n\t  "` | — | `""` | Whitespace → empty. |
| `"Hello world."` | — | 2 bullet points | Very short input still summarized. |
| `42` | — | Summary about the number 42 | DOMString coercion → `"42"` → summarized. |
| `null` | — | `""` | Coerced to `"null"` → empty summary. |
| `undefined` | — | "No text was provided..." | Coerced to `"undefined"`. |
| ~45K chars | — | **`QuotaExceededError`** | Usage 9937 > quota 9216. |
| Pre-aborted `signal` | — | Throws `AbortError` | |
| Mid-summarize abort | — | Throws `AbortError` | |

**Concurrent calls**: Works — 3 simultaneous `summarize()` calls completed in 1488ms.

**Timing**: ~5-10s per summary for ~1K char input (significantly slower than Translator).
The foundation model is larger and more compute-intensive.

### 4.4 `summarizer.summarizeStreaming(input, options?)`

Streaming variant. Returns a `ReadableStream<string>`.

**Returns**: `ReadableStream` (verified: `stream instanceof ReadableStream === true`).

**Chunk behavior** (verified):

| Input | Chunks | Output length | Time |
|---|---|---|---|
| ~1K char article | 105 | 482 chars | 10.7s |
| `""` (empty) | 0 | 0 | instant |

**Key difference from Translator streaming**: Chunks are very small (1-13 chars each, like
token-by-token generation) vs Translator's sentence-sized chunks (~50-80 chars). This is
because the Summarizer uses an LLM that generates token-by-token, while the Translator uses
a specialized model that produces sentence-sized outputs.

### 4.5 `summarizer.measureInputUsage(input, options?)` — async

Reports how much input quota a given text would consume.

**Returns**: `Promise<double>` — a real token count (unlike Translator which always returns 0).

**Verified**:

| Input | Usage (tokens) | Notes |
|---|---|---|
| `"Hello world"` | 560 | Short text. |
| ~1K char article | 788 | |
| `'A'.repeat(10000)` | 1183 | |
| 100 chars (repeated sentence) | 580 | |
| 903 chars | 748 | |
| 4515 chars | 1504 | |
| 8987 chars | 2440 | |
| 44806 chars | 9937 | **Exceeds quota of 9216!** |

**The quota is real and enforced.** If `measureInputUsage(input) > inputQuota`, calling
`summarize(input)` throws `QuotaExceededError: The input is too large.`

### 4.6 `summarizer.destroy()` — sync

Releases resources. **Synchronous** (returns `undefined`).

**Post-destroy behavior** (verified — identical to Translator):

| Call after `destroy()` | Result |
|---|---|
| `summarize()` | Throws `AbortError` |
| `summarizeStreaming()` | Throws `AbortError` |
| `measureInputUsage()` | Throws `AbortError` |
| `destroy()` again | No-op (succeeds silently) |
| `summarizer.type` | Still returns `"key-points"` |
| `summarizer.format` | Still returns `"markdown"` |
| `summarizer.length` | Still returns `"short"` |
| `summarizer.inputQuota` | Still returns `9216` |
| `summarizer.sharedContext` | Still returns `""` |

### 4.7 Instance properties (verified)

| Property | Type | Default | After destroy? |
|---|---|---|---|
| `type` | `SummarizerType` | `"key-points"` | Still readable |
| `format` | `SummarizerFormat` | `"markdown"` | Still readable |
| `length` | `SummarizerLength` | `"short"` | Still readable |
| `sharedContext` | `string` | `""` (empty string) | Still readable |
| `expectedInputLanguages` | `FrozenArray<string> \| null` | `null` or specified | Still readable |
| `expectedContextLanguages` | `FrozenArray<string> \| null` | `null` | Still readable |
| `outputLanguage` | `string \| null` | `null` or specified | Still readable |
| `inputQuota` | `number` | `9216` | Still readable |
| `preference` | — | **not present** | N/A (experimental) |

### 4.8 Summary types, lengths, and formats (verified output examples)

Using a ~1K char article about AI history as input:

#### Types (all with length=short, format=markdown)

| Type | Output | Format |
|---|---|---|
| `tldr` | One paragraph summarizing the text. | Sentence |
| `teaser` | One sentence designed to draw reader in. | Sentence |
| `key-points` | 3 bullet points (`* ...`). | Markdown list |
| `headline` | One headline sentence. | Sentence |

#### Lengths (all with type=key-points)

| Length | Bullet points | Matches spec? |
|---|---|---|
| `short` | 3 | Yes (spec: ≤3) |
| `medium` | 5 | Yes (spec: ≤5) |
| `long` | 7 | Yes (spec: ≤7) |

#### Formats (all with type=key-points)

| Format | Output |
|---|---|
| `plain-text` | Still produces `*` bullets (Chrome implementation detail) |
| `markdown` | `*` bullets with markdown formatting |

**Note**: In practice, `plain-text` and `markdown` produce very similar output for key-points
type. The difference is more noticeable for `tldr` type where markdown may use `*italic*` etc.

---

## 5. Error Conditions (complete table)

| Error type | When | Message (verbatim) | Recoverable? |
|---|---|---|---|
| **`TypeError`** | Invalid enum value for `type`, `format`, or `length` | `Failed to execute 'availability' on 'Summarizer': Failed to read the 'type' property from 'SummarizerCreateCoreOptions': The provided value 'invalid' is not a valid enum value of type SummarizerType.` | Fix the value. |
| **`NotSupportedError`** | `create()` with unsupported language | `The requested language options are not supported.` | Use supported languages (en, es, ja, de, fr). |
| **`AbortError`** | `create()`/`summarize()` with already-aborted `signal` | `signal is aborted without reason` | Retry without the aborted signal. |
| **`AbortError`** | `signal` aborted mid-operation | `signal is aborted without reason` | Retry. |
| **`AbortError`** | Any method call after `destroy()` | `Failed to execute 'summarize' on 'Summarizer': signal is aborted without reason` | Create a new Summarizer. |
| **`QuotaExceededError`** | Input exceeds `inputQuota` (9216 tokens) | `The input is too large.` | Split input into smaller chunks. |
| **`NotAllowedError`** *(spec)* | Summarization disabled by user/UA policy | *(not reproduced)* | User must enable. |
| **`NotReadableError`** *(spec)* | Output filtered by UA (harmful/inaccurate) | *(not reproduced)* | Try different input. |
| **`NotSupportedError`** *(spec)* | Input/context/output language unsupported or undetectable | See above. | Use supported languages. |
| **`UnknownError`** *(spec)* | Catch-all for unspecified failures | *(not reproduced)* | Retry or fall back. |
| **`OperationError`** *(spec)* | Model initialization failed | *(not reproduced)* | Retry; if persistent, clear model cache. |
| **Console warning** | No `outputLanguage` specified | `No output language was specified in a Summarizer API request...` | Specify `outputLanguage`. |
| **Console warning** | Unsupported language in `availability()` | `The requested language options are not supported.` | Use supported languages. |
| **Service not running** *(Edge on Linux)* | On-device model service fails to start (Edge 150 Linux) | Console: `Unable to create a text session because the service is not running.` + `NotSupportedError` | Use Chrome instead, or fall back to a cloud API. Edge on Windows/macOS may work. |

### Error handling pattern

```js
try {
  const avail = await Summarizer.availability({
    expectedInputLanguages: ['en'],
    outputLanguage: 'en',
  });
  if (avail === 'unavailable') {
    throw new Error('Summarizer not supported for this configuration');
  }
  const summarizer = await Summarizer.create({
    type: 'key-points',
    length: 'short',
    expectedInputLanguages: ['en'],
    outputLanguage: 'en',
  });

  // Check quota before summarizing
  const usage = await summarizer.measureInputUsage(longText);
  if (usage > summarizer.inputQuota) {
    throw new Error(`Input too large: ${usage} tokens > ${summarizer.inputQuota} quota`);
  }

  const summary = await summarizer.summarize(longText);
  summarizer.destroy();
  return summary;
} catch (e) {
  if (e.name === 'QuotaExceededError') {
    // Split input into smaller chunks and summarize each
  }
  if (e.name === 'NotSupportedError') {
    // Unsupported language — fall back to cloud API
  }
  if (e.name === 'AbortError' && !abortedIntentionally) {
    // Destroyed translator or real abort
  }
  throw e;
}
```

---

## 6. Quotas, Limits & Text Size

### inputQuota — REAL AND ENFORCED

**Verified**: `summarizer.inputQuota` is **9216** (a finite number). This is a real token-based
quota, unlike the Translator API where `inputQuota` is `null`.

`measureInputUsage()` returns real token counts proportional to input length. When usage
exceeds quota, `summarize()` throws `QuotaExceededError`.

### Max text size

**Verified**: Text up to ~9K chars (usage 2440 tokens) works fine. Text at ~45K chars
(usage 9937 tokens) exceeds the 9216 quota and throws `QuotaExceededError`.

| Input size (chars) | Usage (tokens) | Status |
|---|---|---|
| 100 | 580 | OK |
| 903 | 748 | OK |
| 4,515 | 1,504 | OK |
| 8,987 | 2,440 | OK |
| 44,806 | 9,937 | **QuotaExceededError** |

**Practical limit**: ~30K chars of English text (rough estimate — depends on tokenization).
Always check with `measureInputUsage()` before calling `summarize()`.

**Important**: The quota is per-summarizer-instance and is shared between the `sharedContext`
(loaded during `create()`) and each `summarize()` call's `input` + `context`. A long
`sharedContext` reduces the available quota for actual summarization.

### Handling quota exceeded

```js
const usage = await summarizer.measureInputUsage(text, { context });
if (usage > summarizer.inputQuota) {
  // Strategy 1: Split into paragraphs and summarize each
  const paragraphs = text.split(/\n\n+/);
  const chunkSummaries = [];
  for (const para of paragraphs) {
    const chunkUsage = await summarizer.measureInputUsage(para);
    if (chunkUsage > summarizer.inputQuota) {
      // Split further by sentences
      // ...
    } else {
      chunkSummaries.push(await summarizer.summarize(para));
    }
  }
  // Optionally: summarize the combined chunk summaries
  return chunkSummaries.join('\n\n');
}
return await summarizer.summarize(text);
```

### The ~22 GB disk requirement — THIS TIME IT'S REAL

Unlike the Translator API (where the ~22 GB requirement was for Gemini Nano, not the expert
models), the Summarizer API **does** use Gemini Nano. Users must have:

- ~22 GB free disk space for the model download
- The download takes ~3 minutes on a fast connection (could be 10+ minutes on slower links)
- If disk space falls below 10 GB, the model is automatically evicted

**UI guidance for users**: When offering summarization, inform users that:
1. A one-time ~1.8 GB model download is required (part of Chrome's ~22 GB AI model footprint).
2. The download needs an unmetered connection.
3. First-use will have a delay while the model downloads.
4. The model runs entirely on-device — no data is sent to any server.

---

## 7. Streaming Behavior

`summarizeStreaming()` returns a standard `ReadableStream<string>`.

```js
const stream = summarizer.summarizeStreaming(text, { context });
for await (const chunk of stream) {
  output += chunk;
}
```

**Chunk characteristics** (verified):

- Chunks are **very small** (1-13 chars each) — essentially token-by-token generation.
- For a ~1K char input producing ~480 chars of summary: **105 chunks** over 10.7 seconds.
- Empty string yields **0 chunks** (stream closes immediately).
- The stream is a real `ReadableStream` — supports `getReader()`, `pipeTo()`, `tee()`, etc.
- **Abort**: Pass `{ signal }` and abort. The `for await` loop throws `AbortError`.

**Comparison with Translator streaming**:

| Aspect | Translator | Summarizer |
|---|---|---|
| Chunk size | ~50-80 chars (sentence-sized) | 1-13 chars (token-sized) |
| Chunks for ~1K input | 2 | 105 |
| Time for ~1K input | 79ms | 10.7s |
| Empty input | 1 chunk (`[""]`) | 0 chunks |

The small chunk size is ideal for real-time UI updates (typewriter effect).

---

## 8. Spec vs Implementation Discrepancies

### Chrome 150 vs Spec

| Feature | Spec says | Chrome 150 does | Impact |
|---|---|---|---|
| `preference` property | Defined as readonly attribute with default `"auto"` | **Not present** on prototype (`'preference' in summarizer` → `false`) | Experimental — only in extension/experimental contexts. Don't rely on it. |
| `sharedContext` default | `null` if not specified | `""` (empty string) | Check with `=== ""` not `=== null`. |
| `summarize()` empty input | "resulting summary should be the empty string" | Returns `""` for empty and whitespace. | Matches spec. |
| `summarize()` non-string | DOMString coercion | Coerces via `String()`. `42` → `"42"` → summarized. `null` → `"null"` → empty summary. | Be careful with non-string inputs. |
| `measureInputUsage()` | Returns real usage proportional to input | Returns real token counts (560-9937 for tested inputs). | Matches spec. |
| `inputQuota` | `unrestricted double`, may be `+∞` | `9216` (finite, enforced) | Real limit. Check before summarizing. |
| `plain-text` format | "should not contain any formatting or markup" | Still produces `*` bullets for key-points | Chrome doesn't fully strip markdown from plain-text. |
| Post-destroy error | Not specified | Throws `AbortError` (same as Translator) | Check a `destroyed` flag in your wrapper. |
| `availability()` transient errors | May return `null` | Never returns `null` | Simpler error handling. |

### Edge 150 vs Chrome 150

| Feature | Chrome 150 | Edge 150 | Impact |
|---|---|---|---|
| `Summarizer` constructor present | Yes | **Yes** | Edge exposes the API. |
| `availability()` (supported lang) | `"available"` (model cached) | `"unavailable"` — service not running | **Edge can't summarize on Linux.** Console: `Unable to create a text session because the service is not running.` |
| `availability()` (unsupported lang) | `"unavailable"` | `"unavailable"` | Same. |
| `create()` | Succeeds | Throws `NotSupportedError: Unable to create a text session because the service is not running.` | Edge's on-device model service doesn't start on Linux. |
| Supported languages (from console) | `[de, en, es, fr, ja]` | `[de, en, es, fr, ja]` (when service running) / `['en']` (Edge 138, when service not running) | Edge 138 only listed `en`; Edge 150 lists all 5 but service still doesn't work. |
| Feedback URL | `issues.chromium.org` | `learn.microsoft.com/microsoft-edge/web-platform/writing-assistance-apis` | Edge has its own feedback channel. |
| `preference` property | Not present | Not present | Same. |

### Edge 150 vs Spec

| Feature | Spec says | Edge 150 does | Impact |
|---|---|---|---|
| `create()` | Returns a `Summarizer` | Throws `NotSupportedError` (service not running) | Edge on Linux can't create a working summarizer. |
| `availability()` | Returns availability state | Returns `"unavailable"` even for supported languages (because service is down) | Can't distinguish "unsupported" from "service broken" via `availability()` alone. |

---

## 9. Recommended Wrapper Interface

```ts
export type SummarizerState =
  | 'unsupported'    // Summarizer API not available (wrong browser / not Chrome)
  | 'unavailable'    // API present but configuration not supported (e.g. unsupported language)
  | 'downloadable'   // Supported but model not downloaded yet
  | 'downloading'    // Model download in progress
  | 'ready'          // Summarizer created and ready
  | 'error';         // Fatal error

export interface SummarizerStatus {
  state: SummarizerState;
  downloadProgress: number | null;  // 0..1 when downloading, else null
  availability: 'unavailable' | 'downloadable' | 'downloading' | 'available' | null;
  message: string;
  inputQuota: number | null;        // 9216 when ready, else null
}

export interface SummarizeOptions {
  context?: string;
  signal?: AbortSignal;
}

export interface CreateOptions {
  type?: 'tldr' | 'teaser' | 'key-points' | 'headline';
  format?: 'plain-text' | 'markdown';
  length?: 'short' | 'medium' | 'long';
  sharedContext?: string;
  expectedInputLanguages?: string[];
  expectedContextLanguages?: string[];
  outputLanguage?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export interface SummarizerClient {
  isApiSupported(): boolean;
  checkAvailability(options?: CreateOptions): Promise<SummarizerStatus>;
  create(options: CreateOptions): Promise<SummarizerStatus>;
  summarize(text: string, options?: SummarizeOptions): Promise<string>;
  summarizeStreaming(text: string, options?: SummarizeOptions): ReadableStream<string>;
  measureInputUsage(text: string, options?: SummarizeOptions): Promise<number>;
  destroy(): void;
  readonly status: SummarizerStatus;
  readonly inputQuota: number | null;
}
```

---

## 10. Mock Implementation for Tests

This mock simulates the full stateful behavior of the Summarizer API, including the model
download, input quota enforcement, all type/format/length combinations, streaming, and error
conditions. It installs `self.Summarizer` so existing code works unchanged in Chromium.

### Design goals

1. **Drop-in replacement**: Installs `globalThis.Summarizer` with the same API.
2. **Stateful download**: Simulates `downloadable → downloading → available` transitions.
3. **Real input quota**: Uses `inputQuota = 9216` and enforces it with `QuotaExceededError`.
4. **Realistic `measureInputUsage()`**: Returns token counts proportional to input length.
5. **Type/format/length-aware**: Produces different mock output for each combination.
6. **Streaming**: Produces small token-sized chunks (matching real Chrome behavior).
7. **Error simulation**: Supports `NotSupportedError`, `AbortError`, `QuotaExceededError`, `TypeError`.
8. **No `preference` property**: Matches Chrome (experimental, not exposed).

### Mock code

```js
/**
 * MockSummarizer — drop-in mock for Chrome's built-in Summarizer API.
 *
 * Install:  MockSummarizer.install(options)
 * Uninstall: MockSummarizer.uninstall()
 *
 * Options:
 *   downloadDelayMs   — ms for simulated model download (default: 200)
 *   supportedLangs    — array of supported language codes (default: ['en','es','ja','de','fr'])
 *   inputQuota        — input quota in tokens (default: 9216, matching real Chrome)
 *   summarizeDelayMs  — ms delay per summarize() call (default: 100)
 *   chunkSize         — chars per streaming chunk (default: 5, matching token-sized chunks)
 *   failOnCreate      — if true, create() throws NotSupportedError (simulates crash)
 *   summarizeFn       — (input, options, type, length, format) => string, for custom output
 */
class MockSummarizer {
  static _options = {
    downloadDelayMs: 200,
    supportedLangs: ['en', 'es', 'ja', 'de', 'fr'],
    inputQuota: 9216,
    summarizeDelayMs: 100,
    chunkSize: 5,
    failOnCreate: false,
    summarizeFn: null,
  };
  static _installed = false;
  static _realSummarizer = undefined;
  static _modelDownloaded = false;
  static _downloading = false;

  static _VALID_TYPES = new Set(['tldr', 'teaser', 'key-points', 'headline']);
  static _VALID_FORMATS = new Set(['plain-text', 'markdown']);
  static _VALID_LENGTHS = new Set(['short', 'medium', 'long']);

  static _defaultSummarizeFn(input, opts, type, length, format) {
    if (input === '' || /^\s+$/.test(input)) return '';

    // Generate mock summary based on type and length
    const sentenceCount = { short: 1, medium: 3, long: 5 }[length];
    const bulletCount = { short: 3, medium: 5, long: 7 }[length];

    const firstSentence = input.split(/[.!?]/)[0]?.trim() || input.slice(0, 80);

    switch (type) {
      case 'tldr': {
        const sentences = [];
        for (let i = 0; i < sentenceCount; i++) {
          sentences.push(`Summary point ${i + 1}: ${firstSentence.slice(0, 50)}...`);
        }
        return sentences.join(' ');
      }
      case 'teaser':
        return `Discover more about: ${firstSentence.slice(0, 60)}...`;
      case 'headline':
        return firstSentence.slice(0, 12) + ' ' + ['Journey', 'Story', 'Breakthrough', 'Evolution'][length.charCodeAt(0) % 4];
      case 'key-points': {
        const bullets = [];
        for (let i = 0; i < bulletCount; i++) {
          bullets.push(`* Key point ${i + 1}: ${firstSentence.slice(0, 40)}...`);
        }
        return bullets.join('\n');
      }
      default:
        return input.slice(0, 100);
    }
  }

  static install(options = {}) {
    this._options = { ...this._options, ...options };
    if (this._installed) return;
    this._realSummarizer = globalThis.Summarizer;
    this._installed = true;
    const self = this;

    class MockSummarizerInstance {
      #type;
      #format;
      #length;
      #sharedContext;
      #expectedInputLanguages;
      #expectedContextLanguages;
      #outputLanguage;
      #inputQuota;
      #destroyed = false;
      #summarizeFn;

      constructor(options) {
        this.#type = options.type ?? 'key-points';
        this.#format = options.format ?? 'markdown';
        this.#length = options.length ?? 'short';
        this.#sharedContext = options.sharedContext ?? '';
        this.#expectedInputLanguages = options.expectedInputLanguages?.length
          ? Object.freeze([...options.expectedInputLanguages]) : null;
        this.#expectedContextLanguages = options.expectedContextLanguages?.length
          ? Object.freeze([...options.expectedContextLanguages]) : null;
        this.#outputLanguage = options.outputLanguage ?? null;
        this.#inputQuota = self._options.inputQuota;
        this.#summarizeFn = self._options.summarizeFn || self._defaultSummarizeFn.bind(self);
      }

      get type() { return this.#type; }
      get format() { return this.#format; }
      get length() { return this.#length; }
      get sharedContext() { return this.#sharedContext; }
      get expectedInputLanguages() { return this.#expectedInputLanguages; }
      get expectedContextLanguages() { return this.#expectedContextLanguages; }
      get outputLanguage() { return this.#outputLanguage; }
      get inputQuota() { return this.#inputQuota; }
      // Note: no `preference` getter — matches real Chrome

      async summarize(input, options = {}) {
        if (this.#destroyed) {
          throw new DOMException(
            "Failed to execute 'summarize' on 'Summarizer': signal is aborted without reason",
            'AbortError',
          );
        }
        if (options.signal?.aborted) {
          throw new DOMException('signal is aborted without reason', 'AbortError');
        }

        const str = String(input); // DOMString coercion
        const context = options.context ?? null;

        // Measure usage and check quota
        const usage = this.#measureUsage(str, context);
        if (usage > this.#inputQuota) {
          throw new DOMException('The input is too large.', 'QuotaExceededError');
        }

        // Simulate async work
        await new Promise((r) => setTimeout(r, self._options.summarizeDelayMs));
        if (options.signal?.aborted) {
          throw new DOMException('signal is aborted without reason', 'AbortError');
        }

        return this.#summarizeFn(str, { sharedContext: this.#sharedContext, context },
          this.#type, this.#length, this.#format);
      }

      summarizeStreaming(input, options = {}) {
        if (this.#destroyed) {
          throw new DOMException(
            "Failed to execute 'summarizeStreaming' on 'Summarizer': signal is aborted without reason",
            'AbortError',
          );
        }

        const str = String(input);
        const context = options.context ?? null;
        const fn = this.#summarizeFn;
        const type = this.#type;
        const length = this.#length;
        const format = this.#format;
        const chunkSize = self._options.chunkSize;
        const signal = options.signal;
        const delayMs = self._options.summarizeDelayMs;
        const sharedContext = this.#sharedContext;

        return new ReadableStream({
          async start(controller) {
            if (signal?.aborted) {
              controller.error(new DOMException('signal is aborted without reason', 'AbortError'));
              return;
            }

            const full = fn(str, { sharedContext, context }, type, length, format);

            if (full === '') {
              controller.close();
              return;
            }

            // Yield in small chunks (matching token-sized chunks of real Chrome)
            const totalChunks = Math.ceil(full.length / chunkSize);
            const perChunkDelay = delayMs / Math.max(totalChunks, 1);

            for (let i = 0; i < full.length; i += chunkSize) {
              if (signal?.aborted) {
                controller.error(new DOMException('signal is aborted without reason', 'AbortError'));
                return;
              }
              await new Promise((r) => setTimeout(r, perChunkDelay));
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
        const str = String(input);
        const context = options.context ?? null;
        return this.#measureUsage(str, context);
      }

      #measureUsage(input, context) {
        // Simulate token counting: roughly 1 token per 4 chars of input,
        // plus overhead for sharedContext and context.
        // Real Chrome returns values like 560 for "Hello world" and 9937 for ~45K chars.
        const inputTokens = Math.ceil(input.length / 4);
        const contextTokens = context ? Math.ceil(context.length / 4) : 0;
        const sharedContextTokens = this.#sharedContext ? Math.ceil(this.#sharedContext.length / 4) : 0;
        // Add overhead (real Chrome has ~500 token overhead for short inputs)
        return 500 + inputTokens + contextTokens + sharedContextTokens;
      }

      destroy() {
        this.#destroyed = true;
      }
    }

    const MockStatic = {
      async availability(options = {}) {
        self._validateOptions(options);

        // Check language support
        if (options.expectedInputLanguages) {
          for (const lang of options.expectedInputLanguages) {
            if (!self._options.supportedLangs.includes(lang)) return 'unavailable';
          }
        }
        if (options.outputLanguage && !self._options.supportedLangs.includes(options.outputLanguage)) {
          return 'unavailable';
        }
        if (options.expectedContextLanguages) {
          for (const lang of options.expectedContextLanguages) {
            if (!self._options.supportedLangs.includes(lang)) return 'unavailable';
          }
        }

        if (self._modelDownloaded) return 'available';
        if (self._downloading) return 'downloading';
        return 'downloadable';
      },

      async create(options = {}) {
        self._validateOptions(options);

        if (options.signal?.aborted) {
          throw new DOMException('signal is aborted without reason', 'AbortError');
        }
        if (self._options.failOnCreate) {
          throw new DOMException(
            'The requested language options are not supported.',
            'NotSupportedError',
          );
        }

        // Check language support
        if (options.expectedInputLanguages) {
          for (const lang of options.expectedInputLanguages) {
            if (!self._options.supportedLangs.includes(lang)) {
              throw new DOMException('The requested language options are not supported.', 'NotSupportedError');
            }
          }
        }
        if (options.outputLanguage && !self._options.supportedLangs.includes(options.outputLanguage)) {
          throw new DOMException('The requested language options are not supported.', 'NotSupportedError');
        }

        // Simulate download if needed
        if (!self._modelDownloaded) {
          self._downloading = true;

          if (options.monitor) {
            const m = new EventTarget();
            options.monitor(m);
            const steps = 10;
            for (let i = 0; i <= steps; i++) {
              if (options.signal?.aborted) {
                self._downloading = false;
                throw new DOMException('signal is aborted without reason', 'AbortError');
              }
              m.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: i / steps }));
              await new Promise((r) => setTimeout(r, self._options.downloadDelayMs / steps));
            }
          } else {
            await new Promise((r) => setTimeout(r, self._options.downloadDelayMs));
          }

          if (options.signal?.aborted) {
            self._downloading = false;
            throw new DOMException('signal is aborted without reason', 'AbortError');
          }

          self._downloading = false;
          self._modelDownloaded = true;
        } else if (options.monitor) {
          // Already downloaded — fire instant progress events
          const m = new EventTarget();
          options.monitor(m);
          m.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0 }));
          m.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 1 }));
        }

        return new MockSummarizerInstance(options);
      },
    };

    globalThis.Summarizer = MockStatic;
  }

  static uninstall() {
    if (!this._installed) return;
    globalThis.Summarizer = this._realSummarizer;
    this._installed = false;
    this._realSummarizer = undefined;
  }

  static reset() {
    this._modelDownloaded = false;
    this._downloading = false;
  }

  static _validateOptions(options) {
    if (options === null || options === undefined || typeof options !== 'object') {
      throw new TypeError(
        "Failed to execute 'availability' on 'Summarizer': The provided value is not of type 'SummarizerCreateCoreOptions'.",
      );
    }
    if (options.type !== undefined && !this._VALID_TYPES.has(options.type)) {
      throw new TypeError(
        `Failed to execute 'availability' on 'Summarizer': Failed to read the 'type' property from 'SummarizerCreateCoreOptions': The provided value '${options.type}' is not a valid enum value of type SummarizerType.`,
      );
    }
    if (options.format !== undefined && !this._VALID_FORMATS.has(options.format)) {
      throw new TypeError(
        `Failed to execute 'availability' on 'Summarizer': Failed to read the 'format' property from 'SummarizerCreateCoreOptions': The provided value '${options.format}' is not a valid enum value of type SummarizerFormat.`,
      );
    }
    if (options.length !== undefined && !this._VALID_LENGTHS.has(options.length)) {
      throw new TypeError(
        `Failed to execute 'availability' on 'Summarizer': Failed to read the 'length' property from 'SummarizerCreateCoreOptions': The provided value '${options.length}' is not a valid enum value of type SummarizerLength.`,
      );
    }
  }

  // Test helpers
  static preDownloadModel() { this._modelDownloaded = true; }
  static isModelDownloaded() { return this._modelDownloaded; }
  static isDownloading() { return this._downloading; }
}
```

### Usage examples

```js
// --- Basic usage ---
MockSummarizer.install({ downloadDelayMs: 50, summarizeDelayMs: 10 });
console.assert('Summarizer' in self === true);

// Availability — model not downloaded yet
const avail = await Summarizer.availability({ expectedInputLanguages: ['en'], outputLanguage: 'en' });
console.assert(avail === 'downloadable');

// Create (triggers simulated download)
const summarizer = await Summarizer.create({
  type: 'key-points',
  length: 'short',
  expectedInputLanguages: ['en'],
  outputLanguage: 'en',
  monitor(m) {
    m.addEventListener('downloadprogress', (e) => console.log(`Download: ${(e.loaded * 100).toFixed(0)}%`));
  },
});

// Now available
const avail2 = await Summarizer.availability({ expectedInputLanguages: ['en'], outputLanguage: 'en' });
console.assert(avail2 === 'available');

// Summarize
const summary = await summarizer.summarize('The history of AI began in the 1950s.');
console.assert(summary.startsWith('* Key point 1:'));

// Stream
const stream = summarizer.summarizeStreaming('Long text here...');
for await (const chunk of stream) { process.stdout.write(chunk); }

// Check quota
console.assert(summarizer.inputQuota === 9216);
const usage = await summarizer.measureInputUsage('test');
console.assert(usage > 0);

// Destroy
summarizer.destroy();
try { await summarizer.summarize('test'); } catch (e) {
  console.assert(e.name === 'AbortError');
}

// --- Error simulation ---

// Unsupported language
MockSummarizer.reset();
const badAvail = await Summarizer.availability({ expectedInputLanguages: ['zh'] });
console.assert(badAvail === 'unavailable');
try {
  await Summarizer.create({ expectedInputLanguages: ['zh'] });
} catch (e) { console.assert(e.name === 'NotSupportedError'); }

// Invalid enum
try { await Summarizer.availability({ type: 'invalid' }); }
catch (e) { console.assert(e.name === 'TypeError'); }

// Quota exceeded
MockSummarizer.install({ summarizeDelayMs: 0 });
MockSummarizer.preDownloadModel();
const s = await Summarizer.create({ expectedInputLanguages: ['en'], outputLanguage: 'en' });
const longText = 'A'.repeat(50000);
const usage = await s.measureInputUsage(longText);
console.assert(usage > 9216); // exceeds quota
try { await s.summarize(longText); }
catch (e) { console.assert(e.name === 'QuotaExceededError'); }

// --- Pre-cached model (skip download) ---
MockSummarizer.install({ downloadDelayMs: 10000 });
MockSummarizer.preDownloadModel();
const s2 = await Summarizer.create({ expectedInputLanguages: ['en'], outputLanguage: 'en' });
// Returns instantly despite 10s downloadDelayMs
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
  executablePath: '/opt/google/chrome/chrome',  // MUST be real Chrome
  headless: false,                                // run under xvfb-run -a
  ignoreDefaultArgs: [
    PW_DISABLE_FEATURES,
    '--disable-component-update',
    '--enable-automation',
  ],
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--enable-features=TranslatorAPI,OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel,SummarizerAPI,PromptAPIForGeminiNano',
    '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,' +
    'DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,' +
    'MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,' +
    'AutoDeElevate,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion',
  ],
});
```

### Additional flags for Summarizer (vs Translator)

| Flag | Why | Required? |
|---|---|---|
| `prompt-api-for-gemini-nano` flag in `Local State` | Needed for foundation model APIs | **Yes** |
| `SummarizerAPI` in `--enable-features` | Enables the Summarizer API | **Yes** |
| `PromptAPIForGeminiNano` in `--enable-features` | Enables Gemini Nano model access | **Yes** |
| Persistent `userDataDir` | Caches the ~1.8 GB model across runs (avoids re-download) | **Strongly recommended** |
| Real page (`http://localhost:PORT/`) | API not exposed on `about:blank` | **Yes** |
| User gesture before `create()` | Required when `availability === 'downloadable'` | **Yes** (first run) |

### Same critical flags as Translator

- Real Google Chrome (not CfT/Chromium)
- Strip `Translate` and `OptimizationHints` from `--disable-features`
- Strip `--disable-component-update` (Playwright) and `--disable-background-networking` (Puppeteer)
- Do NOT use `ignoreDefaultArgs: true` (Playwright needs `--remote-debugging-pipe`)

---

## Appendix: Environment on this machine

- Real Google Chrome: `/opt/google/chrome/chrome` (150.0.7871.186) — **fully working**
- Microsoft Edge: `/opt/microsoft/msedge/microsoft-edge` (150.0.4078.99) — API present, on-device model service doesn't start on Linux
- Persistent AI profile (Chrome): `/tmp/opencode/chrome-ai-profile-pw` (has both flags set; Gemini Nano model cached after ~200s download)
- Hardware: 6 CPU cores, 31 GB RAM, 155 GB disk, NVIDIA RTX 2080 Ti (11 GB VRAM)
- `xvfb-run -a` available for headed runs without a display
- Playwright installed in `/tmp/opencode/node_modules` (v1.62.0)
