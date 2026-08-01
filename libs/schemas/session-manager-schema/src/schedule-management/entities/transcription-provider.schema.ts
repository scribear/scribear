import { Type } from 'typebox';

/**
 * Provider keys shipped in `deployment/provider_config.template.json`.
 *
 * This is a **default**, not the truth. The authoritative list is whatever the
 * deployment's `provider_config.json` actually defines, and that file is
 * operator-editable — a deployment can add a provider we have never heard of,
 * or drop one of these. So this is not baked into the wire schema as an enum:
 * a hardcoded union would reject a provider the operator legitimately
 * configured and accept one they removed, which is the same class of mistake as
 * pinning an `Authorization` header to a character class and guessing what an
 * operator's secret manager emits.
 *
 * Instead session-manager validates against `TRANSCRIPTION_PROVIDER_IDS`, whose
 * default is exactly this list. Exported here so both sides — the default and
 * the OpenAPI documentation — come from one place.
 */
export const SHIPPED_TRANSCRIPTION_PROVIDER_IDS = [
  'debug',
  'whisper',
  'lumen_granite',
  'crisper_whisper',
] as const;

/**
 * A transcription provider key. Stays `Type.String` on the wire — see
 * {@link SHIPPED_TRANSCRIPTION_PROVIDER_IDS} for why the accepted set is not
 * pinned here. Session Manager rejects a key outside its configured set with
 * `400 VALIDATION_ERROR`, so an unknown provider fails at the point an operator
 * can still see it, rather than at stream time where it closes the upstream
 * socket 1007 and shows every viewer a "reconnecting" banner forever.
 */
export const TRANSCRIPTION_PROVIDER_ID_SCHEMA = Type.String({
  minLength: 1,
  description:
    "Key of a provider defined in the deployment's transcription-service " +
    'provider_config.json. Rejected with 400 VALIDATION_ERROR if it is not ' +
    "one of the keys Session Manager is configured to accept (see the service's " +
    'TRANSCRIPTION_PROVIDER_IDS).',
  examples: [...SHIPPED_TRANSCRIPTION_PROVIDER_IDS],
});
