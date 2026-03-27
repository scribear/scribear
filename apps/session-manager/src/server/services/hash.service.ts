import bcrypt from 'bcrypt';

const HASH_SALT_ROUDS = 12;

export class HashService {
  hash(value: string) {
    return bcrypt.hash(value, HASH_SALT_ROUDS);
  }

  verify(value: string, hash: string) {
    return bcrypt.compare(value, hash);
  }
}
