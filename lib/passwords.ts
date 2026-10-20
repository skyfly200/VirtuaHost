import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Password hashes look like "scrypt.<salt hex>.<hash hex>" (hex only, so they survive .env files and dashboards).
const KEYLEN = 32;
const COST = { N: 16384, r: 8, p: 1 };

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const key = scryptSync(password, salt, KEYLEN, COST);
  return `scrypt.${salt.toString("hex")}.${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split(".");
  if (scheme !== "scrypt" || !/^[0-9a-f]+$/i.test(saltHex ?? "") || !/^[0-9a-f]+$/i.test(keyHex ?? "")) return false;
  const expected = Buffer.from(keyHex, "hex");
  if (expected.length !== KEYLEN) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), KEYLEN, COST);
  return timingSafeEqual(actual, expected);
}
