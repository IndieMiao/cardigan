import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, link, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isCliEntry } from "./cli-entry.js";
import { MAX_ARTIFACT_BYTES, MAX_ATTACHMENT_BYTES } from "./limits.js";

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

const SIGNED_TYPE = "application/vnd.cardigan.signed-download+json";
/** Statuses after which the plain Card MCP channel is tried once more. */
const RETRY_PLAIN = new Set([408, 429, 500, 502, 503, 504]);

interface Expected {
  readonly size: number;
  readonly digest: string;
  readonly artifact: boolean;
}

/** Stream `body` into a new private file next to `file`, verify, then link. */
async function save(
  body: ReadableStream<Uint8Array>,
  file: string,
  expected: Expected,
) {
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600).catch(() => {
      throw new AttachmentDownloadError("file");
    });
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of body) {
      received += chunk.byteLength;
      if (received > expected.size)
        throw new AttachmentDownloadError("integrity");
      hash.update(chunk);
      await handle.writeFile(chunk).catch(() => {
        throw new AttachmentDownloadError("file");
      });
    }
    if (received !== expected.size || hash.digest("hex") !== expected.digest)
      throw new AttachmentDownloadError("integrity");
    await link(temporary, file).catch(() => {
      throw new AttachmentDownloadError("file");
    });
  } finally {
    if (handle) {
      await handle.close();
      await rm(temporary, { force: true });
    }
  }
}

/** Identity the Card MCP response vouches for; the bytes must match it. */
function expectedFrom(
  response: Response,
  attachmentId: string,
  sizeText: string | null,
): Expected {
  const size = Number(sizeText);
  const digest = response.headers.get("x-attachment-sha256") ?? "";
  const artifact = response.headers.get("x-artifact-size") === sizeText;
  if (
    sizeText === null ||
    !/^\d+$/u.test(sizeText) ||
    !Number.isSafeInteger(size) ||
    size > (artifact ? MAX_ARTIFACT_BYTES : MAX_ATTACHMENT_BYTES) ||
    !/^[a-f0-9]{64}$/u.test(digest) ||
    response.headers.get("x-attachment-id") !== attachmentId
  )
    throw new AttachmentDownloadError("integrity");
  return { size, digest, artifact };
}

/**
 * C-614: fetch a signed off-site URL without any Cardigan credential. Any
 * failure (expired URL, network, wrong bytes) returns undefined so the caller
 * falls back to the Card MCP channel; an existing destination is never
 * touched.
 */
async function fromSignedUrl(
  response: Response,
  attachmentId: string,
  file: string,
): Promise<Expected | undefined> {
  try {
    const expected = expectedFrom(
      response,
      attachmentId,
      response.headers.get("x-attachment-size"),
    );
    const text = await response.text();
    if (text.length > 16384) return undefined;
    const target = new URL(
      (JSON.parse(text) as { url?: unknown }).url as string,
    );
    if (
      !(
        target.protocol === "https:" ||
        (target.protocol === "http:" && target.hostname === "127.0.0.1")
      ) ||
      target.username ||
      target.password
    )
      return undefined;
    const download = await fetch(target, {
      redirect: "error",
      signal: AbortSignal.timeout(60 * 60_000),
    });
    if (
      !download.ok ||
      !download.body ||
      download.headers.get("content-length") !== String(expected.size)
    ) {
      await download.body?.cancel().catch(() => undefined);
      return undefined;
    }
    try {
      await save(download.body, file, expected);
      return expected;
    } catch (error) {
      await download.body.cancel().catch(() => undefined);
      // An existing or unwritable destination fails the same way on fallback.
      if (
        error instanceof AttachmentDownloadError &&
        error.message.includes("[file]")
      )
        throw error;
      return undefined;
    }
  } catch (error) {
    if (
      error instanceof AttachmentDownloadError &&
      error.message.includes("[file]")
    )
      throw error;
    return undefined;
  }
}

/** Saves bytes outside model context. Never discovers credentials, accepts a
 * server-supplied destination, follows redirects, or falls back to human auth.
 * Offers to take a signed off-site URL first and falls back to Card MCP bytes. */
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
  const request = async (signed: boolean) => {
    try {
      return await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(signed ? { "X-Cardigan-Download": "signed-url" } : {}),
        },
        // Never followed. With the offer a redirect comes back as a response
        // (and fails below without a retry); a thrown error is then only a
        // connection failure, which the plain channel may not repeat.
        redirect: signed ? "manual" : "error",
        signal: AbortSignal.timeout(60 * 60_000),
      });
    } catch {
      throw new AttachmentDownloadError("download");
    }
  };
  // C-614: the signed-URL offer is optional. If asking for it fails in a way
  // the plain channel may not (connection, timeout, server or rate-limit
  // error), ask once more without it, with the same credential and checks.
  let response: Response;
  try {
    response = await request(true);
  } catch {
    response = await request(false);
  }
  if (RETRY_PLAIN.has(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    response = await request(false);
  } else if (
    response.ok &&
    response.headers.get("content-type") === SIGNED_TYPE
  ) {
    const reference = response.headers.has("x-source-card-id");
    const saved = await fromSignedUrl(response, attachmentId, file);
    if (saved)
      return {
        attachment_id: attachmentId,
        sha256: saved.digest,
        size: saved.size,
        reference_only: reference,
        via: "offsite" as const,
      };
    response = await request(false);
  }
  let expected: Expected;
  try {
    if (!response.ok) throw new AttachmentDownloadError("download");
    expected = expectedFrom(
      response,
      attachmentId,
      response.headers.get("content-length"),
    );
    if (!response.body) throw new AttachmentDownloadError("integrity");
    await save(response.body, file, expected);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error instanceof AttachmentDownloadError
      ? error
      : new AttachmentDownloadError("download");
  }
  return {
    attachment_id: attachmentId,
    sha256: expected.digest,
    size: expected.size,
    reference_only: response.headers.has("x-source-card-id"),
    via: "card_mcp" as const,
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
