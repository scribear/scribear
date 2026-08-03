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
 * BCP-47 tags we ask the browser about.
 *
 * There is no API that enumerates supported pairs - `Translator.availability()`
 * answers one pair at a time and Chrome deliberately reports every uncached
 * pair as `downloadable`, so the only way to build a picker is to probe a
 * candidate list and drop whatever comes back `unavailable`. Probing is cheap
 * (no network, no model load) but it is not free, so this list is the set
 * Chrome's TranslateKit documents rather than all of BCP-47.
 *
 * Codes that fail on one browser/version simply disappear from the picker, so
 * over-listing is safe; under-listing silently hides a working language.
 */
export const CANDIDATE_TARGET_LANGUAGES: readonly string[] = [
  'ar',
  'bg',
  'bn',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'fi',
  'fr',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'kn',
  'ko',
  'lt',
  'mr',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
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
  ar: 'Arabic',
  bg: 'Bulgarian',
  bn: 'Bengali',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  es: 'Spanish',
  fi: 'Finnish',
  fr: 'French',
  he: 'Hebrew',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  kn: 'Kannada',
  ko: 'Korean',
  lt: 'Lithuanian',
  mr: 'Marathi',
  nl: 'Dutch',
  no: 'Norwegian',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sk: 'Slovak',
  sl: 'Slovenian',
  sv: 'Swedish',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
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
