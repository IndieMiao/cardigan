import { createPublicKey, sign, verify } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DARWIN_OWNER_SEED, darwinOwnerKey } from "./darwin-owner-key.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), "darwin-owner-key-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pem = (k: Awaited<ReturnType<typeof darwinOwnerKey>>) =>
  k.publicKey.export({ type: "spki", format: "pem" });

test("the same enrollment key is rebuilt from the private seed only", async () => {
  await expect(darwinOwnerKey(dir, "e1")).rejects.toThrow();
  const first = await darwinOwnerKey(dir, "e1", true);
  const seed = join(dir, DARWIN_OWNER_SEED);
  expect(statSync(seed).mode & 0o777).toBe(0o600);
  expect(statSync(seed).size).toBe(32);
  const again = await darwinOwnerKey(dir, "e1");
  expect(pem(again)).toBe(pem(first));
  expect(again.id).toBe(first.id);
  expect(first.id).toMatch(/^[a-f0-9]{64}$/u);
  // Each enrollment has its own key; the seed never changes once created.
  const material = readFileSync(seed);
  const other = await darwinOwnerKey(dir, "e2", true);
  expect(pem(other)).not.toBe(pem(first));
  expect(readFileSync(seed)).toEqual(material);
  // Signatures verify with the public key the owner received at launch.
  const signature = sign("sha256", Buffer.from("m"), again.privateKey);
  expect(
    verify("sha256", Buffer.from("m"), createPublicKey(pem(first)), signature),
  ).toBe(true);
  expect(again.privateKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
});

test("concurrent creators share one seed", async () => {
  const keys = await Promise.all(
    Array.from({ length: 8 }, () => darwinOwnerKey(dir, "e1", true)),
  );
  expect(new Set(keys.map(pem)).size).toBe(1);
});

test("an unverifiable seed is refused and never replaced", async () => {
  const seed = join(dir, DARWIN_OWNER_SEED);
  const bad = Buffer.alloc(32, 1);
  for (const setup of [
    () => {
      writeFileSync(seed, bad);
      chmodSync(seed, 0o640);
    },
    () => writeFileSync(seed, Buffer.alloc(31), { mode: 0o600 }),
    () => {
      writeFileSync(join(dir, "elsewhere"), bad, { mode: 0o600 });
      symlinkSync(join(dir, "elsewhere"), seed);
    },
    () => {
      writeFileSync(seed, bad, { mode: 0o600 });
      linkSync(seed, join(dir, "second-link"));
    },
  ]) {
    rmSync(join(dir, "elsewhere"), { force: true });
    rmSync(join(dir, "second-link"), { force: true });
    rmSync(seed, { force: true });
    setup();
    const before = readFileSync(seed);
    await expect(darwinOwnerKey(dir, "e1", true)).rejects.toThrow();
    expect(readFileSync(seed)).toEqual(before);
  }
});
