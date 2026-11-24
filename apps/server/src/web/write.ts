import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Actor,
  activateRole,
  activeOwner,
  autoMergeSchedule,
  builtinCardTemplatesForFlow,
  type Clock,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  cancelHumanAction,
  canRecheckMerge,
  completeHumanAction,
  confirmSourceMergeUnrelated,
  confirmStoryProposal,
  copyRole,
  createCard,
  createRole,
  DEFAULT_MAX_RUN_LIMIT,
  type DomainError,
  deactivateRole,
  isDecisionOther,
  issueInstruction,
  latestCardTemplate,
  MAX_REF_SLOT,
  manageCardTemplate,
  markCardDone,
  markNoticesRead,
  mergeOverrideReasonError,
  parseId,
  parseTimelineEntryId,
  postComment,
  prepareMergePlan,
  type ReadableIdKind,
  type Result,
  type RoleDefinition,
  type RoleEffect,
  type RolePatch,
  recheckMerge,
  recordDecision,
  recordHelperUpgradeChecks,
  rollbackRole,
  runLimitMaximumMessage,
  type SystemReminderPolicy,
  setCardSensitive,
  setMergeSolo,
  setMergeWindow,
  setProjectPreferences,
  setRunLimit,
  supersedeCard,
  type TemplateChange,
  updateCard,
  updateRole,
  updateWorkItem,
  uploadAttachment,
  workerHelperAction,
} from "@cardigan/domain";
import {
  applyRoleDocument,
  effectiveRunLimit,
  type ProjectMergeGate,
  previewPorts,
  previewRoleDocument,
  RoleDocumentError,
  runCapacityMachines,
} from "@cardigan/host";
import {
  attachmentTooLargeMessage,
  loadCommandState,
  MAX_ATTACHMENT_BASE64,
  MAX_MCP_BODY_BYTES,
  persistEffect,
  prepareAttachmentFile,
  projectRepositories,
  ToolError,
} from "@cardigan/mcp-server";
import {
  defaultRoleDefinition,
  exportRoleMarkdown,
  HARNESSES,
  isDefaultRoleId,
  RoleMarkdownError,
} from "@cardigan/roles";
import {
  getRoleVersion,
  listRoleVersions,
  persistRoleEffect,
  persistRunLimitEffect,
  type ReadRepositories,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import { z } from "zod";
import { requireEmployeeOwner, serveEmployees } from "./employees.js";
import {
  HttpRejection,
  MAX_JSON_BODY_BYTES,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";

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
const cardComment = comment.extend({
  story_discussion: z
    .discriminatedUnion("action", [
      z
        .object({
          action: z.literal("answer"),
          group_id: entryId,
          number: z.number().int().positive(),
          answer: text,
        })
        .strict(),
      z
        .object({ action: z.literal("accept_defaults"), group_id: entryId })
        .strict(),
    ])
    .optional(),
});
const instruction = z.object({
  body: text,
  work_item_id: id("work_item"),
  decision_id: id("decision").optional(),
});
const cardUpdate = z
  .object({
    hold: z
      .object({ reason: text, resume_condition: text })
      .strict()
      .nullable()
      .optional(),
    high_risk: z.boolean().optional(),
    title: text.optional(),
    goal: text.optional(),
    acceptance_criteria: z.array(text).min(1).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    risk_tags: z
      .array(z.enum(["security", "permission", "numeric_rule"]))
      .optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0);
const cardCancel = z
  .object({
    reason: z.string().optional(),
    story_children: z
      .object({
        action: z.enum(["cancel", "detach"]),
        ids: z.array(id("card")),
      })
      .strict()
      .optional(),
  })
  .strict();
const cardSupersede = z.object({ superseded_by: id("card") }).strict();
const cardSensitive = z.object({ sensitive: z.boolean() }).strict();
const decision = z.object({
  option: text,
  merge_override_reason: z
    .string()
    .superRefine((reason, context) => {
      const message = mergeOverrideReasonError(reason);
      if (message) context.addIssue({ code: "custom", message });
    })
    .optional(),
  rationale: z.string().optional(),
  snooze_until: z.string().optional(),
  raw_quote: z.string().optional(),
  delegate_future: z.boolean().optional(),
  /** C-192: "按建议处理"; the domain accepts it only from a human Actor. */
  via_suggestion: z.boolean().optional(),
  suggestion_progress_token: z.string().optional(),
  suggestion_version: z.number().int().nonnegative().optional(),
});
const clarification = z.object({
  action: z.enum(["request_information", "explain"]),
  body: text.optional(),
});
const action = z
  .object({
    text,
    conclusion: z.enum(["false_alarm", "exited", "unconfirmed"]).optional(),
    attachments: z.array(text).optional(),
  })
  .strict();
const attachment = z.object({
  file: z.string().max(MAX_ATTACHMENT_BASE64, attachmentTooLargeMessage()),
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
  // C-615: the `attachment-new-N` of the comment this file fills.
  ref_slot: z.number().int().min(1).max(MAX_REF_SLOT).optional(),
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
  readonly checks?: import("./machine-checks.js").MachineChecks;
  readonly roleLaunchConfig?:
    | (() => import("@cardigan/roles").LaunchConfig | undefined)
    | undefined;
  readonly launchProfiles?: (() => readonly string[]) | undefined;
  readonly runLimit?: ((machine: string) => number) | undefined;
  readonly runLimitMaximum?: ((machine: string) => number) | undefined;
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
      loadCommandState(tx, c.project_id, {
        ...(c.mergeGate?.status === "enabled" && c.mergeGate.queue
          ? { merge_queue: { max_batch_size: c.mergeGate.queue.maxBatchSize } }
          : {}),
        merge_gate_enabled:
          c.mergeGate !== undefined && c.mergeGate.status !== "disabled",
      }),
      { kind: "human", project_id: c.project_id },
      { clock: c.clock, ids: tx.ids },
    ),
  );
  persistEffect(tx, c.project_id, effect);
  return effect.data;
}
function cardResult<T>(result: Result<T>, operation: string): Result<T> {
  if (
    result.ok ||
    (operation === "cancel" && /[\u3400-\u9fff]/u.test(result.error.message))
  )
    return result;
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
const ROLE_FIELD_LABELS: Readonly<Record<string, string>> = {
  role_id: "角色编号",
  display_name: "显示名",
  launch_profile_ref: "启动配置",
  "core_prompt 或 instructions": "角色说明（instructions）",
};
/** Domain role errors are partly English; the Workbench always answers in Chinese. */
function roleResult<T>(result: Result<T>, role_id: string): Result<T> {
  if (result.ok || /\p{Script=Han}/u.test(result.error.message)) return result;
  const { code, message } = result.error;
  const required = /^(.+) is required$/u.exec(message)?.[1];
  const text =
    code === "not_found"
      ? `角色 ${role_id} 或指定版本不存在，请刷新后重试。`
      : /already exists/u.test(message)
        ? `角色编号 ${role_id} 已存在，请换一个编号。`
        : required !== undefined
          ? `${ROLE_FIELD_LABELS[required] ?? required} 不能为空。`
          : "角色内容不符合要求，请检查后重试。";
  return { ok: false, error: { ...result.error, message: text } };
}
/** Project and role identifiers, as the CLI accepts them. */
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/u;
const roleList = z.array(z.string());
const roleFields = {
  display_name: z.string(),
  kind: z.enum(["produce", "verify", "standing"]),
  instructions: z.string(),
  harness: z.enum(HARNESSES),
  launch_profile_ref: z.string(),
  allowed_tools: roleList,
  capabilities: roleList,
  abilities: roleList,
  worktree: z.enum(["none", "readonly", "write"]),
  required_machine_tags: roleList,
};
// No actor, version or status fields: the human session is the only actor.
const roleCreate = z.object({ role_id: z.string(), ...roleFields }).strict();
const rolePatch = z
  .object(roleFields)
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0);
const roleCopy = z
  .object({
    role_id: z.string(),
    display_name: z.string().optional(),
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("default"),
          role_id: z.string(),
          harness: z.enum(HARNESSES),
          launch_profile_ref: text,
        })
        .strict(),
      z
        .object({
          kind: z.literal("project"),
          project_id: z.string().optional(),
          role_id: z.string(),
          version: z.number().int().positive().optional(),
        })
        .strict(),
    ]),
  })
  .strict();
const roleRoute =
  /^\/roles(?:\/(copy)|\/([^/]+)\/(update|activate|deactivate|rollback))?$/u;
const ROLE_INPUT_MESSAGE =
  "角色内容格式不正确：请检查字段名称、类型（产出、验证或常驻）、worktree 模式和列表字段。";

/** V9b: role writes call V9a's domain commands as the logged-in human, idempotently. */
async function serveRoleWrite(c: WriteContext, rest: string): Promise<boolean> {
  const match = roleRoute.exec(rest);
  if (!match || c.req.method === "GET") return false;
  if (c.req.method !== "POST") methodNotAllowed(["GET", "POST"]);
  const [, copy, encoded, operation] = match;
  if (!copy && !operation && rest !== "/roles") return false;
  c.authorize();
  const body = await readJsonBody(c.req);
  c.authorize();
  const key = parsed(
    z
      .string()
      .min(1)
      .max(256)
      .refine((s) => s.trim().length > 0),
    c.req.headers["idempotency-key"],
    "角色写入需要 Idempotency-Key",
  );
  let target: string;
  try {
    target = decodeURIComponent(encoded ?? "");
  } catch {
    throw new HttpRejection(400, "validation_failed", "角色编号编码不正确");
  }
  const context: CommandContext = {
    ...c,
    idempotency: { key, request: { method: "POST", rest, body } },
  };
  let role_id: string;
  let command: (
    state: { project_id: string; roles: ReturnType<typeof listRoleVersions> },
    actor: Actor,
    ports: CommandPorts,
    tx: StoreTransactionContext,
  ) => Result<RoleEffect>;
  if (copy) {
    const input = parsed(roleCopy, body, ROLE_INPUT_MESSAGE);
    // Same identifier rule as `cardigan project create`; checked before any lookup.
    if (
      input.source.kind === "project" &&
      input.source.project_id !== undefined &&
      !IDENTIFIER.test(input.source.project_id)
    )
      throw new HttpRejection(
        400,
        "validation_failed",
        "来源项目编号不合法：只能用小写字母、数字、点、下划线和短横线，且以字母或数字开头。",
      );
    role_id = input.role_id;
    command = (state, actor, ports, tx) => {
      let source: RoleDefinition;
      if (input.source.kind === "default") {
        if (!isDefaultRoleId(input.source.role_id))
          throw new HttpRejection(
            404,
            "not_found",
            `默认角色包没有 ${input.source.role_id}`,
          );
        source = defaultRoleDefinition(input.source.role_id, {
          harness: input.source.harness,
          launch_profile_ref: input.source.launch_profile_ref,
        });
      } else {
        const project = input.source.project_id ?? c.project_id;
        if (!c.store.getProject(project))
          throw new HttpRejection(
            404,
            "not_found",
            `来源项目 ${project} 不存在`,
          );
        const found = getRoleVersion(
          tx,
          project,
          input.source.role_id,
          input.source.version,
        );
        if (!found)
          throw new HttpRejection(
            404,
            "not_found",
            `来源角色 ${input.source.role_id} 的指定版本不存在`,
          );
        source = found;
      }
      return copyRole(
        state,
        actor,
        {
          source,
          role_id,
          ...(input.display_name?.trim()
            ? { display_name: input.display_name }
            : {}),
        },
        ports,
      );
    };
  } else if (!operation) {
    const input = parsed(roleCreate, body, ROLE_INPUT_MESSAGE);
    role_id = input.role_id;
    command = (state, actor, ports) =>
      createRole(state, actor, input as RoleDefinition, ports);
  } else {
    role_id = target;
    if (operation === "update") {
      const patch = parsed(rolePatch, body, ROLE_INPUT_MESSAGE) as RolePatch;
      command = (state, actor, ports) =>
        updateRole(state, actor, role_id, patch, ports);
    } else if (operation === "rollback") {
      const { version } = parsed(
        z.object({ version: z.number().int().positive() }).strict(),
        body,
        "回退需要填写正整数版本号。",
      );
      command = (state, actor, ports) =>
        rollbackRole(state, actor, role_id, version, ports);
    } else {
      parsed(z.object({}).strict(), body, "启用或停用不接受其他参数。");
      command = (state, actor, ports) =>
        (operation === "activate" ? activateRole : deactivateRole)(
          state,
          actor,
          role_id,
          ports,
        );
    }
  }
  const output = execute(context, (tx) => {
    c.authorize();
    const effect = must(
      roleResult(
        command(
          {
            project_id: c.project_id,
            roles: listRoleVersions(tx, c.project_id),
          },
          { kind: "human", project_id: c.project_id },
          { clock: c.clock, ids: tx.ids },
          tx,
        ),
        role_id,
      ),
    );
    const ref = effect.data.launch_profile_ref;
    if (operation !== "deactivate" && !c.launchProfiles?.().includes(ref))
      throw new HttpRejection(
        400,
        "validation_failed",
        `角色 ${role_id} 引用的启动配置 ${ref} 不存在于 launch.yaml`,
      );
    persistRoleEffect(tx, c.project_id, effect);
    return effect.data;
  });
  sendJson(c.res, 200, output);
  return true;
}
const routes =
  /^\/(cards|decisions|human-actions)\/([^/]+)\/(comments|instructions|attachments|resolve|complete|update|cancel|supersede|recheck-merge|mark-done|story-confirm|sensitive|merge-solo|merge-window|source-unrelated)$/u;
/** Returns false for read routes, leaving M5.1's handlers and method checks intact. */
export async function serveWrite(
  c: WriteContext,
  rest: string,
): Promise<boolean> {
  const exportId = /^\/roles\/([a-z0-9][a-z0-9._-]*)\/export$/u.exec(rest)?.[1];
  if (exportId) {
    if (c.req.method !== "GET") methodNotAllowed(["GET"]);
    c.authorize();
    const role = c.store.uow.read((tx) =>
      getRoleVersion(tx, c.project_id, exportId),
    );
    if (!role) throw new HttpRejection(404, "not_found", "角色不存在");
    sendJson(c.res, 200, { markdown: exportRoleMarkdown(role) });
    return true;
  }
  if (rest === "/role-document/preview" || rest === "/role-document/apply") {
    if (c.req.method !== "POST") methodNotAllowed(["POST"]);
    c.authorize();
    if (c.req.headers.authorization !== undefined)
      throw new HttpRejection(403, "unauthorized", "仅支持人类会话");
    // The document ceiling is measured after JSON decoding. An escaped byte can take
    // six wire bytes; reserve the snapshot envelope separately so preview remains applicable.
    const apply = rest.endsWith("/apply");
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify(
        apply ? { markdown: "", snapshot: "0".repeat(64) } : { markdown: "" },
      ),
    );
    const body = await readJsonBody(
      c.req,
      6 * MAX_JSON_BODY_BYTES + envelopeBytes,
    );
    if (
      typeof body.markdown === "string" &&
      Buffer.byteLength(body.markdown) > MAX_JSON_BODY_BYTES
    )
      throw new HttpRejection(
        413,
        "payload_too_large",
        "Markdown 文件不能超过 64 KiB",
      );
    const context = {
      ...c,
      actor: { kind: "human" as const, project_id: c.project_id },
      launchConfig: c.roleLaunchConfig ?? (() => undefined),
      authorize: (
        tx: Pick<ReadRepositories, "members">,
        employees: boolean,
      ) => {
        if (employees) requireEmployeeOwner(c, tx);
        else c.authorize();
      },
    };
    const schema = z.strictObject({ markdown: z.string() });
    try {
      if (!apply)
        sendJson(
          c.res,
          200,
          previewRoleDocument(context, parsed(schema, body).markdown),
        );
      else {
        const { markdown, snapshot } = parsed(
          schema.extend({ snapshot: z.string() }),
          body,
        );
        const key = parsed(
          requiredKey,
          c.req.headers["idempotency-key"],
          "应用需要 Idempotency-Key",
        );
        sendJson(
          c.res,
          200,
          applyRoleDocument(context, markdown, snapshot, key),
        );
      }
    } catch (e) {
      if (e instanceof RoleDocumentError) rejected(e);
      if (e instanceof RoleMarkdownError)
        throw new HttpRejection(400, "validation_failed", e.message);
      throw e;
    }
    return true;
  }
  if (await serveEmployees(c, rest)) return true;
  if (rest === "/cards" && c.req.method === "POST") {
    c.authorize();
    const body = await readJsonBody(c.req);
    const key = parsed(
      requiredKey,
      c.req.headers["idempotency-key"],
      "创建卡片需要 Idempotency-Key",
    );
    const input = parsed(
      z
        .object({
          template_id: text,
          title: text,
          goal: text,
          acceptance_criteria: z.array(text).optional(),
          parent_card_id: id("card").optional(),
          state_and_save: z
            .union([
              z.literal("无写入"),
              z
                .object({
                  save_timing: text,
                  leave_behavior: text,
                  failure_feedback: text,
                  consistency: text,
                })
                .strict(),
            ])
            .optional(),
        })
        .strict(),
      body,
    );
    const card = run(
      { ...c, idempotency: { key, request: { method: "POST", rest, body } } },
      (state, actor, ports) => {
        const template = latestCardTemplate(
          [
            ...(state.card_templates ?? []),
            ...builtinCardTemplatesForFlow(
              state.project_preferences?.find((p) => p.id === state.project_id)
                ?.flow_version,
            ),
          ],
          input.template_id,
        );
        const project = template?.requires_repo
          ? c.store.getProject(c.project_id)
          : undefined;
        return createCard(
          state,
          actor,
          {
            title: input.title,
            goal: input.goal,
            template_id: input.template_id,
            acceptance_criteria: input.acceptance_criteria ?? [],
            source: { kind: "quote", text: input.goal },
            ...(input.parent_card_id
              ? { parent_card_id: input.parent_card_id }
              : {}),
            ...(input.state_and_save
              ? { state_and_save: input.state_and_save }
              : {}),
            ...(project?.repo_path && project.base_branch
              ? { repo: project.repo_path, base_branch: project.base_branch }
              : {}),
          },
          ports,
        );
      },
    );
    sendJson(c.res, 201, { id: card.id });
    return true;
  }
  if (rest === "/card-templates" || rest === "/card-templates/validate") {
    // "validate" is also a legal template ID: GET reads its details, POST previews.
    if (c.req.method === "GET") return false;
    if (c.req.method !== "POST") methodNotAllowed(["GET", "POST"]);
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
  if (rest === "/roles" || rest.startsWith("/roles/"))
    return serveRoleWrite(c, rest);
  if (rest === "/execution/capacity") {
    if (c.req.method === "GET") return false;
    if (c.req.method !== "POST") methodNotAllowed(["GET", "POST"]);
    c.authorize();
    const body = await readJsonBody(c.req);
    const key = parsed(
      requiredKey,
      c.req.headers["idempotency-key"],
      "并发上限写入需要 Idempotency-Key",
    );
    const input = parsed(
      z
        .object({
          machine_id: text,
          limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
      body,
    );
    const maximum =
      c.runLimitMaximum?.(input.machine_id) ?? DEFAULT_MAX_RUN_LIMIT;
    parsed(
      z.number().max(maximum),
      input.limit,
      runLimitMaximumMessage(maximum),
    );
    const output = execute(
      { ...c, idempotency: { key, request: { method: "POST", rest, body } } },
      (tx) => {
        const session = c.authorize();
        const member = activeOwner(tx.members.list());
        if (
          !member ||
          !session ||
          typeof session !== "object" ||
          !("member_id" in session) ||
          session.member_id !== member.id
        )
          throw new HttpRejection(403, "unauthorized", "没有有效的人成员身份");
        const effect = must(
          setRunLimit({ kind: "human", project_id: c.project_id }, input, {
            machines: runCapacityMachines(c.store, tx),
            previous: effectiveRunLimit(
              c.store,
              input.machine_id,
              c.runLimit,
              c.runLimitMaximum,
            ),
            maximum,
            member_id: member.id,
            clock: c.clock,
            ids: tx.global_ids,
          }),
        );
        persistRunLimitEffect(c.store.database, tx, effect);
        return effect.setting;
      },
    );
    sendJson(c.res, 200, output);
    return true;
  }
  const manualWorkItem = /^\/work-items\/(W-[0-9]+)\/manual-assign$/.exec(rest);
  if (manualWorkItem) {
    if (c.req.method !== "POST") methodNotAllowed(["POST"]);
    c.authorize();
    const input = parsed(
      z.object({ manual_assign: z.boolean() }).strict(),
      await readJsonBody(c.req),
    );
    const work_item_id = parsed(id("work_item"), manualWorkItem[1]);
    const key = parsed(
      text,
      c.req.headers["idempotency-key"],
      "工作项写入需要 Idempotency-Key",
    );
    const context: CommandContext = {
      ...c,
      idempotency: { key, request: { rest, input } },
    };
    sendJson(
      c.res,
      200,
      run(context, (s, a, ports) =>
        updateWorkItem(
          s,
          a,
          { work_item_id, manual_assign: input.manual_assign },
          ports,
        ),
      ),
    );
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
          system_auto_assign_verifiers: z.boolean().optional(),
          system_reminders: z.boolean().optional(),
          pm_owner_messages: z.boolean().optional(),
          system_reminder_policy: z.unknown().optional(),
          cross_card_read: z.boolean().optional(),
          auto_merge_paused: z.boolean().optional(),
          auto_merge: z.enum(["off", "on"]).optional(),
          high_risk_paths: z.array(z.string()).optional(),
          auto_merge_after_minutes: z
            .number()
            .int()
            .min(1)
            .max(1440)
            .nullable()
            .optional(),
          merge_confirm_snooze_default_minutes: z
            .number()
            .int()
            .min(1)
            .max(1440)
            .optional(),
          merge_confirm_snooze_max_minutes: z
            .number()
            .int()
            .min(60)
            .max(10080)
            .optional(),
          merge_confirm_stall_after_minutes: z
            .number()
            .int()
            .min(1)
            .max(1440)
            .optional(),
          decision_delegation: z.record(z.string(), z.boolean()).optional(),
          pm_merge_confirmation: z.boolean().optional(),
          pm_confirm_role_rule_implementations: z.boolean().optional(),
          pm_confirm_human_decided_merges: z.boolean().optional(),
          // C-253: the range (integers 1..REVIEW_MAX_ROUNDS_CEILING) is checked by the domain.
          review_max_rounds: z.number().optional(),
          independent_review_max_rounds: z.number().optional(),
          independent_review_limit_delegation: z.boolean().optional(),
          independent_review_limit_delegation_max: z
            .number()
            .nullable()
            .optional(),
          board_collapsed_lanes: z
            .record(z.string().max(64), z.boolean().nullable())
            .optional(),
        })
        .strict(),
      body,
    );
    const output = run(context, (s, a, ports) =>
      setProjectPreferences(
        s,
        a,
        {
          ...(input.system_auto_assign_verifiers !== undefined
            ? {
                system_auto_assign_verifiers:
                  input.system_auto_assign_verifiers,
              }
            : {}),
          ...(input.pm_owner_messages !== undefined
            ? { pm_owner_messages: input.pm_owner_messages }
            : {}),
          ...(input.system_reminders !== undefined
            ? { system_reminders: input.system_reminders }
            : {}),
          ...(input.system_reminder_policy !== undefined
            ? {
                system_reminder_policy:
                  input.system_reminder_policy as SystemReminderPolicy | null,
              }
            : {}),
          ...(input.cross_card_read !== undefined
            ? { cross_card_read: input.cross_card_read }
            : {}),
          ...(input.auto_merge !== undefined
            ? { auto_merge: input.auto_merge }
            : {}),
          ...(input.high_risk_paths !== undefined
            ? { high_risk_paths: input.high_risk_paths }
            : {}),
          ...(input.auto_merge_paused !== undefined
            ? { auto_merge_paused: input.auto_merge_paused }
            : {}),
          ...(input.auto_merge_after_minutes !== undefined
            ? { auto_merge_after_minutes: input.auto_merge_after_minutes }
            : {}),
          ...(input.merge_confirm_stall_after_minutes !== undefined
            ? {
                merge_confirm_stall_after_minutes:
                  input.merge_confirm_stall_after_minutes,
              }
            : {}),
          ...(input.merge_confirm_snooze_default_minutes !== undefined
            ? {
                merge_confirm_snooze_default_minutes:
                  input.merge_confirm_snooze_default_minutes,
              }
            : {}),
          ...(input.merge_confirm_snooze_max_minutes !== undefined
            ? {
                merge_confirm_snooze_max_minutes:
                  input.merge_confirm_snooze_max_minutes,
              }
            : {}),
          ...(input.decision_delegation !== undefined
            ? { decision_delegation: input.decision_delegation }
            : {}),
          ...(input.pm_confirm_role_rule_implementations !== undefined
            ? {
                pm_confirm_role_rule_implementations:
                  input.pm_confirm_role_rule_implementations,
              }
            : {}),
          ...(input.pm_confirm_human_decided_merges !== undefined
            ? {
                pm_confirm_human_decided_merges:
                  input.pm_confirm_human_decided_merges,
              }
            : {}),
          ...(input.pm_merge_confirmation !== undefined
            ? { pm_merge_confirmation: input.pm_merge_confirmation }
            : {}),
          ...(input.board_collapsed_lanes !== undefined
            ? { board_collapsed_lanes: input.board_collapsed_lanes }
            : {}),
          ...(input.review_max_rounds !== undefined
            ? { review_max_rounds: input.review_max_rounds }
            : {}),
          ...(input.independent_review_max_rounds !== undefined
            ? {
                independent_review_max_rounds:
                  input.independent_review_max_rounds,
              }
            : {}),
          ...(input.independent_review_limit_delegation !== undefined
            ? {
                independent_review_limit_delegation:
                  input.independent_review_limit_delegation,
              }
            : {}),
          ...(input.independent_review_limit_delegation_max !== undefined
            ? {
                independent_review_limit_delegation_max:
                  input.independent_review_limit_delegation_max,
              }
            : {}),
        },
        ports,
      ),
    );
    sendJson(c.res, 200, output);
    return true;
  }
  if (rest === "/notices/read") {
    if (c.req.method !== "POST") methodNotAllowed(["POST"]);
    c.authorize();
    const body = await readJsonBody(c.req);
    const input = parsed(
      z
        .object({
          notice_ids: z.array(z.string().min(1).max(64)).min(1).max(200),
        })
        .strict(),
      body,
    );
    const output = run(c, (s, a, ports) => markNoticesRead(s, a, input, ports));
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
          "story-confirm",
          "sensitive",
          "merge-solo",
          "merge-window",
        ]
      : group === "decisions"
        ? ["comments", "resolve", "source-unrelated"]
        : ["complete", "cancel"];
  if (!supported.includes(operation ?? "")) return false;
  if (c.req.method !== "POST") methodNotAllowed(["POST"]);
  c.authorize();
  const body =
    operation === "attachments"
      ? await readJsonBody(
          c.req,
          MAX_MCP_BODY_BYTES,
          attachmentTooLargeMessage(),
        )
      : await readJsonBody(c.req);
  c.authorize();
  const header = c.req.headers["idempotency-key"];
  if (operation === "mark-done")
    parsed(requiredKey, header, "标记完成需要 Idempotency-Key");
  if (operation === "story-confirm")
    parsed(requiredKey, header, "确认开卡需要 Idempotency-Key");
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
  const missing = Symbol("uncached request");
  const replay = () => {
    if (!context.idempotency) return missing;
    try {
      return execute<unknown>(context, () => {
        throw missing;
      });
    } catch (error) {
      if (error !== missing) throw error;
      return missing;
    }
  };
  const cached = replay();
  if (cached !== missing) {
    sendJson(c.res, 200, cached);
    return true;
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
              // C-503: the story summary the person confirmed against.
              story_summary_entry_id: entryId.optional(),
            })
            .strict(),
          body,
          "请填写非空完成结果，并选择同卡证据附件。",
        ),
      );
      output = run(context, (s, a, ports) =>
        markCardDone(s, a, { card_id, ...input }, ports),
      );
    } else if (operation === "story-confirm") {
      // C-503: the human session confirms the version it saw; the domain opens
      // every child in this one transaction or none.
      const input = parsed(
        z.object({ version: z.number().int().positive() }).strict(),
        body,
        "请提交所确认的拆解方案版本号。",
      );
      output = run(context, (s, a, ports) =>
        confirmStoryProposal(
          s,
          a,
          { card_id, version: input.version },
          {
            ...ports,
            project_repositories: projectRepositories(c.store, a.project_id),
          },
        ),
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
        if (!canRecheckMerge(s.events, card_id, plan.value.completion_id))
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
      const { reason, story_children } = parsed(
        cardCancel,
        body,
        "取消原因须为文字，可留空。",
      );
      // Cancellation and its optional explanation share the idempotent transaction.
      output = execute(context, (tx) => {
        const card = applyCommand(context, tx, (s, a, ports) =>
          cardResult(
            updateCard(
              s,
              a,
              {
                card_id,
                status: "cancelled",
                ...(story_children ? { story_children } : {}),
              },
              ports,
            ),
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
    } else if (operation === "merge-solo") {
      const p = parsed(
        z.object({ solo: z.boolean() }).strict(),
        body,
        "solo 须为布尔值。",
      );
      output = run(context, (s, a, ports) =>
        setMergeSolo(
          s,
          a,
          { ...p, card_id, reason: "人在卡片详情设置" },
          ports,
        ),
      );
    } else if (operation === "merge-window") {
      const p = parsed(
        z.object({ open: z.boolean(), reason: z.string().min(1) }).strict(),
        body,
        "需要窗口状态和理由。",
      );
      output = run(context, (s, a, ports) =>
        setMergeWindow(s, a, { ...p, card_id }, ports),
      );
    } else if (operation === "sensitive") {
      // C-65: human-only; the domain rejects any agent actor.
      const p = parsed(cardSensitive, body, "sensitive 须为 true 或 false。");
      // C-72: tell the Workbench whether the flag actually changed, so a
      // no-op unmark does not promise a restarted auto-merge timeout.
      output = run(context, (s, a, ports) => {
        const result = setCardSensitive(s, a, { ...p, card_id }, ports);
        if (!result.ok) return result;
        const changed = result.value.events.some(
          (e) => e.type === "card_sensitivity_changed",
        );
        let auto_merge_due_at: string | null = null;
        if (!changed)
          for (const q of s.decisions) {
            if (q.trigger !== "merge_confirmation" || q.card_id !== card_id)
              continue;
            const schedule = autoMergeSchedule(s, q.id);
            if (
              schedule.ok &&
              (auto_merge_due_at === null ||
                Date.parse(schedule.value.due_at) <
                  Date.parse(auto_merge_due_at))
            )
              auto_merge_due_at = schedule.value.due_at;
          }
        return {
          ok: true as const,
          value: {
            ...result.value,
            data: { card: result.value.data, changed, auto_merge_due_at },
          },
        };
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
      const p = defined(parsed(cardComment, body));
      output = run(context, (s, a, ports) =>
        postComment(s, a, { ...p, card_id }, ports),
      );
    } else if (operation === "instructions") {
      const p = parsed(instruction, body);
      output = run(context, (s, a, ports) =>
        issueInstruction(s, a, { ...p, card_id }, ports),
      );
    } else {
      // Name the configured limit instead of a generic schema failure (C-616).
      if (
        typeof body.file === "string" &&
        body.file.length > MAX_ATTACHMENT_BASE64
      )
        throw new HttpRejection(
          413,
          "payload_too_large",
          attachmentTooLargeMessage(),
        );
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
    if (operation === "source-unrelated") {
      const p = parsed(
        z
          .object({
            card_id: id("card"),
            source_decision_id: id("decision"),
            version: z.number().int().positive(),
          })
          .strict(),
        body,
      );
      output = run(context, (s, a, ports) =>
        confirmSourceMergeUnrelated(
          s,
          a,
          { ...p, decision_id },
          { ...ports, human_confirmation: "workbench" },
        ),
      );
    } else if (operation === "resolve") {
      const p = parsed(decision, body);
      output = run(context, (s, a, ports) => {
        const returning =
          ["request_changes", "hold"].includes(p.option) &&
          s.decisions.find((q) => q.id === decision_id)?.trigger ===
            "merge_confirmation";
        const scopeRequired =
          ["narrow_scope", "split_card"].includes(p.option) &&
          s.decisions.find((q) => q.id === decision_id)?.trigger ===
            "review_limit";
        // C-682: "其他" is the owner's own words; never substitute a default.
        const raw_quote =
          (p.option === "hold" && returning) ||
          scopeRequired ||
          isDecisionOther(p.option)
            ? p.raw_quote?.trim() || p.rationale?.trim() || ""
            : p.raw_quote?.trim() || returning
              ? (p.raw_quote ?? "")
              : `在 Needs You 选择了 ${p.option}`;
        if (p.via_suggestion)
          // The domain writes "按建议处理" into the record and falls back to
          // the suggestion's reason; a return keeps the (edited) reason.
          return recordDecision(
            s,
            a,
            {
              decision_id,
              option: p.option,
              via_suggestion: true,
              ...(p.suggestion_version !== undefined
                ? { suggestion_version: p.suggestion_version }
                : {}),
              ...(p.suggestion_progress_token !== undefined
                ? { suggestion_progress_token: p.suggestion_progress_token }
                : {}),
              ...(p.merge_override_reason !== undefined
                ? { merge_override_reason: p.merge_override_reason }
                : {}),
              raw_quote: p.raw_quote ?? "",
              rationale:
                p.rationale?.trim() || (returning ? (p.raw_quote ?? "") : ""),
            },
            { ...ports, human_confirmation: "workbench" },
          );
        return recordDecision(
          s,
          a,
          {
            decision_id,
            option: p.option,
            ...(p.merge_override_reason !== undefined
              ? { merge_override_reason: p.merge_override_reason }
              : {}),
            ...(p.snooze_until !== undefined
              ? { snooze_until: p.snooze_until }
              : {}),
            ...(p.delegate_future ? { delegate_future: true } : {}),
            raw_quote,
            rationale: p.rationale?.trim() ? p.rationale : raw_quote,
          },
          { ...ports, human_confirmation: "workbench" },
        );
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
    const human_action_id = parsed(id("human_action"), key);
    if (operation === "cancel") {
      const p = parsed(z.object({ reason: text }).strict(), body);
      output = run(context, (s, a, ports) =>
        cancelHumanAction(s, a, { ...p, human_action_id }, ports),
      );
    } else {
      const p = defined(parsed(action, body));
      const readUpgrade = () =>
        c.store.uow.read((tx) => {
          const stored = tx.human_actions.get(c.project_id, human_action_id);
          if (stored?.status !== "open" || stored.requested_by !== "system")
            return undefined;
          const target = workerHelperAction(
            loadCommandState(tx, c.project_id),
            stored,
          );
          if (!target) return undefined;
          const machine =
            target.machine_id &&
            tx.machines.get(c.project_id, target.machine_id);
          const binding = stored.helper_upgrade
            ? stored.helper_upgrade.binding
            : (machine && c.checks?.currentBinding(c.project_id, machine)) ||
              null;
          return { machine_id: target.machine_id, binding };
        });
      if (readUpgrade()) {
        if (c.req.headers.authorization !== undefined)
          throw new HttpRejection(403, "unauthorized", "仅限人类登录会话");
        const authorizeCheck = (tx: StoreTransactionContext) => {
          const session = c.authorize(),
            member = activeOwner(tx.members.list());
          if (
            !member ||
            !session ||
            typeof session !== "object" ||
            !("member_id" in session) ||
            session.member_id !== member.id
          )
            throw new HttpRejection(
              403,
              "unauthorized",
              "需要有效的人成员身份",
            );
          return member.id;
        };
        if (!c.checks)
          throw new HttpRejection(503, "unavailable", "检查服务不可用");
        const service = c.checks;
        output = await service.withHelperConfirmation(
          c.project_id,
          human_action_id,
          async () => {
            c.store.uow.run(authorizeCheck);
            const cached = replay();
            if (cached !== missing) return cached;
            const upgrade = readUpgrade();
            if (!upgrade)
              throw new HttpRejection(
                409,
                "illegal_transition",
                "升级待办已变化",
              );
            const checks = await service.verifyHelper(
              c.project_id,
              upgrade.machine_id,
              upgrade.binding,
              authorizeCheck,
            );
            return run(context, (s, a, ports) => {
              const registered = s.machines?.find(
                (m) => m.id === upgrade.machine_id,
              );
              const current = c.checks?.currentBinding(
                c.project_id,
                registered,
              );
              const changed = {
                status: "failed",
                failed_steps: ["无法确认当前机器绑定"],
              } as const;
              return recordHelperUpgradeChecks(
                s,
                a,
                {
                  ...p,
                  human_action_id,
                  ...upgrade,
                  checks:
                    current === upgrade.binding
                      ? checks
                      : { worker: changed, machine: changed },
                },
                ports,
              );
            });
          },
        );
      } else
        output = run(context, (s, a, ports) =>
          completeHumanAction(s, a, { ...p, human_action_id }, ports),
        );
    }
  }
  sendJson(c.res, 200, output);
  return true;
}
