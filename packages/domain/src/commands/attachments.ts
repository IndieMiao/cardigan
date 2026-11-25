import {
  approvedReleaseChain,
  releaseChainOf,
  releaseChainSigned,
} from "../artifact-publication.js";
import type {
  Actor,
  Attachment,
  VideoInfo,
  VideoMetadata,
} from "../entities.js";
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
/**
 * C-683: a file the adapter streamed into the content-addressed store (videos
 * too large to hold in memory). The adapter hashes every byte and publishes
 * the blob in `put`; the receipt is the same as `prepareAttachment`'s, so the
 * attachment record does not know how the bytes arrived.
 */
export async function prepareStreamedAttachment(
  sha256: string,
  size: number,
  put: () => Promise<{ readonly storage_path: string }>,
): Promise<Result<StoredAttachment>> {
  if (
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    !Number.isSafeInteger(size) ||
    size < 0
  )
    return {
      ok: false,
      error: { code: "validation_failed", message: "Invalid sha256 or size" },
    };
  try {
    const { storage_path } = await put();
    return { ok: true, value: { [stored]: true, sha256, size, storage_path } };
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
  > & {
    /** C-683: what the uploader measured; video types only. */
    readonly video?: VideoMetadata;
  };
/** C-683: the video types attachments accept. */
export const VIDEO_MIME_TYPES: readonly string[] = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
];
export const isVideoMimeType = (mime: string) =>
  VIDEO_MIME_TYPES.includes((mime.split(";")[0] ?? "").trim().toLowerCase());
/** C-683: largest cover frame a video record may name. */
export const MAX_VIDEO_POSTER_BYTES = 512 * 1024;
const MAX_VIDEO_SECONDS = 7 * 24 * 60 * 60;
const MAX_VIDEO_PIXELS = 16_384;
/** Validated metadata with only the fields given; undefined when none. */
function videoMetadata(p: AttachmentTarget): VideoMetadata | undefined {
  const v = p.video;
  if (v === undefined) return undefined;
  ensure(
    isVideoMimeType(p.mime),
    "validation_failed",
    "video metadata applies to video attachments only",
  );
  ensure(
    typeof v === "object" && v !== null,
    "validation_failed",
    "video must be an object",
  );
  const out: Record<string, number | string> = {};
  const n = (key: keyof VideoMetadata, max: number, integer: boolean) => {
    const value = v[key];
    if (value === undefined) return;
    ensure(
      typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= max &&
        (!integer || Number.isInteger(value)),
      "validation_failed",
      `video.${key} is out of range`,
    );
    out[key] = integer ? value : Math.round(value * 1000) / 1000;
  };
  const c = (key: "video_codec" | "audio_codec") => {
    const value = v[key];
    if (value === undefined) return;
    ensure(
      typeof value === "string" && /^[A-Za-z0-9._-]{1,32}$/u.test(value),
      "validation_failed",
      `video.${key} must be a short codec name`,
    );
    out[key] = value;
  };
  n("duration_seconds", MAX_VIDEO_SECONDS, false);
  n("width", MAX_VIDEO_PIXELS, true);
  n("height", MAX_VIDEO_PIXELS, true);
  c("video_codec");
  c("audio_codec");
  return Object.keys(out).length ? (out as VideoMetadata) : undefined;
}
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
  return { original_filename, note, video: videoMetadata(p) };
}
/**
 * C-612: an artifact stored on a release-chain approval is a chain step. It is
 * accepted only under the approved, live chain of this card and only for the
 * bytes the chain binds: the approved unsigned digest, or a signed digest the
 * control plane bound from a host-verified signing receipt. Other bases keep
 * their existing use.
 */
function releaseChainIntake(
  d: CommandDraft,
  p: AttachmentTarget,
  sha256: string,
) {
  if (p.kind !== "artifact") return;
  const q = d.list("decisions").find((x) => x.key === p.basis);
  if (!releaseChainOf(q)) return;
  const events = [...d.state.events, ...d.events];
  const chain = approvedReleaseChain(
    d.state.project_id,
    q,
    d.list("project_preferences").find((x) => x.id === d.state.project_id),
    events,
  );
  ensure(
    chain !== undefined && chain.card_id === p.card_id,
    "illegal_transition",
    "发布链尚未批准、已失效或不属于本卡",
  );
  ensure(
    sha256 === chain.unsigned_sha256 ||
      releaseChainSigned(
        chain,
        events.filter((e) => e.card_id === chain.card_id),
      ).some((s) => s.sha256 === sha256),
    "validation_failed",
    "入库摘要与发布链绑定的未签名摘要或签后摘要不符",
  );
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
  /** C-683: the video's cover frame, stored before the record. */
  poster?: StoredAttachment,
) {
  return command(state, actor, "upload_attachment", ports, (d) => {
    const { original_filename, note, video: measured } = validateTarget(d, p);
    if (poster !== undefined) {
      ensure(
        poster?.[stored],
        "validation_failed",
        "A stored poster receipt is required",
      );
      ensure(
        isVideoMimeType(p.mime),
        "validation_failed",
        "A poster applies to video attachments only",
      );
      ensure(
        poster.size > 0 && poster.size <= MAX_VIDEO_POSTER_BYTES,
        "validation_failed",
        `A poster must be 1 to ${MAX_VIDEO_POSTER_BYTES} bytes`,
      );
    }
    const video: VideoInfo | undefined =
      measured || poster
        ? {
            ...measured,
            ...(poster
              ? { poster_sha256: poster.sha256, poster_size: poster.size }
              : {}),
          }
        : undefined;
    ensure(
      receipt?.[stored],
      "validation_failed",
      "A stored attachment receipt is required",
    );
    releaseChainIntake(d, p, receipt.sha256);
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
      ...(video ? { video } : {}),
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
