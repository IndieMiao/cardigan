import type { Actor } from "./entities.js";
import type { CardId } from "./ids.js";

/** Identity is persisted by the host, never supplied in message arguments. */
export function managedPmOffice(
  assignment:
    | {
        readonly scope: string;
        readonly role_id: string;
        readonly standing_mode?: string | undefined;
        readonly external?: boolean | undefined;
      }
    | undefined,
): boolean {
  return (
    assignment?.scope === "standing" &&
    assignment.role_id === "pm" &&
    assignment.standing_mode === "office" &&
    assignment.external !== true
  );
}

export function ownerTextError(text: string): string | undefined {
  if (!text.trim() || [...text].length > 4000)
    return "正文须为 1 到 4000 字的纯文字";
  if (/[@＠]|<\s*at\b/i.test(text)) return "私聊正文不支持 @ 提及";
  if (/\p{Cc}/u.test(text.replace(/[\r\n\t]/g, "")))
    return "正文含非文字控制字符";
  if (!linksAreHttp(text)) return "正文链接仅支持 http 或 https";
}

/**
 * Walks the original text colon by colon and judges each link by its
 * outermost scheme, so "blob:https://…" is a blob link while
 * "Download:https://…" is a heading followed by an HTTPS link. Words before a
 * colon that are neither "…://" nor a scheme clients open without "//" are
 * headings ("SHA-256:3f2a…", "Size:18MB"). An accepted HTTP(S) link runs to the
 * next delimiter, so a port or a colon in its path is not another scheme.
 */
function linksAreHttp(text: string): boolean {
  let linkEnd = 0;
  for (const m of text.matchAll(/([a-z\d+.-]*):/gi)) {
    const at = m.index ?? 0;
    if (at < linkEnd) continue;
    const word = m[1] ?? "",
      after = at + m[0].length;
    if (text.startsWith("//", after)) {
      if (!/^https?$/i.test(word)) return false;
      const end = text.slice(after).search(/[\s<>"'()，。；、（）]/);
      linkEnd = end < 0 ? text.length : after + end;
    } else if (OPAQUE_SCHEME.test(word) && /\S/.test(text[after] ?? "")) {
      return false;
    }
  }
  return true;
}

const OPAQUE_SCHEME =
  /(?:^|[^a-z])(?:blob|callto|data|facetime|file|geo|itms-services|javascript|magnet|mailto|sips?|skype|sms|tel|vbscript|webcal)$/i;

export interface OwnerMessageInput {
  readonly card_id: CardId;
  readonly text: string;
  readonly idempotency_key: string;
}
export interface OwnerMessagePort {
  readonly enqueueOwnerMessage?: (
    actor: Extract<Actor, { kind: "assignment" }>,
    input: OwnerMessageInput,
    revalidate: () => void,
  ) => { message_id: string; status: "queued" };
}
