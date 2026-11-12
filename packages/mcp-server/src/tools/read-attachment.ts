import type { AttachmentId, AttachmentStore } from "@cardigan/domain";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES, sha256 } from "../attachments.js";
import { ToolError } from "../errors.js";
import { requireCard } from "./shared.js";
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

function accessibleAttachment(id: AttachmentId, context: ToolContext) {
  const { store, identity } = context;
  const attachment = store.uow.read((tx) =>
    tx.attachments.get(identity.actor.project_id, id),
  );
  const missing = () => ToolError.notFound("Attachment not found");
  if (!attachment) throw missing();
  try {
    requireCard(store, identity, attachment.card_id);
  } catch (error) {
    // Unreadable, foreign and missing attachments are indistinguishable.
    if (error instanceof ToolError && error.code === "not_found")
      throw missing();
    throw error;
  }
  return attachment;
}

export function readAttachmentTool(attachments: Pick<AttachmentStore, "get">) {
  return defineTool({
    name: "read_attachment",
    description:
      "Read an accessible card attachment as canonical base64 (up to 10 MiB), with verified sha256, size and stored MIME metadata. Decode file to recover the original bytes.",
    input: z.object({ attachment_id: z.string().min(1) }),
    handler: async ({ attachment_id }, context) => {
      const attachment = accessibleAttachment(
        attachment_id as AttachmentId,
        context,
      );
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
      context.revalidateToken?.();
      const assignment = context.store.uow.read((tx) =>
        tx.assignments.get(
          context.identity.actor.project_id,
          context.identity.assignment.id,
        ),
      );
      if (assignment?.status !== "active")
        throw new ToolError("unauthorized", "Assignment is no longer active");
      accessibleAttachment(attachment.id, {
        ...context,
        identity: { ...context.identity, assignment },
      });
      if (!content) throw ToolError.notFound("Attachment not found");
      if (
        content.byteLength !== attachment.size ||
        sha256(content) !== attachment.sha256
      )
        throw ToolError.validation(
          "Stored attachment size or checksum mismatch",
        );
      return {
        attachment_id: attachment.id,
        card_id: attachment.card_id,
        encoding: "base64",
        file: Buffer.from(content).toString("base64"),
        sha256: attachment.sha256,
        size: attachment.size,
        mime: attachment.mime,
      };
    },
  });
}
