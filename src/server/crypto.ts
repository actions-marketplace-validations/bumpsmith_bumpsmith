// Cryptographic building blocks for accounts, sessions and secrets. Everything uses
// node:crypto; nothing here is home-grown cryptography, only careful use of standard
// primitives (scrypt, AES-256-GCM, HMAC-SHA1 for RFC 6238 TOTP, SHA-256).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Opaque random token, URL-safe. 32 bytes = 256 bits. */
export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;
export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Constant-time string comparison (equal length required for a match). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(x, x); // keep the timing similar
    return false;
  }
  return timingSafeEqual(x, y);
}

// ── Passwords: scrypt (OWASP: N=2^17, r=8, p=1), parameters stored with the hash ──

const KDF = { N: 2 ** 17, r: 8, p: 1, keylen: 32 };
const scryptAsync = (pw: string, salt: Buffer, o: typeof KDF) =>
  new Promise<Buffer>((ok, fail) =>
    scrypt(
      pw.normalize("NFKC"),
      salt,
      o.keylen,
      { N: o.N, r: o.r, p: o.p, maxmem: 256 * 1024 * 1024 },
      (e, k) => (e ? fail(e) : ok(k)),
    ),
  );

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, KDF);
  return `scrypt$${KDF.N}$${KDF.r}$${KDF.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  // Without a stored hash, still spend the same time so a missing account is not visible.
  const [alg, n, r, p, salt, key] = (stored ?? DUMMY_HASH).split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = await scryptAsync(pw, Buffer.from(salt, "base64"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    keylen: want.length,
  });
  return timingSafeEqual(want, got) && stored !== null;
}
const DUMMY_HASH = `scrypt$${KDF.N}$8$1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(32).toString("base64")}`;

// ── Secrets at rest: AES-256-GCM with a master key ──

/**
 * The master key comes from BUMPSMITH_MASTER_KEY (base64, 32 bytes) or a key file created
 * with mode 0600 next to the database. Put the key in a KMS-backed environment variable in
 * production so a stolen disk image does not hold both the data and its key.
 */
export async function loadMasterKey(keyFile: string): Promise<Buffer> {
  const env = process.env.BUMPSMITH_MASTER_KEY;
  if (env) {
    const k = Buffer.from(env, "base64");
    if (k.length !== 32) throw new Error("BUMPSMITH_MASTER_KEY must be 32 bytes, base64-encoded");
    return k;
  }
  if (existsSync(keyFile)) {
    const k = Buffer.from((await readFile(keyFile, "utf8")).trim(), "base64");
    if (k.length !== 32) throw new Error(`${keyFile} does not hold a 32-byte key`);
    return k;
  }
  const k = randomBytes(32);
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
  await writeFile(keyFile, `${k.toString("base64")}\n`, { mode: 0o600 });
  await chmod(keyFile, 0o600);
  return k;
}

/** Encrypt with AES-256-GCM; `aad` binds the ciphertext to its record (e.g. "secret:org:name"). */
export function encrypt(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}

export function decrypt(key: Buffer, box: string, aad: string): string {
  const [v, iv, tag, body] = box.split(".");
  if (v !== "v1" || !iv || !tag || body === undefined) throw new Error("unknown ciphertext format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

// ── TOTP (RFC 6238 / RFC 4226): SHA-1, 6 digits, 30-second steps ──

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = 6, alg = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(alg, secret).update(msg).digest();
  const off = (h[h.length - 1] as number) & 0xf;
  const bin = ((h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits).toString();
  return bin.padStart(digits, "0");
}

/**
 * Check a TOTP code within ±1 step. Returns the matched step so the caller can refuse its
 * reuse (replay), or null.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  now = Date.now(),
  lastStep = -1,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const step = Math.floor(now / 30_000);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastStep) continue;
    if (safeEqual(hotp(key, s), code)) return s;
  }
  return null;
}

export function otpauthUrl(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Ten one-time recovery codes like "k7q2-m9xd-4hpt"; only their hashes are stored. */
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () => {
    const b = randomBytes(12);
    const chars = [...b].map((x) => alphabet[x % alphabet.length]).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}
