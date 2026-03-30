import Type from 'typebox';

const DebugProviderConfigSchema = Type.Object({
  sample_rate: Type.Integer(),
  num_channels: Type.Integer(),
});
export { DebugProviderConfigSchema };

export type DebugProviderConfig = Type.Static<typeof DebugProviderConfigSchema>;
