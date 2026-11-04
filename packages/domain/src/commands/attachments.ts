import type { Actor, Attachment } from "../entities.js";
import type { Result } from "../errors.js";
import type { AttachmentStore } from "../ports.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
} from "./core.js";

const stored = Symbol("stored-attachment");
export interface StoredAttachment {
  readonly [stored]: true;
  readonly sha256: string;
  readonly size: number;
  readonly storage_path: string;
}
// The adapter computes sha256 before calling this port-only preflight; no filesystem/hash IO here.
export async function prepareAttachment(
  sha256: string,
  content: Uint8Array,
  store: AttachmentStore,
): Promise<Result<StoredAttachment>> {
  if (!/^[a-f0-9]{64}$/u.test(sha256))
    return {
      ok: false,
      error: { code: "validation_failed", message: "Invalid sha256" },
    };
  try {
    const value = await store.put(sha256, content);
    return {
      ok: true,
      value: {
        [stored]: true,
        sha256,
        size: content.byteLength,
        storage_path: value.storage_path,
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: "Attachment storage failed",
      },
    };
  }
}
export function uploadAttachment(
  state: CommandState,
  actor: Actor,
  p: Pick<Attachment, "card_id" | "mime" | "kind" | "attach_to"> &
    Partial<Pick<Attachment, "basis" | "supersedes">>,
  receipt: StoredAttachment,
  ports: CommandPorts,
) {
  return command(state, actor, "upload_attachment", ports, (d) => {
    d.card(p.card_id);
    text(p.mime, "mime");
    ensure(
      receipt?.[stored],
      "validation_failed",
      "A stored attachment receipt is required",
    );
    ensure(
      p.kind === "artifact" || p.kind === "evidence",
      "validation_failed",
      "Unknown attachment kind",
    );
    ensure(
      p.kind !== "artifact" || p.basis,
      "validation_failed",
      "Artifacts require a decision basis",
    );
    if (p.basis)
      ensure(
        d.list("decisions").some((q) => q.key === p.basis),
        "not_found",
        "Attachment basis was not found",
      );
    ensure(
      p.attach_to && ["timeline_entry", "delivery"].includes(p.attach_to.kind),
      "validation_failed",
      "attach_to is required",
    );
    const targetCard =
      p.attach_to.kind === "delivery"
        ? d.work(d.get("deliveries", p.attach_to.id).work_item_id).card_id
        : state.timeline.find((e) => e.id === p.attach_to.id)?.card_id;
    ensure(targetCard, "not_found", "Attachment target was not found");
    ensure(
      targetCard === p.card_id,
      "validation_failed",
      "Attachment target belongs to another card",
    );
    if (p.supersedes)
      ensure(
        d.get("attachments", p.supersedes).card_id === p.card_id,
        "validation_failed",
        "Superseded attachment belongs to another card",
      );
    const common = {
      id: d.ids.nextAttachmentId(state.project_id),
      sha256: receipt.sha256,
      size: receipt.size,
      storage_path: receipt.storage_path,
      card_id: p.card_id,
      mime: p.mime,
      uploaded_by: d.author,
      attach_to: p.attach_to,
      ...(p.supersedes ? { supersedes: p.supersedes } : {}),
    };
    const attachment: Attachment =
      p.kind === "artifact"
        ? {
            ...common,
            kind: "artifact",
            basis: p.basis as NonNullable<typeof p.basis>,
          }
        : {
            ...common,
            kind: "evidence",
            ...(p.basis ? { basis: p.basis } : {}),
          };
    d.put("attachments", attachment);
    d.emit(
      "attachment_uploaded",
      p.card_id,
      { attachment_id: attachment.id },
      { type: "system", body: `Attached ${attachment.id}` },
    );
    return attachment;
  });
}
