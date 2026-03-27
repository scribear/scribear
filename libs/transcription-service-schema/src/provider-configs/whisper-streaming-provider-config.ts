import Type from 'typebox';

const WhisperStreamingProviderConfigSchema = Type.Object({});
export { WhisperStreamingProviderConfigSchema };

export type WhisperStreamingProviderConfig = Type.Static<
  typeof WhisperStreamingProviderConfigSchema
>;
