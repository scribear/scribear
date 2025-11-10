import Type from 'typebox';

const DebugProviderConfigSchema = Type.Null();

type DebugProviderConfig = Type.Static<typeof DebugProviderConfigSchema>;

type TranscriptionStreamConfig = DebugProviderConfig;

export { DebugProviderConfigSchema };
export type { DebugProviderConfig, TranscriptionStreamConfig };
