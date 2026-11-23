import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Attachment } from "@cardigan/domain";
import { ToolError } from "./errors.js";
import { MAX_ARTIFACT_BYTES } from "./limits.js";
import { offsiteFor } from "./offsite/offsite.js";

export { MAX_ARTIFACT_BYTES };
export const ARTIFACT_BLOB_ID =
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
export function artifactPath(dataDir: string | undefined, id: string) {
  if (!ARTIFACT_BLOB_ID.test(id))
    throw ToolError.validation("Invalid artifact blob ID");
  return join(
    resolve(dataDir ?? process.env.CARDIGAN_DATA_DIR ?? ".data"),
    "artifacts",
    id,
  );
}

/** Private, unaddressable until the caller commits the verified receipt. */
export async function receiveArtifact(
  source: Readable,
  dir: string | undefined,
  size: number,
  digest: string,
  noteProgress: () => void,
) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARTIFACT_BYTES)
    throw ToolError.validation("Invalid artifact size");
  const id = randomUUID(),
    path = artifactPath(dir, id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!(await lstat(dirname(path))).isDirectory())
    throw ToolError.validation("Invalid artifact directory");
  const file = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    await pipeline(
      source,
      new Transform({
        transform(chunk: Buffer, _encoding, cb) {
          bytes += chunk.length;
          if (bytes > size)
            return cb(ToolError.validation("Artifact size exceeded"));
          noteProgress();
          hash.update(chunk);
          cb(null, chunk);
        },
      }),
      file.createWriteStream(),
    );
    const sha256 = hash.digest("hex");
    if (bytes !== size || sha256 !== digest)
      throw ToolError.validation("Artifact size or sha256 mismatch");
    return { id, size: bytes, sha256 };
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  } finally {
    await file.close();
  }
}

export async function openArtifact(dir: string | undefined, a: Attachment) {
  const blob = a.streamed_artifact;
  if (!blob || blob.expired)
    throw ToolError.notFound("Artifact is not available");
  const path = artifactPath(dir, blob.blob_id);
  const flags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const unavailable = () => ToolError.notFound("Artifact content unavailable");
  const file = await open(path, flags).catch(
    async (error: NodeJS.ErrnoException) => {
      // C-614: a file gone locally is restored from its verified off-site
      // copy first; without one the result is unchanged.
      if (
        error.code !== "ENOENT" ||
        !(await offsiteFor(dir)?.restoreArtifact(
          path,
          blob.blob_id,
          a.size,
          a.sha256,
        ))
      )
        throw unavailable();
      return open(path, flags).catch(() => {
        throw unavailable();
      });
    },
  );
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size !== a.size || a.size > MAX_ARTIFACT_BYTES)
      throw ToolError.validation("Artifact size mismatch");
    return file;
  } catch (err) {
    await file.close();
    throw err;
  }
}

export async function verifyArtifact(
  dir: string | undefined,
  a: Attachment,
  expected: string,
) {
  if (a.sha256 !== expected)
    throw ToolError.validation("Artifact sha256 mismatch");
  const file = await openArtifact(dir, a);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of file.createReadStream({ end: a.size })) {
      bytes += chunk.length;
      hash.update(chunk);
    }
  } catch {
    throw ToolError.validation("Stored artifact could not be verified");
  } finally {
    await file.close();
  }
  if (bytes !== a.size || hash.digest("hex") !== expected)
    throw ToolError.validation("Stored artifact size or sha256 mismatch");
}

export async function sendArtifact(
  dir: string | undefined,
  a: Attachment,
  res: ServerResponse,
  head: boolean,
  authorize?: () => void,
) {
  const file = await openArtifact(dir, a);
  try {
    authorize?.();
    const name = (a.original_filename || `${a.id}.bin`).replace(
      /[^a-zA-Z0-9._-]/gu,
      "_",
    );
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": a.size,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Attachment-Id": a.id,
      "X-Attachment-Sha256": a.sha256,
      "X-Artifact-Size": a.size,
    });
    if (head || !a.size) res.end();
    else await pipeline(file.createReadStream({ end: a.size - 1 }), res);
  } finally {
    await file.close();
  }
}
