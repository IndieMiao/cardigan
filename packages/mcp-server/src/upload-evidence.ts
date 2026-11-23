import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { type ErrorCode, errorCodes } from "@cardigan/domain";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isCliEntry } from "./cli-entry.js";
import { MAX_ATTACHMENT_BYTES } from "./limits.js";

interface EvidenceInput {
  readonly file: string;
  readonly card_id: string;
  readonly delivery_id: string;
  readonly mime: string;
  readonly note?: string;
}

const FAILURE_MESSAGES = {
  arguments:
    "Usage: upload-evidence <configured Card MCP URL> <card ID> <delivery ID> <file> [MIME type] (MCP_TOKEN from the environment).",
  credential: "A session credential is required.",
  endpoint: "Invalid Card MCP URL; use HTTP(S) without URL credentials.",
  file: "Evidence must be a readable, stable regular file up to 10 MiB (no symlinks).",
  connection:
    "Could not connect to Card MCP; check the configured address and session credential.",
  upload:
    "Card MCP did not complete the upload; check the target, permission and connection.",
  receipt: "Card MCP did not confirm the uploaded evidence.",
  internal: "The upload could not be completed.",
} as const;

/** Only fixed local text and allowlisted domain codes may reach CLI stderr. */
class EvidenceUploadError extends Error {
  constructor(stage: keyof typeof FAILURE_MESSAGES, code?: ErrorCode) {
    super(
      `Evidence upload failed [${stage}${code ? `:${code}` : ""}]: ${FAILURE_MESSAGES[stage]} No evidence ID was confirmed.`,
    );
  }
}

/** Local client helper: paths never reach the server; the existing token/tool
 * and card scope still authorize the upload. Never print image bytes or tokens. */
export async function uploadEvidenceFile(client: Client, input: EvidenceInput) {
  let content: Buffer;
  try {
    const file = await open(
      input.file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES)
        throw new Error("Invalid evidence file");
      const buffer = Buffer.alloc(info.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, size);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      if (size !== info.size) throw new Error("Evidence changed during read");
      content = buffer.subarray(0, size);
    } finally {
      await file.close();
    }
  } catch {
    throw new EvidenceUploadError("file");
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  const result = await client
    .callTool({
      name: "upload_attachment",
      arguments: {
        idempotency_key: randomUUID(),
        card_id: input.card_id,
        file: content.toString("base64"),
        sha256,
        mime: input.mime,
        original_filename: basename(input.file),
        ...(input.note === undefined ? {} : { note: input.note }),
        kind: "evidence",
        attach_to: { kind: "delivery", id: input.delivery_id },
      },
    })
    .catch(() => {
      throw new EvidenceUploadError("upload");
    });
  const data = result.structuredContent as Record<string, unknown> | undefined;
  if (result.isError) {
    const error = data?.error;
    const code =
      error && typeof error === "object" && "code" in error
        ? errorCodes.find((code) => code === error.code)
        : undefined;
    throw new EvidenceUploadError("upload", code);
  }
  if (
    typeof data?.id !== "string" ||
    data.sha256 !== sha256 ||
    data.size !== content.length ||
    data.card_id !== input.card_id
  )
    throw new EvidenceUploadError("receipt");
  return data.id;
}

export async function uploadEvidenceSession(
  endpoint: string,
  input: EvidenceInput,
  token: string,
): Promise<string> {
  if (!token.trim()) throw new EvidenceUploadError("credential");
  let url: URL;
  try {
    url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid URL");
  } catch {
    throw new EvidenceUploadError("endpoint");
  }
  const client = new Client({ name: "cardigan-evidence-upload", version: "1" });
  try {
    await client
      .connect(
        new StreamableHTTPClientTransport(url, {
          // SDK 1.32.2 constructs SSE GET options separately from requestInit
          // and may follow same-origin redirects itself. Never return a redirect
          // response to the SDK, on any transport request (including reconnects).
          fetch: (resource, init) =>
            fetch(resource, { ...init, redirect: "error" }),
          requestInit: {
            headers: { Authorization: `Bearer ${token}` },
          },
        }),
      )
      .catch(() => {
        throw new EvidenceUploadError("connection");
      });
    return await uploadEvidenceFile(client, input);
  } finally {
    // Cleanup must not replace a safe upload diagnostic with an SDK error.
    await client.close().catch(() => undefined);
  }
}

async function main() {
  // Credentials come only from the launch environment, never argv or a DB.
  const [endpoint, card_id, delivery_id, file, mime = "image/png"] =
    process.argv.slice(2);
  if (!endpoint || !card_id || !delivery_id || !file)
    throw new EvidenceUploadError("arguments");
  const id = await uploadEvidenceSession(
    endpoint,
    { file, card_id, delivery_id, mime },
    process.env.MCP_TOKEN ?? "",
  );
  process.stdout.write(`${id}\n`);
}

/** Runs the command line tool; also the entry of the prebuilt agent tool. */
export function runUploadEvidenceCli() {
  main().catch((error: unknown) => {
    // SDK/network errors can contain request details; never echo them or argv.
    process.stderr.write(
      `${error instanceof EvidenceUploadError ? error.message : new EvidenceUploadError("internal").message}\n`,
    );
    process.exitCode = 1;
  });
}
if (isCliEntry(import.meta.url)) runUploadEvidenceCli();
