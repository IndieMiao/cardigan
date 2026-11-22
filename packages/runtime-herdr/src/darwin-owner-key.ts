import {
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  type KeyObject,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import { link, open, rm } from "node:fs/promises";
import { join } from "node:path";

/** One host-private seed in the 0600 data directory; no per-session key is stored. */
export const DARWIN_OWNER_SEED = "darwin-idle-owner.seed";
const SALT = "cardigan/darwin-idle-owner/v1";
// P-256 group order: a derived scalar must lie in [1, n).
const ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);

async function readSeed(path: string) {
  // Never follow a substituted link or read a shared, foreign or truncated seed.
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const entry = await handle.stat();
    if (
      !entry.isFile() ||
      entry.nlink !== 1 ||
      entry.uid !== process.getuid?.() ||
      (entry.mode & 0o077) !== 0 ||
      entry.size !== 32
    )
      throw new Error("Unverified Darwin owner seed");
    const seed = Buffer.alloc(32);
    const { bytesRead } = await handle.read(seed, 0, 32, 0);
    if (bytesRead !== 32) throw new Error("Unverified Darwin owner seed");
    return seed;
  } finally {
    await handle.close();
  }
}

async function createSeed(dataDir: string, path: string) {
  const temp = join(dataDir, `.${DARWIN_OWNER_SEED}.${randomUUID()}`);
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
    // link() never replaces: a concurrent creator wins and both use its seed.
    await link(temp, path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
  } finally {
    await rm(temp, { force: true });
  }
  return readSeed(path);
}

async function seed(dataDir: string, create: boolean) {
  const path = join(dataDir, DARWIN_OWNER_SEED);
  try {
    return await readSeed(path);
  } catch (err) {
    // An existing but unverifiable seed is never replaced: that would
    // silently orphan every enrolled owner. Only a missing seed is created.
    if (!create || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return createSeed(dataDir, path);
  }
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Rebuild the same enrollment key after any restart; rejects when the seed is unavailable. */
export async function darwinOwnerKey(
  dataDir: string,
  enrollment: string,
  create = false,
): Promise<{ privateKey: KeyObject; publicKey: KeyObject; id: string }> {
  const material = await seed(dataDir, create);
  for (let counter = 0; ; counter++) {
    const d = Buffer.from(
      hkdfSync(
        "sha256",
        material,
        SALT,
        JSON.stringify([enrollment, counter]),
        32,
      ),
    );
    const scalar = BigInt(`0x${d.toString("hex")}`);
    if (scalar === 0n || scalar >= ORDER) continue;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    const point = ecdh.getPublicKey();
    const privateKey = createPrivateKey({
      key: {
        kty: "EC",
        crv: "P-256",
        d: b64url(d),
        x: b64url(point.subarray(1, 33)),
        y: b64url(point.subarray(33, 65)),
      },
      format: "jwk",
    });
    const publicKey = createPublicKey(privateKey);
    return {
      privateKey,
      publicKey,
      id: darwinOwnerKeyId(publicKey),
    };
  }
}

/** Same digest the worker-side owner reports with each challenge. */
export const darwinOwnerKeyId = (publicKey: KeyObject) =>
  createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
