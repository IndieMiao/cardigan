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
  // HTTP(S) links are consumed as whole tokens first, so a port or a colon in
  // their path is not mistaken for another scheme. What remains is release-note
  // text such as "SHA-256:3f2a…" or "Size:18MB"; only "://" or a scheme that
  // clients open without "//" counts as a link there.
  const rest = text.replace(
    /(?<![a-z\d+.-])https?:\/\/[^\s<>"'()，。；、（）]*/gi,
    " ",
  );
  if (rest.includes("://") || OPAQUE_SCHEME.test(rest))
    return "正文链接仅支持 http 或 https";
}

const OPAQUE_SCHEME =
  /(?<![a-z])(?:blob|callto|data|facetime|file|geo|itms-services|javascript|magnet|mailto|sips?|skype|sms|tel|vbscript|webcal):\S/i;

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
