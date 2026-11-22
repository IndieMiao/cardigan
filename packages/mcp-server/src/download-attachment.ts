import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, link, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_ARTIFACT_BYTES } from "./artifact-files.js";
import { MAX_ATTACHMENT_BYTES } from "./attachments.js";
import { isCliEntry } from "./cli-entry.js";

const messages = {
  arguments:
    "Usage: download-attachment <configured Card MCP URL> <attachment ID> <new local file> (MCP_TOKEN from the environment).",
  credential: "The current session MCP_TOKEN is required.",
  endpoint:
    "Use the configured HTTP(S) Card MCP URL without credentials, query or fragment.",
  download:
    "Could not download; check the current token, attachment permission and connection.",
  integrity: "Attachment identity, size or checksum could not be verified.",
  file: "Could not create a new local file; existing files are never overwritten.",
} as const;
class AttachmentDownloadError extends Error {
  constructor(stage: keyof typeof messages) {
    super(`Attachment download failed [${stage}]: ${messages[stage]}`);
  }
}

/** Saves bytes outside model context. Never discovers credentials, accepts a
 * server-supplied destination, follows redirects, or falls back to human auth. */
export async function downloadAttachment(
  endpoint: string,
  attachmentId: string,
  file: string,
  token: string,
) {
  if (!token.trim()) throw new AttachmentDownloadError("credential");
  if (!attachmentId || !file) throw new AttachmentDownloadError("arguments");
  let url: URL;
  try {
    url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    url.searchParams.set("attachment_id", attachmentId);
  } catch {
    throw new AttachmentDownloadError("endpoint");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(60 * 60_000),
    });
  } catch {
    throw new AttachmentDownloadError("download");
  }
  const sizeText = response.headers.get("content-length");
  const size = Number(sizeText);
  const digest = response.headers.get("x-attachment-sha256") ?? "";
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    if (!response.ok) throw new AttachmentDownloadError("download");
    if (
      sizeText === null ||
      !/^\d+$/u.test(sizeText) ||
      !Number.isSafeInteger(size) ||
      size >
        (response.headers.get("x-artifact-size") === sizeText
          ? MAX_ARTIFACT_BYTES
          : MAX_ATTACHMENT_BYTES) ||
      !/^[a-f0-9]{64}$/u.test(digest) ||
      response.headers.get("x-attachment-id") !== attachmentId ||
      !response.body
    )
      throw new AttachmentDownloadError("integrity");
    handle = await open(temporary, "wx", 0o600).catch(() => {
      throw new AttachmentDownloadError("file");
    });
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > size) throw new AttachmentDownloadError("integrity");
      hash.update(chunk);
      await handle.writeFile(chunk).catch(() => {
        throw new AttachmentDownloadError("file");
      });
    }
    if (received !== size || hash.digest("hex") !== digest)
      throw new AttachmentDownloadError("integrity");
    await link(temporary, file).catch(() => {
      throw new AttachmentDownloadError("file");
    });
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error instanceof AttachmentDownloadError
      ? error
      : new AttachmentDownloadError("download");
  } finally {
    if (handle) {
      await handle.close();
      await rm(temporary, { force: true });
    }
  }
  return {
    attachment_id: attachmentId,
    sha256: digest,
    size,
    reference_only: response.headers.has("x-source-card-id"),
  };
}

async function main() {
  const [endpoint, id, file, ...rest] = process.argv.slice(2);
  if (!endpoint || !id || !file || rest.length)
    throw new AttachmentDownloadError("arguments");
  const result = await downloadAttachment(
    endpoint,
    id,
    file,
    process.env.MCP_TOKEN ?? "",
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
/** Runs the command line tool; also the entry of the prebuilt agent tool. */
export function runDownloadAttachmentCli() {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof AttachmentDownloadError ? error.message : new AttachmentDownloadError("download").message}\n`,
    );
    process.exitCode = 1;
  });
}
if (isCliEntry(import.meta.url)) runDownloadAttachmentCli();
