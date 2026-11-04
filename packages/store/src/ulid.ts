import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate a canonical ULID (48-bit time, 80-bit randomness).
 *
 * `Event.id` must be a ULID (domain `parseEventId`); generation belongs to the
 * adapter, so it lives here rather than in the domain package.
 */
export function newUlid(
  timestampMs: number = Date.now(),
  random: Uint8Array = randomBytes(10),
): string {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error("ULID timestamp must be a non-negative integer");
  }
  if (random.length !== 10) {
    throw new Error("ULID randomness must be 10 bytes");
  }

  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(timestampMs / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestampMs / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestampMs / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestampMs / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestampMs / 2 ** 8) & 0xff;
  bytes[5] = timestampMs & 0xff;
  bytes.set(random, 6);

  return encode(bytes);
}

/** 128 bits of bytes into 26 Crockford Base32 characters. */
function encode(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += CROCKFORD[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    output += CROCKFORD[(buffer << (5 - bits)) & 0x1f];
  }
  return output;
}
