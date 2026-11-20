import {
  type AttachmentId,
  type AttachmentStore,
  referenceReadScope,
} from "@cardigan/domain";
import { z } from "zod";
import { verifyArtifact } from "../artifact-files.js";
import {
  attachmentPreview,
  MAX_ATTACHMENT_PAGE_BYTES,
  resolveAttachmentInlineBytes,
} from "../attachment-preview.js";
import { MAX_ATTACHMENT_BYTES, sha256 } from "../attachments.js";
import { ToolError } from "../errors.js";
import {
  auditReferenceRead,
  referenceCard,
  safeReferenceQuery,
} from "./reference-read.js";
import { defineTool, type ToolContext } from "./types.js";

const metadata = z.object({
  sha256: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
  // MIME is uploader-supplied metadata, not content sniffing. Preserve valid
  // parameters (e.g. text/plain; charset=utf-8), but reject control characters.
  mime: z
    .string()
    .max(1024)
    .refine((value) => !/[^\x20-\x7e]/u.test(value))
    .regex(/^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+(?:;[\x20-\x7e]+)?$/u),
});

export function accessibleAttachment(id: AttachmentId, context: ToolContext) {
  if (!context.identity.actor.allowed_tools.includes("read_attachment"))
    throw ToolError.forbiddenTool("read_attachment");
  const { store, identity } = context;
  const attachment = safeReferenceQuery(() =>
    store.uow.read((tx) => tx.attachments.get(identity.actor.project_id, id)),
  );
  const missing = () => ToolError.notFound("Attachment not found");
  if (!attachment || attachment.streamed_artifact?.expired) throw missing();
  try {
    const read = safeReferenceQuery(() =>
      store.uow.read((tx) => referenceCard(tx, context, attachment.card_id)),
    );
    if (read.access !== "full") throw missing();
    const bound = safeReferenceQuery(() =>
      store.uow.read((tx) => {
        const target = attachment.attach_to;
        if (target.kind === "timeline_entry") {
          const entry = tx.timeline.get(identity.actor.project_id, target.id);
          if (!entry || entry.card_id !== attachment.card_id) return false;
          const project = identity.actor.project_id;
          const scope = referenceReadScope(
            {
              project_id: project,
              cards: tx.cards.list(project),
              work_items: tx.work_items.list(project),
              project_preferences: tx.project_preferences?.list(project) ?? [],
            },
            read.assignment,
          );
          const delivery =
            entry.delivery_id === undefined
              ? undefined
              : tx.deliveries.get(project, entry.delivery_id);
          return (
            (entry.work_item_id === undefined ||
              scope.workItem(entry.work_item_id)) &&
            (entry.delivery_id === undefined ||
              (delivery !== undefined &&
                scope.workItem(delivery.work_item_id))) &&
            (entry.decision_id === undefined ||
              scope.decision(tx.decisions.get(project, entry.decision_id))) &&
            (entry.human_action_id === undefined ||
              scope.humanAction(
                tx.human_actions.get(project, entry.human_action_id),
              ))
          );
        }
        const delivery = tx.deliveries.get(
          identity.actor.project_id,
          target.id,
        );
        return (
          delivery !== undefined &&
          tx.work_items.get(identity.actor.project_id, delivery.work_item_id)
            ?.card_id === attachment.card_id
        );
      }),
    );
    if (!bound) throw missing();
  } catch (error) {
    // Unreadable, foreign and missing attachments are indistinguishable.
    if (error instanceof ToolError && error.code === "not_found")
      throw missing();
    throw error;
  }
  return attachment;
}

/** Shared by bounded MCP previews and the authenticated binary download. */
export async function readVerifiedAttachment(
  attachment: ReturnType<typeof accessibleAttachment>,
  attachments: Pick<AttachmentStore, "get">,
  context: ToolContext,
) {
  if (!metadata.safeParse(attachment).success)
    throw ToolError.validation(
      "Invalid attachment metadata or size exceeds 10 MiB",
    );
  let content: Uint8Array | undefined;
  try {
    // Authorization and metadata validation precede all blob IO.
    content = await attachments.get(attachment.sha256);
  } catch {
    throw ToolError.validation(
      "Stored attachment could not be read or verified",
    );
  }
  try {
    context.revalidateToken?.();
  } catch {
    throw new ToolError("unauthorized", "Token 已失效。");
  }
  const assignment = safeReferenceQuery(() =>
    context.store.uow.read((tx) =>
      tx.assignments.get(
        context.identity.actor.project_id,
        context.identity.assignment.id,
      ),
    ),
  );
  if (assignment?.status !== "active")
    throw new ToolError("unauthorized", "Assignment is no longer active");
  const current = accessibleAttachment(attachment.id, {
    ...context,
    identity: { ...context.identity, assignment },
  });
  if (
    current.card_id !== attachment.card_id ||
    current.sha256 !== attachment.sha256 ||
    current.size !== attachment.size ||
    current.mime !== attachment.mime ||
    current.original_filename !== attachment.original_filename ||
    JSON.stringify(current.attach_to) !== JSON.stringify(attachment.attach_to)
  )
    throw ToolError.notFound("Attachment not found");
  if (!content) throw ToolError.notFound("Attachment not found");
  if (
    content.byteLength !== attachment.size ||
    sha256(content) !== attachment.sha256
  )
    throw ToolError.validation("Stored attachment size or checksum mismatch");
  const read = safeReferenceQuery(() =>
    context.store.uow.read((tx) =>
      referenceCard(tx, context, attachment.card_id),
    ),
  );
  auditReferenceRead(context, [attachment.card_id], "read_attachment");
  return { attachment, content, provenance: read.provenance };
}

export function readAttachmentTool(
  attachments: Pick<AttachmentStore, "get">,
  inlineBytes?: number,
  dataDir?: string,
) {
  const threshold = resolveAttachmentInlineBytes(inlineBytes);
  return defineTool({
    name: "read_attachment",
    description:
      "Read verified attachment metadata. Binary files and text above the host inline threshold (default 64 KiB) omit content and include authenticated download instructions. Small UTF-8 text retains base64 file. Explicit byte offset/limit pages UTF-8 text (max 65536 bytes); follow next_offset. For a streamed artifact supply verify_sha256 to rehash stored bytes. Metadata alone is not evidence review.",
    input: z.object({
      attachment_id: z.string().min(1),
      verify_sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .optional(),
      offset: z
        .number()
        .int()
        .min(0)
        .max(MAX_ATTACHMENT_BYTES)
        .optional()
        .describe(
          "UTF-8 byte offset at a character boundary; omitted means zero when paging.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_ATTACHMENT_PAGE_BYTES)
        .optional()
        .describe("Maximum bytes in a text page (default/max 65536)."),
    }),
    handler: async (
      { attachment_id, offset, limit, verify_sha256 },
      context,
    ) => {
      const a = accessibleAttachment(attachment_id as AttachmentId, context);
      if (a.streamed_artifact) {
        if (offset !== undefined || limit !== undefined)
          throw ToolError.validation(
            "Streamed artifacts do not support text pages",
          );
        if (verify_sha256) {
          await verifyArtifact(dataDir, a, verify_sha256);
          accessibleAttachment(a.id, context);
        }
        const read = context.store.uow.read((tx) =>
          referenceCard(tx, context, a.card_id),
        );
        auditReferenceRead(context, [a.card_id], "read_attachment");
        return {
          ...read.provenance,
          attachment_id: a.id,
          card_id: a.card_id,
          run_id: a.streamed_artifact.run_id,
          attach_to: a.attach_to,
          filename: a.original_filename,
          size: a.size,
          mime: a.mime,
          sha256: a.sha256,
          verified: !!verify_sha256,
          content_mode: "metadata",
          download: {
            method: "GET",
            query: { attachment_id: a.id },
            instructions:
              "Stream from the configured MCP URL with this query and the current Bearer. Check the downloaded SHA-256.",
          },
        };
      }

      const { attachment, content, provenance } = await readVerifiedAttachment(
        a,
        attachments,
        context,
      );
      if (verify_sha256 && verify_sha256 !== attachment.sha256)
        throw ToolError.validation("Attachment sha256 mismatch");
      return {
        ...(verify_sha256 ? { verified: true } : {}),
        ...provenance,
        ...attachmentPreview(attachment, content, threshold, { offset, limit }),
      };
    },
  });
}
