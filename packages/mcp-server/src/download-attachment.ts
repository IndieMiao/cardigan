import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_ATTACHMENT_BYTES, sha256 } from "./attachments.js";

const messages = {
  arguments:
    "Provide the configured Card MCP URL, attachment ID and new local file.",
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
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new AttachmentDownloadError("download");
  }
  const sizeText = response.headers.get("content-length");
  const size = Number(sizeText);
  const digest = response.headers.get("x-attachment-sha256") ?? "";
  let content: Buffer;
  try {
    if (!response.ok) throw new AttachmentDownloadError("download");
    if (
      sizeText === null ||
      !/^\d+$/u.test(sizeText) ||
      !Number.isSafeInteger(size) ||
      size > MAX_ATTACHMENT_BYTES ||
      !/^[a-f0-9]{64}$/u.test(digest) ||
      response.headers.get("x-attachment-id") !== attachmentId ||
      !response.body
    )
      throw new AttachmentDownloadError("integrity");
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > size) throw new AttachmentDownloadError("integrity");
      chunks.push(chunk);
    }
    content = Buffer.concat(chunks);
    if (content.length !== size || sha256(content) !== digest)
      throw new AttachmentDownloadError("integrity");
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error instanceof AttachmentDownloadError
      ? error
      : new AttachmentDownloadError("download");
  }
  try {
    await writeFile(file, content, { flag: "wx", mode: 0o600 });
  } catch {
    throw new AttachmentDownloadError("file");
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
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof AttachmentDownloadError ? error.message : new AttachmentDownloadError("download").message}\n`,
    );
    process.exitCode = 1;
  });
}
