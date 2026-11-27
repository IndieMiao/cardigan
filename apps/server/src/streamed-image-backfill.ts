import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  type Attachment,
  type AttachmentId,
  IMAGE_SIGNATURE_BYTES,
  imageMatchesMime,
  isInlineImageMime,
  MAX_INLINE_STREAMED_IMAGE_BYTES,
} from "@cardigan/domain";
import { artifactPath } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

/** What one pass decided; `skipped` files were not readable on this host. */
export interface StreamedImageBackfill {
  readonly inline: number;
  readonly download: number;
  readonly skipped: number;
}

/**
 * C-819: a live streamed upload of a bitmap type that predates the C-809
 * check, so it has no `inline_image` verdict yet.
 */
function unchecked(a: Attachment): boolean {
  const stream = a.streamed_artifact;
  return (
    stream !== undefined &&
    !stream.expired &&
    stream.inline_image === undefined &&
    isInlineImageMime(a.mime)
  );
}

/** The file's leading bytes, or `undefined` when this host cannot read it. */
async function leadingBytes(
  dataDir: string,
  a: Attachment,
): Promise<Uint8Array | undefined> {
  const blob = a.streamed_artifact?.blob_id;
  if (blob === undefined) return undefined;
  try {
    const file = await open(
      artifactPath(dataDir, blob),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== a.size) return undefined;
      const header = Buffer.alloc(Math.min(a.size, IMAGE_SIGNATURE_BYTES));
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      return new Uint8Array(header.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * C-819: give streamed uploads from before C-809 the verdict a new upload
 * gets — `inline_image: true` when the file starts like its declared bitmap
 * type and fits the inline ceiling, `false` otherwise. The display rule is
 * unchanged. Only records without a verdict are read, so a second pass only
 * revisits files that were missing (they are never restored from off-site
 * here); the write re-checks the record inside its transaction.
 */
export async function backfillStreamedInlineImages(
  store: Pick<Store, "uow" | "listProjects">,
  dataDir: string,
): Promise<StreamedImageBackfill> {
  let inline = 0,
    download = 0,
    skipped = 0;
  for (const project of store.listProjects()) {
    const pending = store.uow.read((tx) =>
      tx.attachments.list(project.id).filter(unchecked),
    );
    if (!pending.length) continue;
    const verdicts = new Map<AttachmentId, { blob: string; inline: boolean }>();
    for (const a of pending) {
      const header = await leadingBytes(dataDir, a);
      if (header === undefined) {
        skipped++;
        continue;
      }
      verdicts.set(a.id, {
        blob: a.streamed_artifact?.blob_id ?? "",
        inline:
          a.size <= MAX_INLINE_STREAMED_IMAGE_BYTES &&
          imageMatchesMime(header, a.mime),
      });
    }
    if (!verdicts.size) continue;
    const written = store.uow.run((tx) => {
      const decided: boolean[] = [];
      for (const [id, verdict] of verdicts) {
        const current = tx.attachments.get(project.id, id);
        const stream = current?.streamed_artifact;
        // Expired or already decided since the read: leave it alone.
        if (!current || !stream || !unchecked(current)) continue;
        if (stream.blob_id !== verdict.blob) continue;
        tx.attachments.put(project.id, {
          ...current,
          streamed_artifact: { ...stream, inline_image: verdict.inline },
        });
        decided.push(verdict.inline);
      }
      return decided;
    });
    for (const verdict of written) {
      if (verdict) inline++;
      else download++;
    }
  }
  return { inline, download, skipped };
}
