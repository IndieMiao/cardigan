import { createHmac } from "node:crypto";
import type {
  ExtMessage,
  ExtMessageEntry,
  ExtMessagePort,
} from "@cardigan/domain";

interface FeishuCredential {
  readonly webhook: string;
  readonly secret?: string;
}

/** Called only for enabled channels, after the host has read its private file. */
export function parseFeishuCredential(
  credential: string | undefined,
): FeishuCredential {
  try {
    const value: unknown = JSON.parse(credential ?? "");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    const data = value as Record<string, unknown>;
    if (typeof data.webhook !== "string") throw new Error();
    const url = new URL(data.webhook);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "open.feishu.cn" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9_-]+$/u.test(url.pathname) ||
      url.href !== data.webhook
    )
      throw new Error();
    if (
      data.secret !== undefined &&
      (typeof data.secret !== "string" || !data.secret.trim())
    )
      throw new Error();
    return {
      webhook: url.href,
      ...(typeof data.secret === "string" ? { secret: data.secret } : {}),
    };
  } catch {
    throw new Error("飞书通知凭据无效");
  }
}

const labels = {
  decision: "拍板",
  merge_confirmation: "合并确认",
  human_action: "待你执行",
  notice: "知会",
};
// Post text nodes cannot introduce at/link nodes. Keep HTML unescaping disabled too.
const text = (value: string) => ({
  tag: "text" as const,
  text: value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;"),
  un_escape: false,
});
const link = (value: string) => {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid notification link");
  return { tag: "a" as const, text: "打开工作台", href: url.href };
};
const line = (message: ExtMessageEntry) =>
  "kind" in message
    ? `${message.card ? `${message.card} ` : ""}${labels[message.kind]}：${message.title}`
    : message.title;

export function feishuPayload(message: ExtMessage) {
  const prefix = `[Cardigan]${message.project ? ` ${message.project}` : ""}`;
  const content = [[text(`${prefix} ${line(message)}`)], [link(message.url)]];
  return { msg_type: "post", content: { post: { zh_cn: { content } } } };
}

/** Neither HTTP bodies nor transport errors cross the port, even on malformed responses. */
async function responseCode(response: Response): Promise<number | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  let length = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 16 * 1024) return undefined;
      parts.push(part.value);
    }
    const data: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!data || typeof data !== "object") return undefined;
    const code = (data as Record<string, unknown>).code;
    return typeof code === "number" && Number.isSafeInteger(code)
      ? code
      : undefined;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createFeishuAdapter(
  credential: string | undefined,
  dependencies: { fetch?: typeof fetch; now?: () => number } = {},
): ExtMessagePort {
  const { webhook, secret } = parseFeishuCredential(credential);
  const request = dependencies.fetch ?? fetch;
  return {
    async send(message, signal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) return "retryable";
        const timestamp = String(
          Math.floor((dependencies.now?.() ?? Date.now()) / 1000),
        );
        const payload = {
          ...feishuPayload(message),
          ...(secret
            ? {
                timestamp,
                sign: createHmac("sha256", `${timestamp}\n${secret}`)
                  .update("")
                  .digest("base64"),
              }
            : {}),
        };
        const response = await request(webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          redirect: "manual",
          signal: controller.signal,
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return response.status === 408 ||
            response.status === 429 ||
            response.status >= 500
            ? "retryable"
            : "permanent";
        }
        const code = await responseCode(response);
        if (code === 0) return "sent";
        // Rate limits / temporary server errors; configuration, signature and content errors are permanent.
        return code === undefined || [11232, 99991400, 99991500].includes(code)
          ? "retryable"
          : "permanent";
      } catch {
        return "retryable";
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
