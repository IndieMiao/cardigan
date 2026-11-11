import {
  type Actor,
  type AttachmentStore,
  authorView,
  type CardView,
  type Clock,
  type CommandEffect,
  type CommandState,
  decisionAuthorView,
  finishRun,
  heartbeat,
  listNeedsYou,
  prepareAttachment,
  projectSnapshot,
  type Result,
  uploadAttachment,
} from "@cardigan/domain";
import { z } from "zod";
import {
  decodeAttachment,
  fileAttachmentStore,
  MAX_ATTACHMENT_BASE64,
} from "../attachments.js";
import { readAttachmentTool } from "../tools/read-attachment.js";
import { agentCard } from "../tools/shared.js";
import { defineTool, type ToolContext } from "../tools/types.js";
import {
  executeCommand,
  executePreparedCommand,
  loadCommandState,
  unwrap,
} from "./execute.js";
import { entryId, id, idempotency_key } from "./schemas.js";

export interface SupportToolOptions {
  readonly dataDir?: string;
  readonly attachmentStore?: AttachmentStore;
  readonly clock?: Clock;
}
function readProject(
  context: ToolContext,
  query: (state: CommandState, actor: Actor) => Result<CommandEffect<unknown>>,
) {
  const { actor } = context.identity;
  return context.store.uow.read(
    (tx) => unwrap(query(loadCommandState(tx, actor.project_id), actor)).data,
  );
}

export function supportTools(options: SupportToolOptions = {}) {
  const attachments =
    options.attachmentStore ?? fileAttachmentStore(options.dataDir);
  return [
    readAttachmentTool(attachments),
    defineTool({
      name: "upload_attachment",
      description:
        "Upload an attachment to a timeline entry or delivery (up to 10 MiB).",
      input: z.object({
        idempotency_key,
        card_id: id("card"),
        file: z
          .string()
          .max(MAX_ATTACHMENT_BASE64)
          .describe("Canonical padded base64 file content."),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
        mime: z.string().min(1),
        original_filename: z
          .string()
          .optional()
          .describe(
            "Original filename for display; directory components are removed, max 200 characters, no control characters.",
          ),
        note: z
          .string()
          .optional()
          .describe(
            "One-line attachment description, max 200 characters, no control characters.",
          ),
        kind: z.enum(["artifact", "evidence"]),
        attach_to: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("timeline_entry"), id: entryId }),
          z.object({ kind: z.literal("delivery"), id: id("delivery") }),
        ]),
        basis: id("decision").optional(),
        supersedes: z.string().min(1).optional(),
      }),
      handler: ({ idempotency_key, ...params }, context) =>
        executePreparedCommand(
          context,
          "upload_attachment",
          idempotency_key,
          params,
          async (_state, _actor, p) => {
            const { content, digest } = decodeAttachment(p.file, p.sha256);
            return unwrap(
              await prepareAttachment(digest, content, attachments),
            );
          },
          (
            state,
            actor,
            { file: _file, sha256: _digest, ...p },
            receipt,
            ports,
          ) =>
            uploadAttachment(
              state,
              actor,
              p as Parameters<typeof uploadAttachment>[2],
              receipt,
              ports,
            ),
          options.clock,
        ),
    }),
    defineTool({
      name: "heartbeat",
      description: "Update the heartbeat of your running Run.",
      input: z.object({
        idempotency_key,
        run_id: id("run"),
        note: z.string().optional(),
      }),
      handler: ({ idempotency_key, ...params }, context) =>
        executeCommand(
          context,
          "heartbeat",
          idempotency_key,
          params as Parameters<typeof heartbeat>[2],
          heartbeat,
          options.clock,
        ),
    }),
    defineTool({
      name: "finish_run",
      description: "Finish your Run with an outcome and summary.",
      input: z.object({
        idempotency_key,
        run_id: id("run"),
        outcome: z.enum(["completed", "blocked", "failed"]),
        summary: z.string().min(1),
      }),
      handler: ({ idempotency_key, ...params }, context) =>
        executeCommand(
          context,
          "finish_run",
          idempotency_key,
          params,
          finishRun,
          options.clock,
        ),
    }),
    defineTool({
      name: "project_snapshot",
      description:
        "Read the current project and derived card states (PM only).",
      input: z.object({}),
      handler: (_params, context) => {
        const snapshot = readProject(context, projectSnapshot) as {
          readonly project_id: string;
          readonly cards: readonly CardView[];
        };
        // Agents read their own checkout from whoami; the card carries no host
        // repository path (M5.S S13).
        return { ...snapshot, cards: snapshot.cards.map(agentCard) };
      },
    }),
    defineTool({
      name: "list_needs_you",
      description:
        "List open human decisions and actions in this project (PM only).",
      input: z.object({}),
      handler: (_params, context) =>
        readProject(context, (state, actor) => {
          const result = listNeedsYou(
            state,
            actor,
            options.clock ?? { now: () => new Date().toISOString() },
          );
          if (!result.ok) return result;
          return {
            ...result,
            value: {
              ...result.value,
              data: {
                ...result.value.data,
                decisions: result.value.data.decisions.map((decision) => {
                  const stored = state.decisions.find(
                    (d) => d.id === decision.id,
                  );
                  return {
                    ...decision,
                    ...(stored ? decisionAuthorView(state, stored) : {}),
                  };
                }),
                human_actions: result.value.data.human_actions.map(
                  (action) => ({
                    ...action,
                    ...authorView(
                      state,
                      state.human_actions.find((a) => a.id === action.id)
                        ?.requested_by ?? "system",
                    ),
                  }),
                ),
              },
            },
          };
        }),
    }),
  ];
}
