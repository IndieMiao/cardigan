import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Actor,
  type Clock,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  completeHumanAction,
  type DomainError,
  issueInstruction,
  latestMergeCheck,
  manageCardTemplate,
  markCardDone,
  parseId,
  parseTimelineEntryId,
  postComment,
  prepareMergePlan,
  type ReadableIdKind,
  type Result,
  recheckMerge,
  recordDecision,
  setProjectPreferences,
  supersedeCard,
  type TemplateChange,
  updateCard,
  updateWorkItem,
  uploadAttachment,
} from "@cardigan/domain";
import type { ProjectMergeGate } from "@cardigan/host";
import {
  loadCommandState,
  MAX_ATTACHMENT_BASE64,
  MAX_MCP_BODY_BYTES,
  persistEffect,
  prepareAttachmentFile,
  ToolError,
} from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { z } from "zod";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";

import { previewPorts } from "./read.js";

const text = z
  .string()
  .refine((s) => s.trim().length > 0, "Text must not be blank");
const id = <K extends ReadableIdKind>(kind: K) =>
  z
    .string()
    .refine((s) => parseId(kind, s).ok, `Invalid ${kind} ID`)
    .transform((s) => must(parseId(kind, s)).id);
const entryId = z
  .string()
  .refine((s) => parseTimelineEntryId(s).ok)
  .transform((s) => must(parseTimelineEntryId(s)).id);
// Transport shape only; all template rules stay in the V10a domain command.
const templateDefinition = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    requires_repo: z.boolean(),
    merge: z.enum(["none", "confirm", "auto"]),
    require_acceptance_criteria: z.boolean(),
    work_items: z.array(
      z
        .object({
          key: z.string(),
          title: z.string(),
          role_id: z.string(),
          required: z.boolean(),
          kind: z.enum(["produce", "verify"]),
          target_work_item_key: z.string().optional(),
        })
        .strict(),
    ),
    primary_work_item_key: z.string().nullable(),
    completion: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("human_mark_done") }).strict(),
      z.object({ mode: z.literal("review"), reviewer: z.string() }).strict(),
    ]),
  })
  .strict();
const templateChange = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("add"), definition: templateDefinition })
    .strict(),
  z
    .object({ action: z.literal("update"), definition: templateDefinition })
    .strict(),
  z
    .object({
      action: z.literal("copy"),
      template_id: z.string(),
      new_id: z.string(),
      version: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ action: z.literal("activate"), template_id: z.string() }).strict(),
  z
    .object({ action: z.literal("deactivate"), template_id: z.string() })
    .strict(),
  z
    .object({
      action: z.literal("rollback"),
      template_id: z.string(),
      version: z.number().int().positive(),
    })
    .strict(),
]);
const requiredKey = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s.trim().length > 0);
const comment = z.object({
  body: text,
  work_item_id: id("work_item").optional(),
  mentions: z.array(text).optional(),
  reply_to: entryId.optional(),
  supersedes: entryId.optional(),
});
const instruction = z.object({ body: text, work_item_id: id("work_item") });
const cardUpdate = z
  .object({
    title: text.optional(),
    goal: text.optional(),
    acceptance_criteria: z.array(text).min(1).optional(),
    priority: z.number().finite().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0);
const cardCancel = z.object({ reason: z.string().optional() }).strict();
const cardSupersede = z.object({ superseded_by: id("card") }).strict();
const decision = z.object({
  option: text,
  rationale: z.string().optional(),
  raw_quote: z.string().optional(),
});
const clarification = z.object({
  action: z.enum(["request_information", "explain"]),
  body: text.optional(),
});
const action = z.object({ text, attachments: z.array(text).optional() });
const attachment = z.object({
  file: z.string().max(MAX_ATTACHMENT_BASE64),
  mime: text,
  original_filename: z.string().optional(),
  note: z.string().optional(),
  kind: z.enum(["artifact", "evidence"]),
  attach_to: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("delivery"), id: id("delivery") }),
    z.object({ kind: z.literal("timeline_entry"), id: entryId }),
  ]),
  basis: id("decision").optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  supersedes: text.optional(),
});
// Zod's optional fields include undefined in their inferred value types; domain omits them.
function defined<T extends object>(
  input: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}
function parsed<T>(
  schema: z.ZodType<T>,
  input: unknown,
  message = "Invalid request parameters",
): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new HttpRejection(
      400,
      "validation_failed",
      message,
      result.error.issues,
    );
  return result.data;
}
function rejected(error: DomainError): never {
  const status =
    error.code === "not_found"
      ? 404
      : ["unauthorized", "forbidden_tool"].includes(error.code)
        ? 403
        : error.code === "validation_failed"
          ? 400
          : 409;
  throw new HttpRejection(status, error.code, error.message);
}
function must<T>(result: Result<T>): T {
  if (!result.ok) return rejected(result.error);
  return result.value;
}
export interface WriteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly store: Store;
  readonly project_id: string;
  readonly clock: Clock;
  readonly dataDir: string;
  readonly mergeGate?: ProjectMergeGate | undefined;
  /** Recheck the session after body/file IO and inside the command transaction. */
  readonly authorize: () => unknown;
}
interface CommandContext extends WriteContext {
  readonly idempotency?: { readonly key: string; readonly request: unknown };
}
function execute<T>(
  c: CommandContext,
  operation: (tx: StoreTransactionContext) => T,
): T {
  // This synchronous check also applies to cached responses and conflicts.
  c.authorize();
  if (!c.idempotency) return c.store.uow.run(operation);
  const result = c.store.runHumanIdempotent(
    { project_id: c.project_id, ...c.idempotency },
    operation,
  );
  if (!result.ok && result.error.code === "idempotency_conflict")
    throw new HttpRejection(
      409,
      "idempotency_conflict",
      "这次操作的幂等键已用于不同的请求内容，请恢复原内容后重试。",
    );
  return must(result).value;
}
/** One human command, one fresh project snapshot and one atomic effect; failures roll back. */
function run<T>(
  c: CommandContext,
  reduce: (
    s: CommandState,
    a: Actor,
    p: CommandPorts,
  ) => Result<CommandEffect<T>>,
): T {
  return execute(c, (tx) => applyCommand(c, tx, reduce));
}
function applyCommand<T>(
  c: CommandContext,
  tx: StoreTransactionContext,
  reduce: (
    s: CommandState,
    a: Actor,
    p: CommandPorts,
  ) => Result<CommandEffect<T>>,
): T {
  c.authorize();
  const effect = must(
    reduce(
      loadCommandState(tx, c.project_id),
      { kind: "human", project_id: c.project_id },
      { clock: c.clock, ids: tx.ids },
    ),
  );
  persistEffect(tx, c.project_id, effect);
  return effect.data;
}
function cardResult<T>(result: Result<T>, operation: string): Result<T> {
  if (result.ok) return result;
  const code = result.error.code;
  const message =
    code === "not_found"
      ? "卡片在当前项目中不存在，请核对卡片编号。"
      : code === "illegal_transition"
        ? operation === "cancel"
          ? "已完成卡片不能取消；请建新卡，再把旧卡标记为被取代。"
          : "只有已完成或已取消的卡片才能标记为被取代。"
        : code === "validation_failed" && operation === "supersede"
          ? "卡片不能被自身取代，请填写同项目的另一张卡片编号。"
          : "卡片操作被拒绝，请检查填写的内容和卡片状态。";
  return { ok: false, error: { ...result.error, message } };
}
const routes =
  /^\/(cards|decisions|human-actions)\/([^/]+)\/(comments|instructions|attachments|resolve|complete|update|cancel|supersede|recheck-merge|mark-done)$/u;
/** Returns false for read routes, leaving M5.1's handlers and method checks intact. */
export async function serveWrite(
  c: WriteContext,
  rest: string,
): Promise<boolean> {
  if (rest === "/card-templates" || rest === "/card-templates/validate") {
    if (rest === "/card-templates" && c.req.method === "GET") return false;
    if (c.req.method !== "POST") methodNotAllowed(["POST"]);
    c.authorize();
    const body = await readJsonBody(c.req);
    // Zod checks transport types; domain rejects invalid unions, references and lifecycle changes.
    const input = parsed(
      templateChange,
      body,
      "模板字段格式不正确，请检查表单。",
    ) as TemplateChange;
    if (rest.endsWith("/validate")) {
      c.authorize();
      const result = c.store.uow.read((tx) =>
        manageCardTemplate(
          loadCommandState(tx, c.project_id),
          { kind: "human", project_id: c.project_id },
          input,
          previewPorts(c.clock.now()),
        ),
      );
      sendJson(c.res, 200, {
        valid: result.ok,
        reason: result.ok ? null : result.error.message,
      });
    } else {
      const key = parsed(
        requiredKey,
        c.req.headers["idempotency-key"],
        "模板写入需要 Idempotency-Key",
      );
      const output = run(
        { ...c, idempotency: { key, request: { method: "POST", rest, body } } },
        (s, a, ports) => manageCardTemplate(s, a, input, ports),
      );
      sendJson(c.res, 200, output);
    }
    return true;
  }
  if (rest === "/preferences") {
    if (c.req.method === "GET") return false;
    if (c.req.method !== "POST") methodNotAllowed(["GET", "POST"]);
    c.authorize();
    const body = await readJsonBody(c.req);
    const key = parsed(
      z
        .string()
        .min(1)
        .max(256)
        .refine((s) => s.trim().length > 0),
      c.req.headers["idempotency-key"],
      "偏好写入需要 Idempotency-Key",
    );
    const context: CommandContext = {
      ...c,
      idempotency: { key, request: { method: "POST", rest, body } },
    };
    const input = parsed(
      z
        .object({
          auto_merge_after_minutes: z
            .number()
            .int()
            .min(1)
            .max(1440)
            .nullable(),
        })
        .strict(),
      body,
    );
    const output = run(context, (s, a, ports) =>
      setProjectPreferences(s, a, input, ports),
    );
    sendJson(c.res, 200, output);
    return true;
  }
  const match = routes.exec(rest);
  if (!match) return false;
  const [, group, encoded, operation] = match;
  let key: string;
  try {
    key = decodeURIComponent(encoded ?? "");
  } catch {
    throw new HttpRejection(
      400,
      "validation_failed",
      "Malformed identifier encoding",
    );
  }
  const supported =
    group === "cards"
      ? [
          "comments",
          "instructions",
          "attachments",
          "update",
          "cancel",
          "supersede",
          "recheck-merge",
          "mark-done",
        ]
      : group === "decisions"
        ? ["comments", "resolve"]
        : ["complete"];
  if (!supported.includes(operation ?? "")) return false;
  if (c.req.method !== "POST") methodNotAllowed(["POST"]);
  c.authorize();
  const body = await readJsonBody(
    c.req,
    operation === "attachments" ? MAX_MCP_BODY_BYTES : undefined,
  );
  c.authorize();
  const header = c.req.headers["idempotency-key"];
  if (operation === "mark-done")
    parsed(requiredKey, header, "标记完成需要 Idempotency-Key");
  const context: CommandContext = {
    ...c,
    ...(header === undefined
      ? {}
      : {
          idempotency: {
            key: parsed(
              z
                .string()
                .min(1)
                .max(256)
                .refine((s) => s.trim().length > 0),
              header,
            ),
            request: { method: "POST", group, key, operation, body },
          },
        }),
  };
  if (context.idempotency) {
    const missing = Symbol("uncached request");
    try {
      // A replay needs no file IO or command validation against newer state.
      const cached = execute(context, () => {
        throw missing;
      });
      sendJson(c.res, 200, cached);
      return true;
    } catch (error) {
      if (error !== missing) throw error;
    }
  }
  let output: unknown;
  if (group === "cards") {
    const card_id = parsed(id("card"), key);
    if (operation === "mark-done") {
      const input = defined(
        parsed(
          z
            .object({
              result: text,
              attachments: z.array(z.string()).optional(),
            })
            .strict(),
          body,
          "请填写非空完成结果，并选择同卡证据附件。",
        ),
      );
      output = run(context, (s, a, ports) =>
        markCardDone(s, a, { card_id, ...input }, ports),
      );
    } else if (operation === "recheck-merge") {
      const input = parsed(
        z.object({ completion_id: id("delivery") }).strict(),
        body,
      );
      if (c.mergeGate?.status !== "enabled")
        throw new HttpRejection(
          409,
          "illegal_transition",
          c.mergeGate?.status === "invalid"
            ? c.mergeGate.reason
            : "该项目未启用合并闸门，不能重新检查。",
        );
      output = run(context, (s, a, ports) => {
        const plan = prepareMergePlan(s, card_id);
        if (!plan.ok)
          throw new HttpRejection(
            409,
            "illegal_transition",
            "暂时无法重新检查：请确认卡片仍待合并、当前完成申请已通过审核，且没有待处理的阻塞事项。",
          );
        if (plan.value.completion_id !== input.completion_id)
          throw new HttpRejection(
            409,
            "illegal_transition",
            "完成申请已更新，请刷新后重新检查。",
          );
        const latest = latestMergeCheck(
          s.events,
          card_id,
          plan.value.completion_id,
        );
        if (!latest || !["failed", "timed_out"].includes(latest.status))
          throw new HttpRejection(
            409,
            "illegal_transition",
            "当前完成申请没有失败或超时的检查结果，不能重新检查。",
          );
        return recheckMerge(
          {
            ...s,
            project_settings: {
              ...s.project_settings,
              merge_gate_enabled: true,
            },
          },
          a,
          { card_id },
          ports,
        );
      });
    } else if (operation === "update") {
      const p = defined(
        parsed(
          cardUpdate,
          body,
          "请填写非空标题、目标、至少一条验收标准及有效的数字优先级。",
        ),
      );
      output = run(context, (s, a, ports) =>
        cardResult(updateCard(s, a, { ...p, card_id }, ports), "update"),
      );
    } else if (operation === "cancel") {
      const { reason } = parsed(cardCancel, body, "取消原因须为文字，可留空。");
      // Cancellation and its optional explanation share the idempotent transaction.
      output = execute(context, (tx) => {
        const card = applyCommand(context, tx, (s, a, ports) =>
          cardResult(
            updateCard(s, a, { card_id, status: "cancelled" }, ports),
            "cancel",
          ),
        );
        if (reason?.trim())
          applyCommand(context, tx, (s, a, ports) =>
            postComment(
              s,
              a,
              { card_id, body: `取消卡片原因：${reason}` },
              ports,
            ),
          );
        return card;
      });
    } else if (operation === "supersede") {
      const p = parsed(
        cardSupersede,
        body,
        "请填写同项目的卡片编号，例如 C-123。",
      );
      output = run(context, (s, a, ports) =>
        cardResult(supersedeCard(s, a, { ...p, card_id }, ports), "supersede"),
      );
    } else if (operation === "comments") {
      const p = defined(parsed(comment, body));
      output = run(context, (s, a, ports) =>
        postComment(s, a, { ...p, card_id }, ports),
      );
    } else if (operation === "instructions") {
      const p = parsed(instruction, body);
      output = run(context, (s, a, ports) =>
        issueInstruction(s, a, { ...p, card_id }, ports),
      );
    } else {
      const { file, sha256, ...p } = defined(parsed(attachment, body));
      let receipt: Awaited<ReturnType<typeof prepareAttachmentFile>>;
      try {
        receipt = await prepareAttachmentFile(file, c.dataDir, sha256);
      } catch (error) {
        if (error instanceof ToolError) rejected(error.toDomainError());
        throw error;
      }
      // Published content-addressed blobs remain on rejection: another upload may already share them.
      output = run(context, (s, a, ports) =>
        uploadAttachment(s, a, { ...p, card_id }, receipt, ports),
      );
    }
  } else if (group === "decisions") {
    const decision_id = parsed(id("decision"), key);
    if (operation === "resolve") {
      const p = parsed(decision, body);
      output = execute(context, (tx) => {
        const q = tx.decisions.get(c.project_id, decision_id);
        // Keep the limit audit and decision in one human, idempotent transaction.
        // While the decision is still blocking, updateWorkItem cannot resume it.
        if (q?.trigger === "review_limit" && p.option === "raise_limit") {
          for (const work_item_id of new Set(q.affected_work_items)) {
            applyCommand(context, tx, (s, a, ports) => {
              const item = s.work_items.find((w) => w.id === work_item_id);
              return updateWorkItem(
                s,
                a,
                {
                  work_item_id,
                  max_review_rounds:
                    item?.kind === "verify" ? item.max_review_rounds + 1 : 0,
                },
                ports,
              );
            });
          }
        }
        return applyCommand(context, tx, (s, a, ports) => {
          const returning =
            p.option === "request_changes" &&
            s.decisions.find((q) => q.id === decision_id)?.trigger ===
              "merge_confirmation";
          const raw_quote =
            p.raw_quote?.trim() || returning
              ? (p.raw_quote ?? "")
              : `在 Needs You 选择了 ${p.option}`;
          return recordDecision(
            s,
            a,
            {
              decision_id,
              option: p.option,
              raw_quote,
              rationale: p.rationale?.trim() ? p.rationale : raw_quote,
            },
            ports,
          );
        });
      });
    } else {
      const p = parsed(clarification, body);
      output = run(context, (s, a, ports) => {
        const q = s.decisions.find((q) => q.id === decision_id);
        if (!q) throw new HttpRejection(404, "not_found", "Decision not found");
        if (!q.card_id)
          throw new HttpRejection(
            400,
            "validation_failed",
            "A project-level decision has no card timeline for comments",
          );
        const target =
          p.action === "explain"
            ? s.assignments.find(
                (x) =>
                  x.scope === "standing" &&
                  x.standing_mode === "office" &&
                  x.role_id === "pm" &&
                  x.status === "active",
              )?.id
            : q.raised_by.startsWith("assignment:")
              ? q.raised_by.slice(11)
              : undefined;
        if (!target)
          throw new HttpRejection(
            400,
            "validation_failed",
            "No Assignment is available for this clarification",
          );
        return postComment(
          s,
          a,
          {
            card_id: q.card_id,
            body:
              p.body ??
              (p.action === "explain"
                ? "请 PM 解释各选项的后果。"
                : "请补充这项决策所需的信息。"),
            refs: [{ kind: "decision", id: q.id }],
            mentions: [`@${target}`],
          },
          ports,
        );
      });
    }
  } else {
    const human_action_id = parsed(id("human_action"), key),
      p = defined(parsed(action, body));
    output = run(context, (s, a, ports) =>
      completeHumanAction(s, a, { ...p, human_action_id }, ports),
    );
  }
  sendJson(c.res, 200, output);
  return true;
}
