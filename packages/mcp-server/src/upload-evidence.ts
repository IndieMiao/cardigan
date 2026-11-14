import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MAX_ATTACHMENT_BYTES } from "./attachments.js";

interface EvidenceInput {
  readonly file: string;
  readonly card_id: string;
  readonly delivery_id: string;
  readonly mime: string;
  readonly note?: string;
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
    throw new Error(
      "Evidence must be a readable, stable regular file up to 10 MiB (no symlinks).",
    );
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  const result = await client.callTool({
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
  });
  const data = result.structuredContent as Record<string, unknown> | undefined;
  if (result.isError)
    throw new Error(
      "Evidence upload was rejected by Card MCP; check this assignment's tool permission and delivery/card target.",
    );
  if (
    typeof data?.id !== "string" ||
    data.sha256 !== sha256 ||
    data.size !== content.length ||
    data.card_id !== input.card_id
  )
    throw new Error("Card MCP did not confirm the uploaded evidence.");
  return data.id;
}

export async function uploadEvidenceSession(
  endpoint: string,
  input: EvidenceInput,
  token: string,
): Promise<string> {
  if (!token.trim()) throw new Error("A session credential is required");
  const client = new Client({ name: "cardigan-evidence-upload", version: "1" });
  try {
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid Card MCP URL");
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          redirect: "error",
          headers: { Authorization: `Bearer ${token}` },
        },
      }),
    );
    return await uploadEvidenceFile(client, input);
  } finally {
    await client.close();
  }
}

async function main() {
  // Credentials come only from the launch environment, never argv or a DB.
  const [endpoint, card_id, delivery_id, file, mime = "image/png"] =
    process.argv.slice(2);
  if (!endpoint || !card_id || !delivery_id || !file || !process.env.MCP_TOKEN)
    throw new Error(
      "Usage: upload-evidence <configured-mcp-url> <card-id> <delivery-id> <file> [mime]; requires this session's MCP_TOKEN.",
    );
  const id = await uploadEvidenceSession(
    endpoint,
    { file, card_id, delivery_id, mime },
    process.env.MCP_TOKEN,
  );
  process.stdout.write(`${id}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(() => {
    // SDK/network errors can contain request details; never echo them or argv.
    process.stderr.write(
      "Evidence upload failed; check the configured Card MCP URL, inherited credential, target and local file. No evidence ID was confirmed.\n",
    );
    process.exitCode = 1;
  });
}
