import {
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "@cardigan/store";

// A completed reader normally retires entirely in SQLite. Only a failed write needs
// this receipt. Keep it beside the host DB so another CLI/process can replay it even
// if the original Store has closed. It carries hints, never permission to finish.
const memory = new WeakMap<Store, Map<string, readonly number[]>>();
export interface ScanTicket {
  readonly id: string;
  readonly verifier: string;
}
// The journal commits to this reader's public key before listing. A file named
// after a visible scan ID is not in itself proof that the live reader stopped.
function makeSigner() {
  return generateKeyPairSync("ed25519");
}
let signer: ReturnType<typeof makeSigner> | undefined;
export function issueScanTicket(): ScanTicket {
  signer ??= makeSigner();
  return {
    id: randomUUID(),
    verifier: signer.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
}
function payload(id: string, ids: readonly number[]) {
  return Buffer.from(JSON.stringify([id, ids]));
}
function receiptPath(store: Store, id: string) {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u.test(id))
    throw new Error("Invalid scan ID");
  const db = store.database.location();
  return db && join(dirname(db), `.cardigan-scan-${id}.json`);
}
export function recordCompletedScan(
  store: Store,
  id: string,
  ids: readonly number[],
) {
  const path = receiptPath(store, id);
  if (!path) {
    const receipts = memory.get(store) ?? new Map();
    receipts.set(id, ids);
    memory.set(store, receipts);
    return;
  }
  if (!signer) throw new Error("No scan owner");
  const signature = sign(null, payload(id, ids), signer.privateKey).toString(
    "base64",
  );
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ id, ids, signature }), {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
export function completedScan(
  store: Store,
  { id, verifier }: ScanTicket,
): readonly number[] | undefined {
  const path = receiptPath(store, id);
  if (!path) return memory.get(store)?.get(id);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || (file.mode & 0o077) !== 0 || file.size > 256)
      throw new Error("Invalid scan receipt");
    const bytes = Buffer.alloc(file.size);
    if (readSync(fd, bytes) !== bytes.length)
      throw new Error("Incomplete scan receipt");
    const receipt = JSON.parse(bytes.toString("utf8"));
    if (
      receipt?.id !== id ||
      !Array.isArray(receipt.ids) ||
      receipt.ids.length > 2 ||
      !receipt.ids.every(
        (n: unknown) =>
          typeof n === "number" && Number.isSafeInteger(n) && n > 0,
      )
    )
      throw new Error("Invalid scan receipt");
    const publicKey = createPublicKey({
      key: Buffer.from(verifier, "base64"),
      type: "spki",
      format: "der",
    });
    if (
      typeof receipt.signature !== "string" ||
      !verify(
        null,
        payload(id, receipt.ids),
        publicKey,
        Buffer.from(receipt.signature, "base64"),
      )
    )
      throw new Error("Unverified scan receipt");
    return receipt.ids;
  } finally {
    closeSync(fd);
  }
}
export function discardCompletedScan(store: Store, id: string) {
  // The receipt was already imported transactionally. A leftover is inert: scan IDs are never reused.
  const path = receiptPath(store, id);
  if (!path) memory.get(store)?.delete(id);
  else {
    try {
      rmSync(path, { force: true });
    } catch {
      /* don't abandon a newly committed lease */
    }
  }
}
