import type { Attachment } from "@cardigan/domain";
import { ATTACHMENT_EXTENSIONS } from "./attachments.js";
import { ToolError } from "./errors.js";

export const DEFAULT_ATTACHMENT_INLINE_BYTES = 65536;
export const MAX_ATTACHMENT_INLINE_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_PAGE_BYTES = 65536;

export function resolveAttachmentInlineBytes(
  value = DEFAULT_ATTACHMENT_INLINE_BYTES,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_ATTACHMENT_INLINE_BYTES
  )
    throw new Error(
      "CARDIGAN_ATTACHMENT_INLINE_BYTES must be an integer from 0 to 1048576",
    );
  return value;
}

export function attachmentFilename(
  attachment: Pick<Attachment, "id" | "mime" | "original_filename">,
): string {
  const name = attachment.original_filename?.split(/[\\/]/u).at(-1);
  if (
    name &&
    [...name].length <= 200 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)
  )
    return name;
  const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return `${attachment.id.replace(/[^A-Za-z0-9._-]/gu, "_")}.${ATTACHMENT_EXTENSIONS[mime] ?? "bin"}`;
}

function isText(content: Uint8Array, mime: string): boolean {
  const [type = "", ...parameters] = mime
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  if (
    !(
      type.startsWith("text/") ||
      [
        "application/json",
        "application/xml",
        "application/javascript",
        "image/svg+xml",
      ].includes(type) ||
      /^application\/[\w.+-]+\+(json|xml)$/u.test(type)
    )
  )
    return false;
  for (const parameter of parameters) {
    if (
      /^charset\s*=/u.test(parameter) &&
      !/^charset\s*=\s*"?(utf-8|utf8|us-ascii)"?$/u.test(parameter)
    )
      return false;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    // MIME is not evidence of text: reject NUL, binary controls and invalid UTF-8.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: binary detection deliberately checks control bytes.
    return !/[\x00-\x08\x0b\x0e-\x1f\x7f-\x9f]/u.test(text);
  } catch {
    return false;
  }
}

export function attachmentPreview(
  attachment: Attachment,
  content: Uint8Array,
  threshold: number,
  page: { offset?: number | undefined; limit?: number | undefined },
) {
  const text = isText(content, attachment.mime);
  const metadata = {
    attachment_id: attachment.id,
    card_id: attachment.card_id,
    filename: attachmentFilename(attachment),
    sha256: attachment.sha256,
    size: attachment.size,
    mime: attachment.mime,
    text_available: text,
    inline_max_bytes: threshold,
    page_max_bytes: MAX_ATTACHMENT_PAGE_BYTES,
    download: {
      method: "GET",
      query: { attachment_id: attachment.id },
      instructions:
        '在本会话已配置的 Card MCP 地址追加 attachment_id 查询参数，使用当前会话 Bearer Token 下载到本地文件；不要输出正文或凭据。可运行受管机器预装的 node "$CARDIGAN_AGENT_TOOLS/download-attachment.mjs" <已配置的Card-MCP地址> <附件编号> <新本地文件>（Cardigan 仓库也可用已构建的 packages/mcp-server/dist/download-attachment.js），助手仅从环境继承 MCP_TOKEN。元数据不等于已阅读证据。',
    },
  };
  if (!text) return { ...metadata, content_mode: "metadata", reason: "binary" };
  if (page.offset === undefined && page.limit === undefined) {
    return content.length > threshold
      ? { ...metadata, content_mode: "metadata", reason: "size" }
      : {
          ...metadata,
          content_mode: "inline",
          encoding: "base64",
          file: Buffer.from(content).toString("base64"),
        };
  }
  const offset = page.offset ?? 0;
  const limit = page.limit ?? MAX_ATTACHMENT_PAGE_BYTES;
  const continuation = (index: number) =>
    ((content[index] ?? 0) & 0xc0) === 0x80;
  if (offset > content.length || continuation(offset))
    throw ToolError.validation(
      "offset must be within the file at a UTF-8 character boundary",
    );
  let end = Math.min(offset + limit, content.length);
  while (end > offset && end < content.length && continuation(end)) end--;
  if (end === offset && offset < content.length)
    throw ToolError.validation(
      "limit is too small for the next UTF-8 character",
    );
  return {
    ...metadata,
    content_mode: "page",
    encoding: "base64",
    file: Buffer.from(content.subarray(offset, end)).toString("base64"),
    offset,
    bytes_read: end - offset,
    next_offset: end,
    eof: end === content.length,
  };
}
