/**
 * The language ScribeAr transcripts are produced in. The Translator API needs
 * an explicit source language - it has no "detect" mode - and every ASR
 * provider wired up today emits English.
 */
export const TRANSCRIPT_SOURCE_LANGUAGE = 'en';

/**
 * Default target language for translated captions.
 */
export const DEFAULT_TARGET_LANGUAGE = 'es';

/**
 * BCP-47 tags we ask the active local translation provider about.
 *
 * The common Translator interface answers one pair at a time, so the picker
 * probes a candidate list and drops whatever comes back `unavailable`. This
 * list is the union of Mozilla's released English→target Bergamot directions
 * and Chromium TranslateKit's documented targets. The registry remains the
 * source of truth: a language with no released model simply disappears.
 *
 * Codes that fail on one browser/version simply disappear from the picker, so
 * over-listing is safe; under-listing silently hides a working language.
 */
export const CANDIDATE_TARGET_LANGUAGES: readonly string[] = [
  'af',
  'ar',
  'az',
  'be',
  'bg',
  'bn',
  'bs',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'et',
  'eu',
  'fa',
  'fi',
  'fr',
  'gl',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'is',
  'it',
  'ja',
  'kn',
  'ko',
  'lt',
  'lv',
  'ml',
  'mr',
  'ms',
  'nb',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sq',
  'sr',
  'sv',
  'ta',
  'te',
  'th',
  'tl',
  'tr',
  'ug',
  'uk',
  'ur',
  'vi',
  'zh',
  'zh-Hant',
];

/**
 * English names used when `Intl.DisplayNames` is missing or returns the raw
 * tag back. Only covers {@link CANDIDATE_TARGET_LANGUAGES}; anything else
 * falls back to the tag itself, which is still selectable.
 */
const FALLBACK_LANGUAGE_NAMES: Record<string, string> = {
  af: 'Afrikaans',
  ar: 'Arabic',
  az: 'Azerbaijani',
  be: 'Belarusian',
  bg: 'Bulgarian',
  bn: 'Bengali',
  bs: 'Bosnian',
  ca: 'Catalan',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  es: 'Spanish',
  et: 'Estonian',
  eu: 'Basque',
  fa: 'Persian',
  fi: 'Finnish',
  fr: 'French',
  gl: 'Galician',
  gu: 'Gujarati',
  he: 'Hebrew',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  id: 'Indonesian',
  is: 'Icelandic',
  it: 'Italian',
  ja: 'Japanese',
  kn: 'Kannada',
  ko: 'Korean',
  lt: 'Lithuanian',
  lv: 'Latvian',
  ml: 'Malayalam',
  mr: 'Marathi',
  ms: 'Malay',
  nb: 'Norwegian Bokmål',
  nl: 'Dutch',
  no: 'Norwegian',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sk: 'Slovak',
  sl: 'Slovenian',
  sq: 'Albanian',
  sr: 'Serbian',
  sv: 'Swedish',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tl: 'Tagalog',
  tr: 'Turkish',
  ug: 'Uyghur',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
  zh: 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
};

/**
 * Human-readable name for a BCP-47 tag, in the reader's own UI language where
 * the platform can provide one.
 *
 * `Intl.DisplayNames` is wrapped because a bad tag makes it throw `RangeError`,
 * and a picker that throws is worse than one showing a raw language code.
 *
 * @param code - BCP-47 language tag, e.g. `'es'` or `'zh-Hant'`.
 * @returns The display name, or the tag itself if no name is known.
 */
export function languageDisplayName(code: string): string {
  try {
    const displayNames = new Intl.DisplayNames(undefined, {
      type: 'language',
    });
    const name = displayNames.of(code);
    if (name !== undefined && name !== code) return name;
  } catch {
    // Unsupported tag or no Intl.DisplayNames - fall through to the table.
  }
  return FALLBACK_LANGUAGE_NAMES[code] ?? code;
}
