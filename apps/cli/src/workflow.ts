import type {
  Assignment,
  CardId,
  CommandState,
  HumanActionId,
  ProjectId,
  RiskTag,
  WorkItemId,
} from "@cardigan/domain";
import {
  applyStandingMode,
  assign,
  autoMergeSchedule,
  completeHumanAction,
  createCard,
  createHostOpsAssignment,
  EXTERNAL_ASSIGNMENT_START_ERROR,
  hasVerifiedMergeNoop,
  isRoleActive,
  listNeedsYou,
  markNoticesRead,
  notices,
  parseCardPriority,
  parseId,
  projectPreferences,
  projectSnapshot,
  setCardSensitive,
  standingTools,
  supersedeCard,
  updateCard,
} from "@cardigan/domain";
import { loadMergeGateConfig } from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { secureDataDirectory } from "@cardigan/runtime-herdr";
import {
  backfillStandingModesInTransaction,
  openStore as openCardiganStore,
  type Store,
} from "@cardigan/store";
import { type StartById, startAssignmentById } from "./assignment.js";
import { runContentCommand } from "./content.js";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import {
  announceDataDir,
  hasToken,
  issueTokenForAssignment,
  printToken,
  resolveActor,
  resolveDataDir,
  resolveGlobalActor,
  resolveProject,
  roleInTransaction,
  runCommand,
  systemClock,
} from "./host.js";
import { rotateHostOps } from "./host-ops-rotate.js";
import type { CliIo } from "./io.js";
import { printRotation, rotateStandingPmInStore } from "./pm-rotate.js";
import { launchExecution } from "./runtime-check.js";

const USAGE = [
  "用法：",
  "  cardigan card create [--template <id>] --title <标题> --goal <目标> [--acceptance <标准1;标准2>] [--repo <仓库>] [--base-branch main] [--project <p>]",
  "  cardigan card update <C-n> [--title <标题>] [--goal <目标>] [--acceptance <标准1;标准2>] [--priority none|low|medium|high|urgent] [--status backlog|todo|cancelled] [--risk-tags security,permission,numeric_rule|none] [--superseded-by <C-m>] [--project <p>]",
  "    update 至少提供一个修改字段；含分号的验收标准请加引号。",
  "    --risk-tags 用逗号分隔 security、permission、numeric_rule；传 none 清空。",
  "    已完成卡片不能取消；请建新卡，再用 --superseded-by 标记已完成或已取消的旧卡。",
  "  cardigan card sensitive <C-n> on|off [--project <p>]   标记或取消敏感：被标记卡片的合并确认一律由你亲自处理",
  "  cardigan assign <W-n> --role <角色> [--employee <E-n 或名字>] [--machine local] [--start] [--project <p>]",
  "  cardigan token issue <A-n> [--project <p>]",
  "  cardigan pm create --office|--ops [--project <p>]",
  "  cardigan host-ops create [--employee <E-n>] [--project <p>]  创建常驻主机运维，启动时自动签发凭据",
  "  cardigan host-ops start [--project <p>]  启动常驻主机运维（已在运行就跳过）",
  "  cardigan host-ops rotate [--project <p>]  保留员工和待处理事项，切换到最新角色版本并启动",
  "  cardigan pm start [--office] [--ops] [--project <p>]  一键启动常驻 PM（已在运行就跳过）",
  "  cardigan pm rotate --office|--ops [--external] [--employee <E-n 或名字>] [--project <p>]     把常驻 PM 换到 pm 角色的最新版本",
  "  cardigan pm restart --office|--ops [--project <p>]     重开常驻 PM 会话（不暂停、不转交事项、不换版本）",
  "    新建固定最新版本的常驻 Assignment，待处理的 PM 事项转给它，旧的释放并作废 Token；",
  "    已是最新版本时不做改动。先用 cardigan role upgrade pm --from-default 追加新版本。",
  "  cardigan needs-you [--project <p>]                   看待你拍板、待你执行的事项和知会",
  "  cardigan needs-you read <知会编号...>|--all [--project <p>]  把知会标为已读",
  "  cardigan human-action done <H-n> --text <结果> [--project <p>]",
  "",
  "通用：--project 省略时取 CARDIGAN_PROJECT，再取数据库里唯一的项目；",
  "      --data-dir 省略时取 CARDIGAN_DATA_DIR，再取 ~/.local/share/cardigan。",
].join("\n");

interface Args {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

/** Minimal flag parser: `--flag value`, `--flag=value`, and boolean flags. */
function parseArgs(args: readonly string[], booleans: readonly string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    const name = token.slice(2, separator < 0 ? undefined : separator);
    const inline = separator < 0 ? undefined : token.slice(separator + 1);
    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }
    const next = args[index + 1];
    if (booleans.includes(name)) {
      flags[name] = true;
      continue;
    }
    if (next === undefined || next.startsWith("--")) {
      throw new CliError(`${token} 需要一个值`, EXIT.usage, [USAGE]);
    }
    flags[name] = next;
    index += 1;
  }
  return { positionals, flags };
}

function required(flags: Args["flags"], name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliError(`缺少 --${name}`, EXIT.usage, [USAGE]);
  }
  return value.trim();
}

function optional(flags: Args["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Split a `;`-separated list of acceptance criteria. */
function list(value: string): string[] {
  return value
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseWorkItem(raw: string | undefined): WorkItemId {
  const parsed = parseId("work_item", raw);
  if (!parsed.ok) {
    throw new CliError(`工作项编号不合法：${JSON.stringify(raw)}`, EXIT.usage, [
      USAGE,
    ]);
  }
  return parsed.value.id;
}

function parseAssignment(raw: string | undefined): Assignment["id"] {
  const parsed = parseId("assignment", raw);
  if (!parsed.ok) {
    throw new CliError(
      `Assignment 编号不合法：${JSON.stringify(raw)}`,
      EXIT.usage,
      [USAGE],
    );
  }
  return parsed.value.id;
}

function parseHumanAction(raw: string | undefined): HumanActionId {
  const parsed = parseId("human_action", raw);
  if (!parsed.ok) {
    throw new CliError(
      `HumanAction 编号不合法：${JSON.stringify(raw)}（形如 H-3）`,
      EXIT.usage,
      [USAGE],
    );
  }
  return parsed.value.id;
}

/** Entry point for `card`, `assign`, `token`, `pm` and `human-action`. */
/** Injected by tests; production uses `startAssignmentById`. */
export interface CliHooks {
  readonly start?: StartById;
}

export async function runWorkflowCommand(
  args: readonly string[],
  io: CliIo,
  hooks: CliHooks = {},
): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "card":
      return cardCommand(rest, io);
    case "assign":
      return await assignWorkItem(rest, io, hooks);
    case "token":
      return tokenIssue(rest, io);
    case "pm":
      return await pmCommand(rest, io, hooks);
    case "host-ops":
      return await hostOpsCommand(rest, io, hooks);
    case "needs-you":
      return needsYou(rest, io);
    case "human-action":
      return humanActionDone(rest, io);
    default:
      throw new CliError(`不认识的命令：${args.join(" ")}`, EXIT.usage, [
        USAGE,
      ]);
  }
}

function cardCommand(
  args: readonly string[],
  io: CliIo,
): number | Promise<number> {
  const [sub, ...rest] = args;
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (sub === "done") return runContentCommand("card_done", args, io);
  if (sub === "create") return cardCreate(rest, io);
  if (sub === "update") return cardUpdate(rest, io);
  if (sub === "sensitive") return cardSensitive(rest, io);
  throw new CliError(
    "用法：cardigan card create|update|sensitive ...",
    EXIT.usage,
    [USAGE],
  );
}

/** C-69: matches the Workbench wording. */
export function unmarkAutoMergeNote(minutes: number) {
  return `如有等你处理的合并确认，从现在起重新计时，${minutes} 分钟内无人处理将按项目设置自动合并。`;
}

/** C-72: an unmark that changed nothing must not promise a restarted timeout. */
export function alreadyUnmarkedNote(due_at: string | null) {
  return `本来就没有敏感标记，这次没有改动，合并确认的超时计时也没有重新开始。${due_at === null ? "" : `当前合并确认将于 ${due_at} 按项目设置自动合并。`}`;
}

/** Earliest auto-merge time among the card's merge confirmations, if any. */
function earliestAutoMergeDue(state: CommandState, card_id: CardId) {
  let due: string | null = null;
  for (const q of state.decisions) {
    if (q.trigger !== "merge_confirmation" || q.card_id !== card_id) continue;
    const schedule = autoMergeSchedule(state, q.id);
    if (
      schedule.ok &&
      (due === null || Date.parse(schedule.value.due_at) < Date.parse(due))
    )
      due = schedule.value.due_at;
  }
  return due;
}

/** C-65: human-only sensitive flag; the local CLI acts as the human. */
function cardSensitive(args: readonly string[], io: CliIo): number {
  const { flags, positionals } = parseArgs(args, []);
  const parsedId = parseId("card", positionals[0]);
  const value = positionals[1];
  if (
    positionals.length !== 2 ||
    !parsedId.ok ||
    (value !== "on" && value !== "off")
  )
    throw new CliError(
      "用法：cardigan card sensitive <C-n> on|off",
      EXIT.usage,
      [USAGE],
    );
  for (const name of Object.keys(flags))
    if (!["project", "data-dir"].includes(name))
      throw new CliError(`不认识的选项：--${name}`, EXIT.usage, [USAGE]);
  const card_id = parsedId.value.id;
  const store = openStoreFrom(io, flags);
  try {
    const project_id = resolveProject(store, io, optional(flags, "project"));
    let changed = false;
    let due_at: string | null = null;
    runCommand(store, {
      operation: "修改敏感标记",
      target: card_id,
      project_id,
      actor: resolveActor(io, project_id, store),
      clock: systemClock,
      reduce: (state, actor, ports) => {
        const result = setCardSensitive(
          state,
          actor,
          { card_id, sensitive: value === "on" },
          ports,
        );
        // C-72: only an emitted change restarts the timeout; a no-op leaves
        // the state as read, so its schedule is the one that still applies.
        if (result.ok) {
          changed = result.value.events.some(
            (e) => e.type === "card_sensitivity_changed",
          );
          if (!changed && value === "off")
            due_at = earliestAutoMergeDue(state, card_id);
        }
        return result;
      },
    });
    // C-69: the timeout restarts at the unmark; say so only when it is on.
    const minutes =
      value === "off" && changed
        ? store.uow.read(
            (tx) =>
              projectPreferences(loadCommandState(tx, project_id))
                .auto_merge_after_minutes,
          )
        : null;
    io.stdout(
      value === "on"
        ? `已将 ${card_id} 标为敏感：合并确认将由你亲自处理，PM 不能代确认，也不会超时自动合并。`
        : changed
          ? `已取消 ${card_id} 的敏感标记。${minutes === null ? "" : unmarkAutoMergeNote(minutes)}`
          : `${card_id} ${alreadyUnmarkedNote(due_at)}`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

const RISK_TAGS: readonly RiskTag[] = [
  "security",
  "permission",
  "numeric_rule",
];

/** `none` clears; otherwise a comma-separated list of the three risk tags. */
function parseRiskTags(raw: string): RiskTag[] {
  if (raw === "none") return [];
  const tags = raw.split(",").map((tag) => tag.trim());
  if (!tags.every((tag): tag is RiskTag => RISK_TAGS.includes(tag as RiskTag)))
    throw new CliError(
      "--risk-tags 只接受 security、permission、numeric_rule（逗号分隔），清空请传 none",
      EXIT.usage,
      [USAGE],
    );
  return [...new Set(tags)];
}

function cardUpdate(args: readonly string[], io: CliIo): number {
  const { flags, positionals } = parseArgs(args, []);
  const parsedId = parseId("card", positionals[0]);
  if (positionals.length !== 1 || !parsedId.ok) {
    throw new CliError("请提供一个合法的卡片编号（形如 C-3）", EXIT.usage, [
      USAGE,
    ]);
  }
  const fields = [
    "title",
    "goal",
    "acceptance",
    "priority",
    "status",
    "risk-tags",
    "superseded-by",
  ];
  for (const name of Object.keys(flags)) {
    if (![...fields, "project", "data-dir"].includes(name)) {
      throw new CliError(`不认识的选项：--${name}`, EXIT.usage, [USAGE]);
    }
    required(flags, name);
  }
  const changed = fields.filter((name) => flags[name] !== undefined);
  if (changed.length === 0) {
    throw new CliError("至少提供一个要修改的字段", EXIT.usage, [USAGE]);
  }
  const status = optional(flags, "status");
  const supersededBy = optional(flags, "superseded-by");
  const replacement =
    supersededBy === undefined ? undefined : parseId("card", supersededBy);
  if (replacement && !replacement.ok) {
    throw new CliError(
      "--superseded-by 需要合法的卡片编号（形如 C-3）",
      EXIT.usage,
      [USAGE],
    );
  }
  if (
    status !== undefined &&
    status !== "backlog" &&
    status !== "todo" &&
    status !== "cancelled"
  ) {
    throw new CliError("--status 只接受 backlog、todo、cancelled", EXIT.usage, [
      USAGE,
    ]);
  }
  const priority =
    flags.priority === undefined
      ? undefined
      : parseCardPriority(required(flags, "priority"));
  if (flags.priority !== undefined && priority === undefined) {
    throw new CliError(
      "--priority 必须是 none/low/medium/high/urgent 或 无/低/中/高/紧急",
      EXIT.usage,
      [USAGE],
    );
  }
  const acceptance =
    flags.acceptance === undefined
      ? undefined
      : list(required(flags, "acceptance"));
  if (acceptance?.length === 0) {
    throw new CliError("--acceptance 至少写一条标准", EXIT.usage, [USAGE]);
  }
  const riskTags =
    flags["risk-tags"] === undefined
      ? undefined
      : parseRiskTags(required(flags, "risk-tags"));
  const patch: Omit<Parameters<typeof updateCard>[2], "card_id"> = {
    ...(flags.title === undefined ? {} : { title: required(flags, "title") }),
    ...(flags.goal === undefined ? {} : { goal: required(flags, "goal") }),
    ...(acceptance === undefined ? {} : { acceptance_criteria: acceptance }),
    ...(priority === undefined ? {} : { priority }),
    ...(status === undefined ? {} : { status }),
    ...(riskTags === undefined ? {} : { risk_tags: riskTags }),
  };
  const cardId = parsedId.value.id;
  const store = openStoreFrom(io, flags);
  try {
    const project_id = resolveProject(store, io, optional(flags, "project"));
    const actor = resolveActor(io, project_id, store);
    store.uow.run((tx) => {
      const ports = { clock: systemClock, ids: tx.ids };
      let state = loadCommandState(tx, project_id);
      if (changed.some((name) => name !== "superseded-by")) {
        const result = updateCard(
          state,
          actor,
          { card_id: cardId, ...patch },
          ports,
        );
        if (!result.ok) {
          throw new CliError(
            formatCommandError("更新卡片", cardId, result.error),
            EXIT.usage,
          );
        }
        persistEffect(tx, project_id, result.value);
        if (replacement?.ok) state = loadCommandState(tx, project_id);
      }
      if (replacement?.ok) {
        const result = supersedeCard(
          state,
          actor,
          { card_id: cardId, superseded_by: replacement.value.id },
          ports,
        );
        if (!result.ok) {
          throw new CliError(
            formatCommandError("更新卡片", cardId, result.error),
            EXIT.usage,
          );
        }
        persistEffect(tx, project_id, result.value);
      }
    });
    io.stdout(`已更新卡片 ${cardId}：${changed.join("、")}`);
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function cardCreate(args: readonly string[], io: CliIo): number {
  const parsed = parseArgs(args, []);
  const template = optional(parsed.flags, "template") ?? "dev";
  const acceptance = list(optional(parsed.flags, "acceptance") ?? "");
  const repo = optional(parsed.flags, "repo");
  const base =
    optional(parsed.flags, "base-branch") ?? (repo ? "main" : undefined);

  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const card = runCommand(store, {
      operation: "创建卡片",
      target: required(parsed.flags, "title"),
      project_id,
      actor: resolveActor(io, project_id, store),
      reduce: (state, actor, ports) =>
        createCard(
          state,
          actor,
          {
            title: required(parsed.flags, "title"),
            goal: required(parsed.flags, "goal"),
            acceptance_criteria: acceptance,
            source: { kind: "quote", text: required(parsed.flags, "goal") },
            ...(repo === undefined ? {} : { repo }),
            ...(base === undefined ? {} : { base_branch: base }),
            template_id: template,
          },
          ports,
        ),
    });
    const items = store.uow.read((tx) =>
      tx.work_items.list(project_id).filter((item) => item.card_id === card.id),
    );
    io.stdout(
      [
        `已创建卡片 ${card.id}（${card.title}）`,
        ...items.map(
          (item) =>
            `  ${item.id}  ${item.kind}  ${item.role_id}  ${item.title}`,
        ),
      ].join("\n"),
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

async function assignWorkItem(
  args: readonly string[],
  io: CliIo,
  hooks: CliHooks,
): Promise<number> {
  // `--start` takes no value: assign and start the Assignment in one step.
  const start = args.includes("--start");
  if (start && hasToken(io))
    throw new CliError("Token 模式不能使用 assign --start。", EXIT.usage);
  const parsed = parseArgs(
    args.filter((argument) => argument !== "--start"),
    [],
  );
  const workItemId = parseWorkItem(parsed.positionals[0]);
  const roleId = required(parsed.flags, "role");
  const machine = optional(parsed.flags, "machine");
  const employee = optional(parsed.flags, "employee");

  if (start)
    await secureDataDirectory(
      await launchExecution(
        io,
        resolveDataDir(io, optional(parsed.flags, "data-dir")),
      ),
    );

  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const caller = resolveActor(io, project_id, store);
    let issued: ReturnType<typeof issueTokenForAssignment> | undefined;
    let tokenStatus = "host_managed";
    const assignment = runCommand(store, {
      operation: "指派工作项",
      target: workItemId,
      project_id,
      actor: caller,
      reduce: (state, actor, ports) => {
        const result = assign(
          state,
          actor,
          {
            work_item_id: workItemId,
            role_id: roleId,
            ...(employee === undefined ? {} : { employee_id: employee }),
            ...(machine === undefined ? {} : { machine_id: machine }),
          },
          ports,
        );
        if (result.ok && result.value.token_requests.length > 0)
          tokenStatus = "pending_host_issuance";
        return result;
      },
      // `--start` issues the only token inside `startAssignment`, into the run
      // directory; issuing one here would print a token that is revoked at once.
      after: (tx, created) => {
        if (start || caller.kind !== "human") return;
        issued = issueTokenForAssignment(
          tx,
          project_id,
          created.id,
          roleInTransaction(
            tx,
            project_id,
            created.role_id,
            created.role_version,
          ),
        );
      },
    });

    io.stdout(
      [
        `已指派 ${workItemId} → ${assignment.id}（${assignment.role_id} v${assignment.role_version}${assignment.employee_id ? `，员工 ${assignment.employee_id}` : ""}）`,
      ].join("\n"),
    );
    if (start) {
      // One command from card to a running Agent (M2.6). No token is printed:
      // it lives in the run directory and is deleted by launch.sh.
      return await (hooks.start ?? startAssignmentById)({
        store,
        io,
        project_id,
        assignment_id: assignment.id,
        ...(optional(parsed.flags, "data-dir") === undefined
          ? {}
          : { dataDir: optional(parsed.flags, "data-dir") as string }),
        ...(optional(parsed.flags, "mcp-url") === undefined
          ? {}
          : { mcpUrl: optional(parsed.flags, "mcp-url") as string }),
        ...(optional(parsed.flags, "hc-session") === undefined
          ? {}
          : { session: optional(parsed.flags, "hc-session") as string }),
      });
    }
    if (caller.kind === "assignment") {
      io.stdout(`token_status=${tokenStatus}`);
      return EXIT.ok;
    }
    if (issued === undefined) {
      throw new CliError("签发 Token 失败", EXIT.failure);
    }
    printToken(io, issued);
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function tokenIssue(args: readonly string[], io: CliIo): number {
  const [sub, ...rest] = args;
  if (sub !== "issue") {
    throw new CliError("用法：cardigan token issue <A-n>", EXIT.usage, [USAGE]);
  }
  const parsed = parseArgs(rest, []);
  const assignmentId = parseAssignment(parsed.positionals[0]);

  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const issued = store.uow.run((tx) => {
      const assignment = tx.assignments.get(project_id, assignmentId);
      if (assignment === undefined) {
        throw new CliError(
          formatCommandError("签发 Token", assignmentId, {
            code: "not_found",
            message: `Assignment ${assignmentId} 不存在`,
          }),
          EXIT.usage,
        );
      }
      if (assignment.status !== "active") {
        throw new CliError(
          formatCommandError("签发 Token", assignmentId, {
            code: "illegal_transition",
            message: `Assignment ${assignmentId} 状态是 ${assignment.status}，只有 active 才能签发 Token`,
          }),
          EXIT.usage,
        );
      }
      const role = roleInTransaction(
        tx,
        project_id,
        assignment.role_id,
        assignment.role_version,
      );
      // M4.5: a standing PM's scope comes from its mode; a work-item
      // Assignment keeps the scope it already had (never wider).
      backfillStandingModesInTransaction(tx, project_id);
      const current =
        tx.assignments.get(project_id, assignment.id) ?? assignment;
      const previous = tx.tokensForAssignment(project_id, assignment.id).at(-1);
      const allowed_tools =
        current.scope === "standing" &&
        current.role_id === "pm" &&
        current.standing_mode !== undefined
          ? standingTools(role.allowed_tools, current.standing_mode)
          : (previous?.allowed_tools ?? role.allowed_tools);
      return issueTokenForAssignment(tx, project_id, assignment.id, {
        role_version: role.role_version,
        allowed_tools,
      });
    });

    io.stdout(
      `已为 ${assignmentId} 签发新 Token（该 Assignment 之前的有效 Token 已作废）`,
    );
    printToken(io, issued);
    return EXIT.ok;
  } finally {
    store.close();
  }
}

/** Human-only bootstrap and launch for the project's standing operations identity. */
async function hostOpsCommand(
  args: readonly string[],
  io: CliIo,
  hooks: CliHooks,
): Promise<number> {
  // Also protect direct workflow callers before opening the store or issuing credentials.
  resolveGlobalActor(io);
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const [sub, ...rest] = args;
  const parsed = parseArgs(rest, []);
  const allowed =
    sub === "create"
      ? ["project", "data-dir", "employee"]
      : ["project", "data-dir", "mcp-url", "hc-session"];
  if (
    !["create", "start", "rotate"].includes(sub ?? "") ||
    parsed.positionals.length ||
    Object.keys(parsed.flags).some((key) => !allowed.includes(key))
  )
    throw new CliError(
      "请使用 host-ops create、start 或 rotate 及其支持的选项",
      EXIT.usage,
      [USAGE],
    );
  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    if (sub === "create") {
      const created = store.uow.run((tx) => {
        const employee_id = optional(parsed.flags, "employee");
        const result = createHostOpsAssignment(
          loadCommandState(tx, project_id),
          resolveActor(io, project_id, store),
          employee_id === undefined ? {} : { employee_id },
          { clock: systemClock, ids: tx.ids },
        );
        if (!result.ok)
          throw new CliError(
            formatCommandError("创建主机运维", project_id, result.error),
            EXIT.usage,
          );
        const effect = result.value;
        persistEffect(tx, project_id, effect);
        return effect.data;
      });
      io.stdout(
        `${created.reused ? "复用" : "已创建"}常驻主机运维：${created.assignment.id}（host_ops v${created.assignment.role_version}）`,
      );
      io.stdout(
        "运行 cardigan host-ops start 启动；凭据由启动流程自动签发，不在终端显示。",
      );
      return EXIT.ok;
    }
    if (sub === "rotate")
      await rotateHostOps({
        store,
        io,
        project_id,
        dataDir: resolveDataDir(io, optional(parsed.flags, "data-dir")),
        ...(optional(parsed.flags, "hc-session")
          ? { session: optional(parsed.flags, "hc-session") as string }
          : {}),
      });
    const candidates = store.uow.read((tx) =>
      tx.assignments
        .list(project_id)
        .filter(
          (a) =>
            a.scope === "standing" &&
            a.role_id === "host_ops" &&
            a.status === "active",
        ),
    );
    const assignment = candidates[0];
    if (candidates.length !== 1 || !assignment)
      throw new CliError(
        candidates.length
          ? "有多个常驻主机运维 Assignment，无法确定启动对象"
          : "还没有常驻主机运维，先运行 cardigan host-ops create",
        EXIT.usage,
      );
    if (hasUnfinishedRun(store, project_id, assignment.id)) {
      io.stdout(`主机运维（${assignment.id}）已在运行，跳过`);
      return EXIT.ok;
    }
    try {
      const result = await (hooks.start ?? startAssignmentById)({
        store,
        io,
        project_id,
        assignment_id: assignment.id,
        ...(optional(parsed.flags, "data-dir")
          ? { dataDir: optional(parsed.flags, "data-dir") as string }
          : {}),
        ...(optional(parsed.flags, "mcp-url")
          ? { mcpUrl: optional(parsed.flags, "mcp-url") as string }
          : {}),
        ...(optional(parsed.flags, "hc-session")
          ? { session: optional(parsed.flags, "hc-session") as string }
          : {}),
      });
      if (sub === "rotate" && result !== EXIT.ok)
        io.stderr(
          `新主机运维 ${assignment.id} 已保留；请运行 cardigan host-ops start --project ${project_id} 重试启动。`,
        );
      return result;
    } catch (error) {
      if (sub === "rotate")
        throw new CliError(
          `新主机运维 ${assignment.id} 已保留；请运行 cardigan host-ops start --project ${project_id} 重试启动。`,
          EXIT.failure,
        );
      throw error;
    }
  } finally {
    store.close();
  }
}

/** `cardigan pm create|start|rotate`: the two standing PM assignments (§7.1). */
async function pmCommand(
  args: readonly string[],
  io: CliIo,
  hooks: CliHooks,
): Promise<number> {
  const [sub] = args;
  if (sub === "start") return await pmStart(args.slice(1), io, hooks);
  if (sub === "rotate") return await pmRotate(args.slice(1), io);
  if (sub === "restart") return await pmRestart(args.slice(1), io, hooks);
  return pmCreate(args, io);
}

/**
 * C-154 `cardigan pm restart --office|--ops`: a fresh session for the same
 * standing PM. Nothing is paused or handed to the human, and it works without
 * a role version change (unlike `pm rotate`).
 */
async function pmRestart(
  args: readonly string[],
  io: CliIo,
  hooks: CliHooks,
): Promise<number> {
  const parsed = parseArgs(args, ["office", "ops"]);
  const office = parsed.flags.office === true;
  if (office === (parsed.flags.ops === true) || parsed.positionals.length > 0)
    throw new CliError("必须二选一：--office 或 --ops", EXIT.usage, [USAGE]);
  const label = office ? "PM Office" : "PM Ops";
  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const entries = standingPmAssignments(store, project_id).filter(
      (entry) => entry.office === office,
    );
    const active = entries.filter((e) => e.assignment.status === "active");
    if (active.length === 0)
      throw new CliError(
        entries.length > 0
          ? `${label} 已暂停，用 cardigan pm start --${office ? "office" : "ops"} 恢复`
          : `没有在岗的 ${label}，先运行 cardigan pm create`,
        EXIT.usage,
      );
    if (active.length > 1)
      throw new CliError(
        `有多个在岗的 ${label}，无法确定要重开哪一个`,
        EXIT.failure,
      );
    const { assignment } = active[0] as StandingPm;
    if (assignment.external)
      throw new CliError(
        `${label}（${assignment.id}）是外接身份，没有主机终端可重开；在外接客户端里新开会话即可。`,
        EXIT.usage,
      );
    const result = await (hooks.start ?? startAssignmentById)({
      store,
      io,
      project_id,
      assignment_id: assignment.id,
      restart_session: true,
      ...(optional(parsed.flags, "data-dir") === undefined
        ? {}
        : { dataDir: optional(parsed.flags, "data-dir") as string }),
      ...(optional(parsed.flags, "mcp-url") === undefined
        ? {}
        : { mcpUrl: optional(parsed.flags, "mcp-url") as string }),
      ...(optional(parsed.flags, "hc-session") === undefined
        ? {}
        : { session: optional(parsed.flags, "hc-session") as string }),
    });
    if (result === EXIT.ok)
      io.stdout(
        `已重开 ${label}（${assignment.id}）的会话：Assignment 不变，待处理事项没有转交。`,
      );
    return result;
  } finally {
    store.close();
  }
}

/** `cardigan pm rotate --office|--ops`: human-only, one write transaction. */
async function pmRotate(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(args, ["office", "ops", "external"]);
  const office = parsed.flags.office === true;
  if (office === (parsed.flags.ops === true) || parsed.positionals.length > 0)
    throw new CliError("必须二选一：--office 或 --ops", EXIT.usage, [USAGE]);
  // The replacement is started from this shell next; refuse before rotating
  // when it does not match the server's runtime (C-152).
  if (parsed.flags.external !== true)
    await launchExecution(
      io,
      resolveDataDir(io, optional(parsed.flags, "data-dir")),
    );
  const mode = office ? ("office" as const) : ("ops" as const);
  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    printRotation(
      io,
      mode,
      rotateStandingPmInStore(store, project_id, mode, {
        actor: resolveActor(io, project_id, store),
        ...(parsed.flags.external === true ? { external: true } : {}),
        ...(optional(parsed.flags, "employee") === undefined
          ? {}
          : { employee_id: optional(parsed.flags, "employee") as string }),
      }),
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

interface StandingPm {
  readonly assignment: Assignment;
  readonly office: boolean;
}

/**
 * Standing pm Assignments, told apart by `standing_mode` (§7.1 / M4.5). Rows
 * written before the field existed are inferred and stamped here, once.
 */
function standingPmAssignments(
  store: Store,
  project_id: ProjectId,
): readonly StandingPm[] {
  return store.uow.run((tx) => {
    backfillStandingModesInTransaction(tx, project_id);
    return tx.assignments
      .list(project_id)
      .filter(
        (candidate) =>
          candidate.scope === "standing" &&
          candidate.role_id === "pm" &&
          ["active", "suspended"].includes(candidate.status),
      )
      .flatMap((assignment) =>
        assignment.standing_mode === undefined
          ? []
          : [
              {
                assignment,
                office: assignment.standing_mode === "office",
              },
            ],
      );
  });
}

/** An Assignment with an unfinished Run is already being served. */
function hasUnfinishedRun(
  store: Store,
  project_id: ProjectId,
  id: Assignment["id"],
): boolean {
  return store.uow.read((tx) =>
    tx.runs
      .list(project_id)
      .some(
        (run) =>
          run.assignment_id === id &&
          !["completed", "failed", "cancelled"].includes(run.status),
      ),
  );
}

/**
 * `cardigan pm start` — M3.5: bring both standing PM assignments up through the
 * M2.6 one-command start, skipping any that is already serving a Run.
 */
async function pmStart(
  args: readonly string[],
  io: CliIo,
  hooks: CliHooks,
): Promise<number> {
  const parsed = parseArgs(args, ["office", "ops"]);
  const onlyOffice = parsed.flags.office === true;
  const onlyOps = parsed.flags.ops === true;

  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const standing = standingPmAssignments(store, project_id);
    const wanted = standing.filter(
      (entry) =>
        (onlyOffice && entry.office) ||
        (onlyOps && !entry.office) ||
        (!onlyOffice && !onlyOps),
    );
    if (wanted.length === 0) {
      throw new CliError(
        "还没有常驻 PM Assignment，先运行 cardigan pm create --office 与 --ops",
        EXIT.usage,
        [USAGE],
      );
    }

    let started = 0;
    for (const entry of wanted) {
      const label = entry.office ? "PM Office" : "PM Ops";
      if (entry.assignment.external) {
        if (onlyOffice && !onlyOps)
          throw new CliError(EXTERNAL_ASSIGNMENT_START_ERROR, EXIT.usage);
        io.stdout(
          `${label}（${entry.assignment.id}）是外接身份，跳过终端启动；用 cardigan inbox 查看待处理通知。`,
        );
        continue;
      }
      if (hasUnfinishedRun(store, project_id, entry.assignment.id)) {
        io.stdout(`${label}（${entry.assignment.id}）已在运行，跳过`);
        continue;
      }
      const result = await (hooks.start ?? startAssignmentById)({
        store,
        io,
        project_id,
        assignment_id: entry.assignment.id,
        ...(optional(parsed.flags, "data-dir") === undefined
          ? {}
          : { dataDir: optional(parsed.flags, "data-dir") as string }),
        ...(optional(parsed.flags, "mcp-url") === undefined
          ? {}
          : { mcpUrl: optional(parsed.flags, "mcp-url") as string }),
        ...(optional(parsed.flags, "hc-session") === undefined
          ? {}
          : { session: optional(parsed.flags, "hc-session") as string }),
      });
      if (result !== 0) return result;
      started += 1;
    }
    io.stdout(
      started === 0 ? "没有需要启动的 PM" : `已启动 ${started} 个常驻 PM`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

/**
 * `cardigan needs-you` — M3.5 read-only view until M5 builds the page
 * (development plan §7.3): open human decisions, pending human actions and
 * the §7.4 知会 list; `needs-you read` marks notices read.
 */
async function needsYou(args: readonly string[], io: CliIo): Promise<number> {
  if (args[0] === "read") return needsYouRead(args.slice(1), io);
  const parsed = parseArgs(args, []);
  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const actor = resolveActor(io, project_id, store);
    const gate = (
      await loadMergeGateConfig({
        projectIds: store.listProjects().map((project) => project.id),
        env: io.env,
      })
    ).forProject(project_id);
    if (actor.kind === "assignment") {
      // Token callers get exactly the domain view behind MCP list_needs_you,
      // without the host-only diagnostics and notices appended below.
      const view = store.uow.read((tx) => {
        const result = listNeedsYou(
          loadCommandState(tx, project_id, {
            merge_gate_enabled: gate.status !== "disabled",
          }),
          actor,
          systemClock,
        );
        if (!result.ok)
          throw new CliError(
            formatCommandError("读取待办", project_id, result.error),
            EXIT.usage,
          );
        return result.value.data;
      });
      io.stdout(JSON.stringify(view, null, 2));
      return EXIT.ok;
    }
    const checks = store.uow.read((tx) => {
      const view = projectSnapshot(loadCommandState(tx, project_id), actor);
      return new Map(
        view.ok && gate.status === "enabled"
          ? view.value.data.cards.map((card) => [card.id, card.merge_check])
          : [],
      );
    });
    const checkLabels = {
      queued: "排队",
      running: "运行中",
      passed: "通过",
      failed: "失败",
      timed_out: "超时",
      interrupted: "中断",
      executor_unreachable: "远程检查机不可达",
    };
    const { decisions, actions, incidents, noticeList, held, waiting } =
      store.uow.read((tx) => {
        const state = loadCommandState(tx, project_id, {
          merge_gate_enabled: gate.status !== "disabled",
        });
        const needs = unwrap(listNeedsYou(state, actor)).data;
        return {
          held: needs.pm_held_merges,
          waiting: needs.waiting_merge_check_items,
          decisions: needs.decisions.map((q) => ({
            ...q,
            merge_noop:
              !!q.card_id &&
              q.kind === "approve" &&
              "delivery_id" in q.target &&
              hasVerifiedMergeNoop(
                state.events,
                q.card_id,
                q.target.delivery_id,
              ),
          })),
          actions: needs.human_actions,
          // Same source as the Workbench 知会 section (§7.4): newest first.
          noticeList: notices(state),
          incidents: tx.assignments
            .list(project_id)
            .filter(
              (a) =>
                a.status === "active" &&
                ["lost", "unknown"].includes(a.runtime_state),
            ),
        };
      });

    const gateWarnings =
      gate.status === "invalid"
        ? ["合并闸门配置无效，请查看 server 启动日志"]
        : [];
    // C-171: name what the summary counts so the human can find it.
    const waitingLines = waiting.length
      ? [
          `还有 ${waiting.length} 条合并确认的检查在排队或运行中，检查结束后会出现在这里：${waiting
            .map(
              (w) =>
                `${w.card_id ? `${w.card_id} ` : ""}${w.decision_id}${w.check_status ? `（${checkLabels[w.check_status]}）` : ""}`,
            )
            .join("、")}`,
        ]
      : [];
    const snoozeLines = (q: {
      status: string;
      snooze?: { reason: string; until: string };
    }) =>
      q.status === "snoozed" && q.snooze
        ? [
            `    已暂缓：${q.snooze.reason}（到 ${new Date(q.snooze.until).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}）`,
          ]
        : [];
    // §7.4 (C-65): not waiting on the human, but answerable directly.
    const heldLines = held.length
      ? [
          `PM 代确认中的合并（${held.length}，不需要你处理；也可以直接处理）`,
          ...held.map((q) =>
            [
              `  ${q.id}  ${q.card_id ?? "项目"}`,
              `    ${q.question}`,
              ...snoozeLines(q),
              ...(q.card_id
                ? [
                    `    直接处理：cardigan merge confirm|hold ${q.card_id}（hold 须加 --reason <原因>），或 cardigan merge request-changes ${q.card_id} --reason <原因>`,
                  ]
                : []),
            ].join("\n"),
          ),
        ]
      : [];
    if (
      decisions.length === 0 &&
      actions.length === 0 &&
      incidents.length === 0 &&
      noticeList.length === 0
    ) {
      io.stdout(
        [
          "Needs You 是空的：没有待你拍板的事项，也没有待你执行的操作。",
          ...gateWarnings,
          ...waitingLines,
          ...heldLines,
        ].join("\n"),
      );
      return EXIT.ok;
    }
    const lines: string[] = [...gateWarnings, ...waitingLines];
    const pending = decisions.filter((q) => !q.followup_notice);
    const followups = decisions.filter((q) => q.followup_notice);
    if (followups.length) {
      lines.push(`拍板落实（${followups.length}）`);
      for (const q of followups)
        lines.push(
          `  ${q.id}  ${q.card_id ?? "项目"}\n    ${q.followup_notice}\n    已选方案：${q.resolution?.option}\n    请安排落实，并在时间线引用 ${q.id} 记录结果。`,
        );
    }
    if (pending.length > 0) {
      lines.push(`待你拍板（${pending.length}）`);
      for (const decision of pending) {
        const check = decision.card_id
          ? checks.get(decision.card_id)
          : undefined;
        lines.push(
          [
            `  ${decision.id}${decision.card_id === undefined ? "" : `  ${decision.card_id}`}`,
            `    ${decision.question}`,
            ...snoozeLines(decision),
            ...(decision.trigger === "merge_confirmation" &&
            gate.status === "enabled"
              ? [
                  decision.merge_noop
                    ? "    交付已在基线中，无需合并检查"
                    : `    合并检查：${check ? checkLabels[check.status] : "排队"}`,
                  ...(!decision.merge_noop &&
                  decision.card_id &&
                  check &&
                  ["failed", "timed_out"].includes(check.status)
                    ? [
                        `    检查未通过，不会自己变成通过：cardigan merge request-changes ${decision.card_id} --reason <原因>，偶发失败可 cardigan merge recheck ${decision.card_id}`,
                      ]
                    : []),
                ]
              : []),
            ...(decision.trigger === "merge_confirmation" &&
            gate.status === "invalid"
              ? ["    合并闸门配置无效，请查看 server 启动日志"]
              : []),
            ...(decision.status === "provisional"
              ? ["    状态：等待确认（条件性拍板）"]
              : []),
          ].join("\n"),
        );
      }
    }
    if (incidents.length > 0) {
      lines.push(`运行环境失联（${incidents.length}，需要你决定是否接管）`);
      for (const assignment of incidents)
        lines.push(
          `  ${assignment.id}  ${assignment.role_id} v${assignment.role_version}  runtime=${assignment.runtime_state}${assignment.worktree_path === undefined ? "" : `  worktree=${assignment.worktree_path}`}`,
        );
    }
    if (actions.length > 0) {
      lines.push(`待你执行（${actions.length}）`);
      for (const action of actions) {
        if (action.completion_notice !== undefined) {
          lines.push(
            `  ${action.id}  ${action.card_id ?? "项目"}\n    ${action.why}\n    执行结果：${action.completion_notice}\n    请恢复发起方或启动项目的 PM Ops。`,
          );
          continue;
        }
        lines.push(
          [
            `  ${action.id}${action.card_id === undefined ? "" : `  ${action.card_id}`}`,
            ...(action.handoff
              ? [
                  `    ${action.handoff.title}（项目经理已改写）`,
                  `    这是什么：${action.handoff.summary}`,
                  `    做完会怎样：${action.handoff.expected_outcome}`,
                ]
              : []),
            `    ${action.handoff?.instructions ?? action.instructions}`,
            `    为什么需要你：${action.handoff?.why_human ?? action.why_human}`,
            `    期望返回：${action.handoff?.expected_return ?? action.expected_return}`,
            ...(action.due === undefined ? [] : [`    截止：${action.due}`]),
          ].join("\n"),
        );
      }
    }
    lines.push(...heldLines);
    if (noticeList.length > 0) lines.push(...noticeLines(noticeList));
    io.stdout(lines.join("\n"));
    return EXIT.ok;
  } finally {
    store.close();
  }
}

type NoticeList = ReturnType<typeof notices>;

/** The Workbench shows the newest 50 notices; the CLI shows the same slice. */
const NOTICE_LIMIT = 50;

/** §7.4 知会 section: delegated merges and decisions, informational only. */
function noticeLines(all: NoticeList): string[] {
  const unread = all.filter((n) => !n.read).length;
  const shown = all.slice(0, NOTICE_LIMIT);
  const lines = [
    `知会（未读 ${unread}，共 ${all.length}${all.length > shown.length ? `，显示最新 ${shown.length} 条` : ""}）`,
    "  PM 处理的合并、代拍的决定、超时自动合并和 PM 合并确认停留提醒，不需要你处理；有疑问可在卡片里追问。",
  ];
  for (const n of shown) {
    // C-177: a stall alert is a system notice on a still-open confirmation.
    const label =
      n.option === "stalled"
        ? "PM 合并确认停留"
        : n.kind === "merge"
          ? n.resolved_by === "system"
            ? "超时自动合并"
            : n.option === "request_changes"
              ? "PM 退回修改"
              : n.option === "recheck"
                ? "PM 重新检查"
                : "PM 代确认合并"
          : "PM 代拍";
    lines.push(
      [
        `  ${n.read ? "[已读]" : "[未读]"} ${n.id}  ${label}  ${n.decision_id}${n.card_id ? `  ${n.card_id}` : ""}  ${n.at}`,
        ...(n.question ? [`    ${n.question}`] : []),
        `    ${n.body}`,
      ].join("\n"),
    );
  }
  if (unread > 0)
    lines.push(
      "  标为已读：cardigan needs-you read <知会编号...>，或 cardigan needs-you read --all",
    );
  return lines;
}

/** `cardigan needs-you read <notice id...>|--all` — same command as the Workbench. */
function needsYouRead(args: readonly string[], io: CliIo): number {
  const parsed = parseArgs(args, ["all"]);
  const all = parsed.flags.all === true;
  if (all === parsed.positionals.length > 0)
    throw new CliError("请给出知会编号，或使用 --all（二选一）", EXIT.usage, [
      USAGE,
    ]);
  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const ids = all
      ? store.uow.read((tx) =>
          notices(loadCommandState(tx, project_id))
            .filter((n) => !n.read)
            .map((n) => n.id),
        )
      : parsed.positionals;
    if (ids.length === 0) {
      io.stdout("没有未读的知会");
      return EXIT.ok;
    }
    const result = runCommand(store, {
      operation: "标记知会已读",
      target: all ? "全部未读知会" : ids.join(", "),
      project_id,
      actor: resolveActor(io, project_id, store),
      reduce: (state, actor, ports) =>
        markNoticesRead(state, actor, { notice_ids: ids }, ports),
    });
    io.stdout(
      result.notice_ids.length === 0
        ? "这些知会已经是已读"
        : `已标为已读 ${result.notice_ids.length} 条知会`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function pmCreate(args: readonly string[], io: CliIo): number {
  const parsed = parseArgs(args, ["office", "ops"]);
  const office = parsed.flags.office === true;
  const ops = parsed.flags.ops === true;
  if (office === ops) {
    throw new CliError("必须二选一：--office 或 --ops", EXIT.usage, [USAGE]);
  }

  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const issued = store.uow.run((tx) => {
      const roles = tx.roles
        .list(project_id)
        .filter((role) => role.role_id === "pm")
        .sort((left, right) => right.role_version - left.role_version);
      const latest = roles[0];
      if (latest === undefined) {
        throw new CliError(
          "还没有 pm 角色，先运行 cardigan role add",
          EXIT.usage,
        );
      }
      const mode = office ? ("office" as const) : ("ops" as const);
      // The Office may record decisions; Ops runs without that tool (§10.4).
      const tools = standingTools(latest.allowed_tools, mode);
      if (!office && tools.length === latest.allowed_tools.length) {
        throw new CliError(
          "PM 角色里没有 record_decision，无法区分 Ops；先运行 cardigan role add 补上",
          EXIT.usage,
        );
      }

      // §7.1 / §10.4 / M4.5: Office and Ops are two standing assignments of the
      // same pm role, told apart by `standing_mode`. Rows written before the
      // field existed get theirs from their newest token, once.
      backfillStandingModesInTransaction(tx, project_id);
      const assignments = tx.assignments.list(project_id);
      if (
        assignments.some(
          (a) =>
            a.external &&
            a.scope === "standing" &&
            a.standing_mode === mode &&
            a.status !== "released",
        )
      )
        throw new CliError(EXTERNAL_ASSIGNMENT_START_ERROR, EXIT.usage);
      const standing = assignments.filter(
        (candidate) =>
          candidate.scope === "standing" &&
          candidate.role_id === "pm" &&
          candidate.status === "active",
      );
      const existing = standing.find(
        (candidate) => candidate.standing_mode === mode,
      );
      if (existing === undefined && !isRoleActive(roles, "pm")) {
        throw new CliError("停用的角色不能被新指派", EXIT.usage);
      }
      if (
        existing === undefined &&
        standing.some(
          (candidate) =>
            candidate.standing_mode === undefined &&
            candidate.status === "active",
        )
      ) {
        // A legacy row with no token to infer from cannot be matched; the user
        // must resolve it explicitly rather than silently reuse it.
        throw new CliError(
          "有常驻 PM Assignment 没有模式且无法推断；先运行 cardigan token issue <A-n> 让它确定模式",
          EXIT.usage,
        );
      }

      const stamped =
        existing === undefined
          ? applyStandingMode(
              {
                id: tx.ids.next(project_id, "assignment"),
                scope: "standing",
                role_id: "pm",
                role_version: latest.role_version,
                status: "active",
                runtime_state: "not_provisioned",
                machine_id: "local",
                runtime_ref: null,
                // A standing PM assignment has no domain command; it is project
                // bootstrap data, like the project row itself.
                mcp_token_id: office ? "pm-office" : "pm-ops",
                created_at: new Date().toISOString(),
              },
              mode,
            )
          : applyStandingMode(existing, mode);
      if (!stamped.ok)
        throw new CliError(
          formatCommandError(
            "创建常驻 PM",
            office ? "Office" : "Ops",
            stamped.error,
          ),
          EXIT.usage,
        );
      const assignment: Assignment = stamped.value;
      if (existing === undefined) {
        tx.assignments.put(project_id, assignment);
      }
      return {
        assignment,
        reused: existing !== undefined,
        token: issueTokenForAssignment(tx, project_id, assignment.id, {
          role_version: assignment.role_version,
          allowed_tools: tools,
        }),
      };
    });

    io.stdout(
      [
        `${issued.reused ? "复用" : "已创建"}常驻 PM ${office ? "Office" : "Ops"}：${issued.assignment.id}（pm v${issued.assignment.role_version}）`,
        `allowed_tools：${issued.token.record.allowed_tools.join(", ")}`,
      ].join("\n"),
    );
    printToken(io, issued.token);
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function humanActionDone(args: readonly string[], io: CliIo): number {
  const [sub, ...rest] = args;
  if (sub !== "done") {
    throw new CliError(
      "用法：cardigan human-action done <H-n> --text <结果>",
      EXIT.usage,
      [USAGE],
    );
  }
  const parsed = parseArgs(rest, []);
  const humanActionId = parseHumanAction(parsed.positionals[0]);
  const text = required(parsed.flags, "text");

  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const action = runCommand(store, {
      operation: "完成待办操作",
      target: humanActionId,
      project_id,
      actor: resolveActor(io, project_id, store),
      reduce: (state, actor, ports) =>
        completeHumanAction(
          state,
          actor,
          { human_action_id: humanActionId, text },
          ports,
        ),
    });
    io.stdout(`已完成 ${humanActionId}：${action.status}`);
    return EXIT.ok;
  } finally {
    store.close();
  }
}

/** Open the store from `--data-dir`, `CARDIGAN_DATA_DIR` or `~/.local/share/cardigan`. */
function openStoreFrom(io: CliIo, flags: Args["flags"]): Store {
  return openCardiganStore({
    dataDir: announceDataDir(io, optional(flags, "data-dir")),
  });
}
