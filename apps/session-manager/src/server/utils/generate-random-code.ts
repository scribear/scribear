import crypto from 'node:crypto';

const RANDOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function generateRandomCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += RANDOM_CODE_CHARS.charAt(
      crypto.randomInt(0, RANDOM_CODE_CHARS.length),
    );
  }
  return code;
}
