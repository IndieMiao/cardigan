import type { Actor, Attachment } from "../entities.js";
import type { Result } from "../errors.js";
import type { RunId } from "../ids.js";
import type { AttachmentStore } from "../ports.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
} from "./core.js";

const stored = Symbol("stored-attachment");

function displayText(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  text(value, field);
  ensure(
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
    "validation_failed",
    `${field} must not contain control characters`,
  );
  // Both browser/Windows and POSIX paths may arrive through an upload adapter.
  const normalized =
    field === "original_filename"
      ? (value.split(/[\\/]/u).at(-1) ?? "")
      : value;
  text(normalized, field);
  ensure(
    [...normalized].length <= 200,
    "validation_failed",
    `${field} must be at most 200 characters`,
  );
  return normalized;
}

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
export type AttachmentTarget = Pick<
  Attachment,
  "card_id" | "mime" | "kind" | "attach_to"
> &
  Partial<
    Pick<
      Attachment,
      "basis" | "supersedes" | "original_filename" | "note" | "ref_slot"
    >
  >;
/** The most files one comment may name as `attachment-new-N`. */
export const MAX_REF_SLOT = 100;
function validateTarget(d: CommandDraft, p: AttachmentTarget) {
  d.card(p.card_id);
  text(p.mime, "mime");
  const original_filename = displayText(
    p.original_filename,
    "original_filename",
  );
  const note = displayText(p.note, "note");
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
      : d.state.timeline.find((e) => e.id === p.attach_to.id)?.card_id;
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
  if (p.ref_slot !== undefined) {
    // C-615: a comment's `attachment-new-N` is bound to exactly one file of
    // that comment's own author.
    ensure(
      Number.isInteger(p.ref_slot) &&
        p.ref_slot >= 1 &&
        p.ref_slot <= MAX_REF_SLOT,
      "validation_failed",
      `ref_slot must be an integer from 1 to ${MAX_REF_SLOT}`,
    );
    const target = p.attach_to;
    const entry =
      target.kind === "timeline_entry"
        ? d.state.timeline.find((e) => e.id === target.id)
        : undefined;
    ensure(
      entry !== undefined,
      "validation_failed",
      "ref_slot needs a timeline entry target",
    );
    ensure(
      entry.author === d.author,
      "unauthorized",
      "Only the entry's author may fill its ref_slot",
    );
    ensure(
      !d.state.attachments.some(
        (a) =>
          a.attach_to.kind === "timeline_entry" &&
          a.attach_to.id === target.id &&
          a.ref_slot === p.ref_slot,
      ),
      "validation_failed",
      "This ref_slot of the entry is already filled",
    );
  }
  return { original_filename, note };
}
export function artifactUploadRun(
  state: CommandState,
  actor: Actor,
  p: AttachmentTarget,
) {
  return command(state, actor, "upload_attachment", undefined, (d) => {
    validateTarget(d, p);
    return d.currentRun().id;
  });
}
/** IO lives in the adapter; mint the receipt only after its stream completed. */
export async function prepareStreamedArtifact(
  run_id: RunId,
  put: () => Promise<{ id: string; sha256: string; size: number }>,
) {
  const { id: blob_id, sha256, size } = await put();
  return {
    [stored]: true as const,
    sha256,
    size,
    storage_path: `artifacts/${blob_id}`,
    stream: { blob_id, run_id },
  };
}
export function uploadAttachment(
  state: CommandState,
  actor: Actor,
  p: AttachmentTarget,
  receipt:
    | StoredAttachment
    | Awaited<ReturnType<typeof prepareStreamedArtifact>>,
  ports: CommandPorts,
) {
  return command(state, actor, "upload_attachment", ports, (d) => {
    const { original_filename, note } = validateTarget(d, p);
    ensure(
      receipt?.[stored],
      "validation_failed",
      "A stored attachment receipt is required",
    );
    const stream = "stream" in receipt ? receipt.stream : undefined;
    if (stream)
      ensure(
        stream.run_id === d.currentRun().id,
        "illegal_transition",
        "Artifact upload Run is no longer current",
      );
    const common = {
      id: d.ids.nextAttachmentId(state.project_id),
      ...(stream
        ? { streamed_artifact: { ...stream, created_at: ports.clock.now() } }
        : {}),
      sha256: receipt.sha256,
      size: receipt.size,
      storage_path: receipt.storage_path,
      card_id: p.card_id,
      mime: p.mime,
      ...(original_filename === undefined ? {} : { original_filename }),
      ...(note === undefined ? {} : { note }),
      uploaded_by: d.author,
      attach_to: p.attach_to,
      ...(p.supersedes ? { supersedes: p.supersedes } : {}),
      ...(p.ref_slot === undefined ? {} : { ref_slot: p.ref_slot }),
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
