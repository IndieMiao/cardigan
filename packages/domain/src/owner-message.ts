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
  // A heading such as "File: app.apk" has no URI payload after the colon.
  // Consume each link as a unit: a port or another colon in an HTTPS path
  // is not the start of a second scheme.
  for (const [, scheme] of text.matchAll(
    /\b([a-z][a-z\d+.-]*):[^\s<>"'()，。；、（）]+/gi,
  )) {
    if (!/^https?$/i.test(scheme ?? "")) return "正文链接仅支持 http 或 https";
  }
}

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
