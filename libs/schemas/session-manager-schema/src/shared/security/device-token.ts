import { Type } from 'typebox';

export const DEVICE_TOKEN_COOKIE_NAME = 'DEVICE_TOKEN';

export const DEVICE_TOKEN_SECURITY = [{ deviceToken: [] }];

export const INVALID_DEVICE_TOKEN_REPLY_SCHEMA = {
  401: Type.Object(
    {
      code: Type.Literal('INVALID_DEVICE_TOKEN'),
      message: Type.String({ description: 'Human-readable summary.' }),
    },
    {
      $id: 'InvalidDeviceTokenReply',
      description:
        '401 emitted when the DEVICE_TOKEN cookie is missing, expired, or revoked.',
    },
  ),
};
