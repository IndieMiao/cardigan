import {
  type Actor,
  type AttachmentStore,
  type AttachmentTarget,
  authorView,
  type CardId,
  type Clock,
  type CommandEffect,
  type CommandState,
  CROSS_CARD_REFERENCE_NOTICE,
  decisionAuthorView,
  finishRun,
  heartbeat,
  listNeedsYou,
  listRoles,
  listTemplates,
  prepareAttachment,
  type ReadRunCapacity,
  type Result,
  referenceProjectSnapshot,
  uploadAttachment,
} from "@cardigan/domain";
import { z } from "zod";
import { MAX_ARTIFACT_BYTES } from "../artifact-files.js";
import type { ArtifactUploads } from "../artifact-uploads.js";
import {
  decodeAttachment,
  fileAttachmentStore,
  MAX_ATTACHMENT_BASE64,
} from "../attachments.js";
import { ToolError } from "../errors.js";
import { readAttachmentTool } from "../tools/read-attachment.js";
import {
  auditProjectSnapshotRead,
  safeReferenceQuery,
} from "../tools/reference-read.js";
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
  readonly artifactUploads?: ArtifactUploads;
  /** Trusted host setting; never taken from tool arguments. */
  readonly attachmentInlineBytes?: number;
  readonly attachmentStore?: AttachmentStore;
  readonly clock?: Clock;
  readonly runCapacity?: ReadRunCapacity;
  readonly projectSettings?: (
    projectId: string,
  ) => CommandState["project_settings"];
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
    readAttachmentTool(
      attachments,
      options.attachmentInlineBytes,
      options.dataDir,
    ),
    defineTool({
      name: "upload_attachment",
      description:
        "Upload a base64 attachment (10 MiB), or omit file and provide artifact_size and sha256 to request a one-use raw artifact upload (2 GiB) on the configured MCP endpoint. The stored sha256 is computed by the server, so a stored attachment needs no read-back download.",
      input: z.object({
        idempotency_key,
        card_id: id("card"),
        file: z
          .string()
          .max(MAX_ATTACHMENT_BASE64)
          .describe("Canonical padded base64 file content.")
          .optional(),
        artifact_size: z
          .number()
          .int()
          .min(0)
          .max(MAX_ARTIFACT_BYTES)
          .optional(),
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
      handler: (
        { idempotency_key, artifact_size, file, ...target },
        context,
      ) => {
        if (artifact_size !== undefined) {
          if (file !== undefined || !target.sha256 || !options.artifactUploads)
            throw ToolError.validation(
              "Provide artifact_size and sha256 without file",
            );
          return options.artifactUploads.reserve(context, idempotency_key, {
            ...(target as AttachmentTarget),
            sha256: target.sha256,
            artifact_size,
          });
        }
        if (file === undefined)
          throw ToolError.validation("Attachment file required");
        const params = { ...target, file };
        return executePreparedCommand(
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
        );
      },
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
        wait_for: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("baseline_updated") }),
            z.object({
              kind: z.literal("deployment_ready"),
              target_id: z.string().regex(/^[a-f0-9]{40}$/u),
            }),
          ])
          .optional()
          .describe(
            "Wake this producer once the host baseline differs from its registered baseline, or the specified full SHA is deployed successfully. Omit for normal finish.",
          ),
      }),
      handler: ({ idempotency_key, ...params }, context) =>
        executeCommand(
          context,
          "finish_run",
          idempotency_key,
          params,
          (state, actor, p, ports) =>
            finishRun(state, actor, p as Parameters<typeof finishRun>[2], {
              ...ports,
              run_token: context.identity.token,
            }),
          options.clock,
        ),
    }),
    defineTool({
      name: "project_snapshot",
      description:
        "Read same-project card references. Sensitive cards expose only id/title/status. Optional read_audit_employee_id returns that employee's cross-card read audit; no card timeline is written. Existing standing PM capacity visibility is unchanged.",
      input: z.object({ read_audit_employee_id: z.string().min(1).optional() }),
      handler: ({ read_audit_employee_id }, context) => {
        try {
          context.revalidateToken?.();
        } catch {
          throw new ToolError("unauthorized", "Token 已失效。");
        }
        const snapshot = safeReferenceQuery(() =>
          context.store.uow.read((tx) => {
            const result = referenceProjectSnapshot(
              loadCommandState(tx, context.identity.actor.project_id),
              context.identity.actor,
            );
            if (!result.ok)
              throw new ToolError(result.error.code, result.error.message);
            return result.value.data;
          }),
        );
        const pm =
          context.identity.assignment.scope === "standing" &&
          context.identity.actor.role_id === "pm";
        let run_capacity: ReturnType<ReadRunCapacity> = null;
        if (pm) {
          try {
            run_capacity = options.runCapacity?.() ?? null;
          } catch {
            throw ToolError.validation("Run capacity is unavailable");
          }
        }
        const audit =
          read_audit_employee_id === undefined
            ? undefined
            : safeReferenceQuery(() =>
                context.store.uow.read((tx) =>
                  tx.events
                    .listAfter(context.identity.actor.project_id, undefined, 0)
                    .flatMap((e) => {
                      const p = e.payload;
                      if (
                        e.type !== "cross_card_read" ||
                        !p ||
                        typeof p !== "object" ||
                        Array.isArray(p) ||
                        !("employee_id" in p) ||
                        p.employee_id !== read_audit_employee_id
                      )
                        return [];
                      return [
                        {
                          at: e.created_at,
                          employee_id: p.employee_id,
                          assignment_id: p.assignment_id,
                          ...(p.tool === "project_snapshot" &&
                          Array.isArray(p.card_ids)
                            ? { card_ids: p.card_ids, card_count: p.card_count }
                            : { card_id: p.card_id }),
                          tool: p.tool,
                        },
                      ];
                    }),
                ),
              );
        // Recheck and record references before exposing the response. Summary
        // records carry no body and are allowed through the same audit path.
        auditProjectSnapshotRead(
          context,
          snapshot.cards.map((card) => ({
            id: card.id as CardId,
            full: "goal" in card,
          })),
        );
        return {
          ...snapshot,
          cards: snapshot.cards.map((card) => {
            const { repo: _path, ...safe } = card as typeof card & {
              repo?: string;
            };
            if ("merge_check" in safe && safe.merge_check) {
              const { log_ref: _logPath, ...check } = safe.merge_check;
              return { ...safe, merge_check: check };
            }
            return safe;
          }),
          ...(pm ? { run_capacity } : {}),
          ...(audit
            ? {
                read_audit: audit,
                reference_notice: CROSS_CARD_REFERENCE_NOTICE,
              }
            : {}),
        };
      },
    }),
    defineTool({
      name: "list_templates",
      description:
        "List the latest active card templates of this project with their work items (PM only, read-only).",
      input: z.object({}),
      handler: (_params, context) => readProject(context, listTemplates),
    }),
    defineTool({
      name: "list_roles",
      description:
        "List the latest active roles of this project with kind, capabilities and abilities; prompts are not included (PM only, read-only).",
      input: z.object({}),
      handler: (_params, context) => readProject(context, listRoles),
    }),
    defineTool({
      name: "list_needs_you",
      description:
        "List open human decisions and actions in this project (PM only).",
      input: z.object({}),
      handler: (_params, context) =>
        readProject(context, (state, actor) => {
          const result = listNeedsYou(
            {
              ...state,
              project_settings:
                options.projectSettings?.(state.project_id) ?? {},
            },
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
