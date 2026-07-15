import bcrypt from 'bcrypt';

const HASH_SALT_ROUNDS = 12;

export class HashService {
  /**
   * Hashes a plaintext value with bcrypt.
   * @param value The plaintext string to hash.
   * @returns A bcrypt hash string.
   */
  hash(value: string) {
    return bcrypt.hash(value, HASH_SALT_ROUNDS);
  }

  /**
   * Verifies a plaintext value against a bcrypt hash.
   * @param value The plaintext string to verify.
   * @param hash The bcrypt hash to compare against.
   * @returns `true` if the value matches the hash, `false` otherwise.
   */
  verify(value: string, hash: string) {
    return bcrypt.compare(value, hash);
  }
}
