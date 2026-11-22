import type {
  Assignment,
  CardId,
  CommandState,
  HumanActionId,
  Machine,
  MergeClassificationInput,
  ProjectId,
  RiskTag,
  UiStateAndSave,
  WorkItemId,
} from "@cardigan/domain";
import {
  applyStandingMode,
  assignOrDefer,
  autoMergeSchedule,
  completeHumanAction,
  createCard,
  createHostOpsAssignment,
  createWorkItem,
  EXTERNAL_ASSIGNMENT_START_ERROR,
  getWorkItem,
  hasVerifiedMergeNoop,
  isRoleActive,
  listNeedsYou,
  markNoticesRead,
  mergeClassificationView,
  mergeShadowComparisons,
  notices,
  parseCardPriority,
  parseId,
  parseRuntimeUnknownGraceMs,
  projectPreferences,
  projectSnapshot,
  runtimeUnknownDeferred,
  saveMachine,
  selectStandingEmployee,
  setCardSensitive,
  standingTools,
  supersedeCard,
  updateCard,
  updateWorkItem,
  type WorkItemRequirements,
} from "@cardigan/domain";
import {
  checkRegisteredMachine,
  configureMachinePlacement,
  effectiveRunLimit,
  loadMergeGateConfig,
  loadRunCapacityConfig,
  MachineLeases,
  RuntimeTargets,
  targetProbe,
} from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { secureDataDirectory } from "@cardigan/runtime-herdr";
import {
  backfillStandingModesInTransaction,
  openStore as openCardiganStore,
  readMachineObservations,
  type Store,
  updateMachineDescription,
} from "@cardigan/store";
import { type StartById, startAssignmentById } from "./assignment.js";
import { loadOptionalConfigSync } from "./config.js";
import { runContentCommand } from "./content.js";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import { runFlowUpgrade } from "./flow-version.js";
import {
  announceDataDir,
  hasToken,
  issueTokenForAssignment,
  printToken,
  resolveActor,
  resolveCommandIdentity,
  resolveDataDir,
  resolveGlobalActor,
  resolveProject,
  roleInTransaction,
  runCommand,
  systemClock,
} from "./host.js";
import { rotateHostOps } from "./host-ops-rotate.js";
import type { CliIo } from "./io.js";
import { cliLaunchPaths } from "./paths.js";
import { printRotation, rotateStandingPmInStore } from "./pm-rotate.js";
import { launchExecution, terminalExecution } from "./runtime-check.js";

const USAGE = [
  "用法：",
  "  cardigan work-item create <C-n> --title <标题> --role <角色> --kind produce|verify [--required on|off] [--acceptance <标准>] [--target <W-n>] [--requirements <JSON>]",
  "  cardigan work-item update <W-n> --requirements <JSON> | work-item show <W-n>",
  "    card create 可用 --work-item-requirements <JSON> 按模板 key 追加机器要求；能力版本只接受无版本、=、>=。",
  "  cardigan card create [--template <id>] [--parent-card <C-id>] --title <标题> --goal <目标> [--acceptance <标准1;标准2>] [--repo <仓库>] [--base-branch main] [--project <p>]",
  "    界面或设计模板需加 --state-and-save 无写入，或传含 save_timing、leave_behavior、failure_feedback、consistency 的 JSON 对象。",
  "  cardigan card update <C-n> [--title <标题>] [--goal <目标>] [--acceptance <标准1;标准2>] [--priority none|low|medium|high|urgent] [--status backlog|todo|cancelled] [--risk-tags security,permission,numeric_rule|none] [--superseded-by <C-m>] [--project <p>]",
  "    update 至少提供一个修改字段；含分号的验收标准请加引号。",
  "    create/update 支持 --is-ui-framework on|off、--depends-on-cards C-1,C-2（none 清空）、--wait-for-dependencies on|off、--early-start on|off --dependency-reason <理由>。",
  "    --risk-tags 用逗号分隔 security、permission、numeric_rule；传 none 清空。",
  "    已完成卡片不能取消；请建新卡，再用 --superseded-by 标记已完成或已取消的旧卡。",
  "  cardigan card flow-upgrade <C-n…> --to <N> [--project <p>]  仅人可用，后续流程未开放前仅可选版本 1",
  "  cardigan card merge-shadow <C-n> [--project <p>]  查询分类确认、影子记录与实际决定对照",
  "  cardigan card update <C-n> --merge-classification <JSON>  对当前交付记录分类结论",
  "  cardigan card sensitive <C-n> on|off [--project <p>]   标记或取消敏感：被标记卡片的合并确认一律由你亲自处理",
  "  cardigan assign <W-n> --role <角色> [--employee <E-n 或名字>] [--machine <机器编号>] [--recovery-source main|backup] [--confirm-same-machine] [--os <系统>] [--arch <架构>] [--tags <逗号分隔标签>] [--start] [--project <p>]",
  "  cardigan machine register|update <编号> --label <名称> --os <系统> --arch <架构> [--tags <逗号分隔标签>] [--status online|degraded|offline|draining] [--project <p>]",
  "    update 的 label/os/arch 同步到该物理机器的所有已登记项目；tags/status 只修改当前项目。",
  "  cardigan machine reserve <机器> --resource <键> --start <带时区时间> --end <带时区时间> [--project <p>]",
  "  cardigan machine list|show|drain|check [编号] [--project <p>]  人专属登记与检查；远程现场探测尚未启用",
  "  cardigan token issue <A-n> [--project <p>]",
  "  cardigan pm create --office|--ops [--employee <E-n 或名字>] [--project <p>]",
  "  cardigan host-ops create [--employee <E-n>] [--project <p>]  创建常驻主机运维，启动时自动签发凭据",
  "  cardigan host-ops start [--project <p>]  启动常驻主机运维（已在运行就跳过）",
  "  cardigan host-ops rotate [--project <p>] [--employee <编号或名字>]  切换到最新角色版本并启动，默认保留原员工",
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
    case "work-item":
      return workItemCommand(rest, io);
    case "card":
      return cardCommand(rest, io);
    case "assign":
      return await assignWorkItem(rest, io, hooks);
    case "machine":
      return machineCommand(rest, io);
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
  if (sub === "flow-upgrade") return runFlowUpgrade(rest, io);
  if (sub === "merge-shadow") return cardMergeShadow(rest, io);
  if (sub === "sensitive") return cardSensitive(rest, io);
  if (sub === "high-risk") return cardHighRisk(rest, io);
  throw new CliError(
    "用法：cardigan card create|update|sensitive|high-risk ...",
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

/** Flow Lite: classification flags cannot impersonate this human-only requirement. */
function cardHighRisk(args: readonly string[], io: CliIo): number {
  const { flags, positionals } = parseArgs(args, []);
  const parsed = parseId("card", positionals[0]);
  const enabled = positionals[1];
  if (
    !parsed.ok ||
    positionals.length !== 2 ||
    (enabled !== "on" && enabled !== "off") ||
    Object.keys(flags).some((key) => !["project", "data-dir"].includes(key))
  )
    throw new CliError(
      "用法：cardigan card high-risk <C-n> on|off",
      EXIT.usage,
      [USAGE],
    );
  const store = openStoreFrom(io, flags);
  try {
    const project_id = resolveProject(store, io, optional(flags, "project"));
    runCommand(store, {
      operation: "修改高危标记",
      target: parsed.value.id,
      project_id,
      actor: resolveActor(io, project_id, store),
      reduce: (state, actor, ports) =>
        updateCard(
          state,
          actor,
          { card_id: parsed.value.id, high_risk: enabled === "on" },
          ports,
        ),
    });
    io.stdout(`高危标记：${enabled}`);
    return EXIT.ok;
  } finally {
    store.close();
  }
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

async function cardUpdate(args: readonly string[], io: CliIo): Promise<number> {
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
    "is-ui-framework",
    "depends-on-cards",
    "wait-for-dependencies",
    "early-start",
    "dependency-reason",
    "superseded-by",
    "merge-classification",
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
  let classification: MergeClassificationInput | undefined;
  if (flags["merge-classification"] !== undefined) {
    if (changed.length !== 1)
      throw new CliError("分类确认不能与其他修改混用", EXIT.usage);
    try {
      classification = JSON.parse(
        required(flags, "merge-classification"),
      ) as MergeClassificationInput;
    } catch {
      throw new CliError("分类确认须为 JSON 对象", EXIT.usage);
    }
  }
  const patch: Omit<Parameters<typeof updateCard>[2], "card_id"> = {
    ...cardDependencyFlags(flags),
    ...(classification === undefined
      ? {}
      : { merge_classification: classification }),
    ...(flags.title === undefined ? {} : { title: required(flags, "title") }),
    ...(flags.goal === undefined ? {} : { goal: required(flags, "goal") }),
    ...(acceptance === undefined ? {} : { acceptance_criteria: acceptance }),
    ...(priority === undefined ? {} : { priority }),
    ...(status === undefined ? {} : { status }),
    ...(riskTags === undefined ? {} : { risk_tags: riskTags }),
  };
  const cardId = parsedId.value.id;
  const store = await openPlacementStore(io, flags);
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

function cardDependencyFlags(
  flags: Args["flags"],
): Pick<
  Parameters<typeof updateCard>[2],
  | "is_ui_framework"
  | "depends_on_cards"
  | "wait_for_dependencies"
  | "early_start"
  | "dependency_reason"
> {
  const toggle = (name: string) => {
    const value = required(flags, name);
    if (value !== "on" && value !== "off")
      throw new CliError(`--${name} 只接受 on 或 off`, EXIT.usage);
    return value === "on";
  };
  const raw =
    flags["depends-on-cards"] === undefined
      ? undefined
      : required(flags, "depends-on-cards");
  const ids =
    raw === undefined
      ? undefined
      : raw === "none"
        ? []
        : raw.split(",").map((value) => {
            const parsed = parseId("card", value.trim());
            if (!parsed.ok)
              throw new CliError(
                "--depends-on-cards 须为逗号分隔的卡号，清空请传 none",
                EXIT.usage,
              );
            return parsed.value.id;
          });
  return {
    ...(flags["is-ui-framework"] === undefined
      ? {}
      : { is_ui_framework: toggle("is-ui-framework") }),
    ...(ids === undefined ? {} : { depends_on_cards: ids }),
    ...(flags["wait-for-dependencies"] === undefined
      ? {}
      : { wait_for_dependencies: toggle("wait-for-dependencies") }),
    ...(flags["early-start"] === undefined
      ? {}
      : { early_start: toggle("early-start") }),
    ...(flags["dependency-reason"] === undefined
      ? {}
      : { dependency_reason: required(flags, "dependency-reason") }),
  };
}

function jsonFlag(flags: Args["flags"], name: string): unknown {
  try {
    return JSON.parse(required(flags, name));
  } catch {
    throw new CliError(`--${name} 必须是合法 JSON`, EXIT.usage);
  }
}

async function workItemCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const [action, ...rest] = args;
  if (!["create", "update", "show"].includes(action ?? ""))
    throw new CliError(
      "用法：cardigan work-item create|update|show",
      EXIT.usage,
    );
  const { flags, positionals } = parseArgs(rest, []);
  const allowed = [
    "project",
    "data-dir",
    ...(action === "create"
      ? [
          "title",
          "role",
          "kind",
          "required",
          "acceptance",
          "target",
          "requirements",
        ]
      : action === "update"
        ? ["requirements"]
        : []),
  ];
  if (
    positionals.length !== 1 ||
    Object.keys(flags).some((key) => !allowed.includes(key))
  )
    throw new CliError("工作项参数不合法", EXIT.usage);
  const store = await openPlacementStore(io, flags);
  try {
    const project_id = resolveProject(store, io, optional(flags, "project"));
    const identity = resolveCommandIdentity(io, project_id, store);
    if (action === "show") {
      const itemId = parseWorkItem(positionals[0]);
      const result = runCommand(store, {
        operation: "读取工作项",
        target: itemId,
        project_id,
        ...identity,
        reduce: (state, actor, ports) =>
          getWorkItem(state, actor, itemId, ports),
      });
      io.stdout(JSON.stringify(result, null, 2));
      return EXIT.ok;
    }
    const requirements =
      flags.requirements === undefined
        ? undefined
        : (jsonFlag(flags, "requirements") as WorkItemRequirements);
    if (action === "update") {
      if (requirements === undefined)
        throw new CliError("需要 --requirements", EXIT.usage);
      const item = runCommand(store, {
        operation: "更新工作项",
        target: positionals[0] as string,
        project_id,
        ...identity,
        reduce: (s, a, p) =>
          updateWorkItem(
            s,
            a,
            { work_item_id: parseWorkItem(positionals[0]), requirements },
            p,
          ),
      });
      io.stdout(JSON.stringify(item, null, 2));
    } else {
      const card = parseId("card", positionals[0]);
      const kind = required(flags, "kind");
      const requiredFlag = optional(flags, "required") ?? "on";
      if (
        !card.ok ||
        !["produce", "verify"].includes(kind) ||
        !["on", "off"].includes(requiredFlag)
      )
        throw new CliError("卡号、工作项类型或必需标记不合法", EXIT.usage);
      const item = runCommand(store, {
        operation: "创建工作项",
        target: card.value.id,
        project_id,
        ...identity,
        reduce: (s, a, p) =>
          createWorkItem(
            s,
            a,
            {
              card_id: card.value.id,
              title: required(flags, "title"),
              role_id: required(flags, "role"),
              kind: kind as "produce" | "verify",
              required: requiredFlag === "on",
              completion_criteria: list(optional(flags, "acceptance") ?? ""),
              ...(requirements === undefined ? {} : { requirements }),
              ...(flags.target === undefined
                ? {}
                : {
                    target_work_item_id: parseWorkItem(
                      required(flags, "target"),
                    ),
                  }),
            },
            p,
          ),
      });
      io.stdout(JSON.stringify(item, null, 2));
    }
    return EXIT.ok;
  } finally {
    store.close();
  }
}

async function cardCreate(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(args, []);
  const parent =
    parsed.flags["parent-card"] === undefined
      ? undefined
      : parseId("card", required(parsed.flags, "parent-card"));
  if (parent && !parent.ok)
    throw new CliError("--parent-card 须为需求卡编号", EXIT.usage, [USAGE]);
  const template = optional(parsed.flags, "template") ?? "dev";
  const acceptance = list(optional(parsed.flags, "acceptance") ?? "");
  const repo = optional(parsed.flags, "repo");
  const base =
    optional(parsed.flags, "base-branch") ?? (repo ? "main" : undefined);

  const store = await openPlacementStore(io, parsed.flags);
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
            ...cardDependencyFlags(parsed.flags),
            ...(parsed.flags["state-and-save"] === undefined
              ? {}
              : {
                  state_and_save:
                    parsed.flags["state-and-save"] === "无写入"
                      ? "无写入"
                      : (jsonFlag(
                          parsed.flags,
                          "state-and-save",
                        ) as UiStateAndSave),
                }),
            ...(parsed.flags["work-item-requirements"] === undefined
              ? {}
              : {
                  work_item_requirements: jsonFlag(
                    parsed.flags,
                    "work-item-requirements",
                  ) as Readonly<Record<string, WorkItemRequirements>>,
                }),
            title: required(parsed.flags, "title"),
            goal: required(parsed.flags, "goal"),
            acceptance_criteria: acceptance,
            source: { kind: "quote", text: required(parsed.flags, "goal") },
            ...(repo === undefined ? {} : { repo }),
            ...(base === undefined ? {} : { base_branch: base }),
            ...(parent?.ok ? { parent_card_id: parent.value.id } : {}),
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

async function machineCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args.includes("--help")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (hasToken(io) || io.env.MCP_TOKEN !== undefined)
    throw new CliError("机器管理仅限人类操作，Token 模式不可用。", EXIT.usage);
  const [sub, ...rest] = args;
  if (
    ![
      "register",
      "update",
      "list",
      "show",
      "drain",
      "check",
      "reserve",
    ].includes(sub ?? "")
  )
    throw new CliError(
      "用法：cardigan machine register|update|list|show|drain|check",
      EXIT.usage,
    );
  const parsed = parseArgs(rest, []);
  for (const key of Object.keys(parsed.flags))
    if (
      !(
        sub === "register" || sub === "update"
          ? ["project", "data-dir", "label", "os", "arch", "tags", "status"]
          : sub === "reserve"
            ? ["project", "data-dir", "resource", "start", "end"]
            : ["project", "data-dir"]
      ).includes(key)
    )
      throw new CliError(`机器登记不接受 --${key}`, EXIT.usage);
  const id = parsed.positionals[0];
  if (sub !== "list" && !id) throw new CliError("缺少机器编号", EXIT.usage);
  const config = await loadRunCapacityConfig({ env: io.env });
  if (config.errors.length)
    throw new CliError("机器操作已停止：并发配置无效。", EXIT.failure, [
      ...config.errors,
    ]);
  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const actor = resolveActor(io, project_id, store);
    if (actor.kind !== "human")
      throw new CliError("机器管理仅限人类操作", EXIT.usage);
    const limit = (machine: string) =>
      effectiveRunLimit(
        store,
        machine,
        config.forMachine,
        config.maxForMachine,
      );
    if (sub === "reserve") {
      const leases = new MachineLeases(
        store,
        config,
        targetProbe(async (project, machine_id) => {
          const dataDir = resolveDataDir(
            io,
            optional(parsed.flags, "data-dir"),
          );
          const connection = await terminalExecution(
            io,
            dataDir,
            null,
            machine_id,
          );
          const result = await RuntimeTargets.create({
            ...connection,
            env: io.env,
            store,
            project,
          });
          if (!result.ok) throw new Error("目标不可用");
          return (
            await result.value.forLaunch(project, {
              machine_id,
              runtime_ref: null,
            })
          ).execution;
        }),
      );
      const generation = await leases.reserve(
        actor,
        id ?? "",
        optional(parsed.flags, "resource") ?? "",
        optional(parsed.flags, "start") ?? "",
        optional(parsed.flags, "end") ?? "",
        () => new Date().toISOString(),
      );
      io.stdout(JSON.stringify({ generation }));
      return EXIT.ok;
    }
    if (sub === "list" || sub === "show" || sub === "check") {
      const machines = store.uow.read((tx) => tx.machines.list(project_id));
      const selected =
        sub === "list" ? machines : machines.filter((m) => m.id === id);
      if (sub !== "list" && !selected.length)
        throw new CliError("本项目未登记该机器", EXIT.failure);
      io.stdout(
        JSON.stringify(
          selected.map((m) => ({
            ...m,
            max_assignments: limit(m.id),
            ...(sub === "show"
              ? readMachineObservations(store, project_id, m.id)
              : {}),
          })),
          null,
          2,
        ),
      );
      if (sub === "check") {
        const machine = selected[0] as Machine;
        const dataDir = resolveDataDir(io, optional(parsed.flags, "data-dir"));
        const observations = await checkRegisteredMachine(
          {
            store,
            project: project_id,
            machine: machine.id,
            env: io.env,
            browsersPath: () =>
              loadOptionalConfigSync(cliLaunchPaths(io, dataDir))?.browser
                ?.browsers_path,
          },
          async () => {
            const connection = await terminalExecution(
              io,
              dataDir,
              null,
              machine.id,
            );
            const created = await RuntimeTargets.create({
              ...connection,
              env: io.env,
              store,
              project: project_id,
            });
            if (!created.ok)
              throw new CliError(created.error.message, EXIT.failure);
            return created.value;
          },
        );
        io.stdout(JSON.stringify(observations, null, 2));
        if (!observations.health?.available)
          throw new CliError("机器检查未通过", EXIT.failure);
      }
      return EXIT.ok;
    }
    const result = store.uow.run((tx) => {
      const state = loadCommandState(tx, project_id);
      const ports = { clock: systemClock, ids: tx.ids };
      const old = state.machines?.find((m) => m.id === id);
      const field = (key: "label" | "os" | "arch") =>
        optional(parsed.flags, key) ??
        old?.[key] ??
        required(parsed.flags, key);
      const machine: Machine = {
        id: id as string,
        label: field("label"),
        os: field("os"),
        arch: field("arch"),
        herdr_machine: old?.herdr_machine ?? (id as string),
        tags:
          parsed.flags.tags === undefined
            ? (old?.tags ?? [])
            : required(parsed.flags, "tags") === "none"
              ? []
              : required(parsed.flags, "tags")
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
        max_assignments: limit(id as string),
        status: (optional(parsed.flags, "status") ??
          old?.status ??
          "offline") as Machine["status"],
        last_seen: old?.last_seen ?? ports.clock.now(),
      };
      const effect = saveMachine(
        state,
        actor,
        { machine, operation: sub as "register" | "update" | "drain" },
        ports,
      );
      if (!effect.ok)
        throw new CliError(
          formatCommandError("机器登记", id as string, effect.error),
          EXIT.usage,
        );
      if (
        sub === "update" &&
        old &&
        (old.label !== machine.label ||
          old.os !== machine.os ||
          old.arch !== machine.arch)
      ) {
        const projections = updateMachineDescription(store.database, machine);
        for (const projection of projections) {
          if (projection.project_id === project_id) continue;
          const peer = saveMachine(
            loadCommandState(tx, projection.project_id),
            { ...actor, project_id: projection.project_id },
            { machine: projection.machine, operation: "update" },
            ports,
          );
          if (!peer.ok)
            throw new CliError(
              formatCommandError("机器登记", id as string, peer.error),
              EXIT.usage,
            );
          persistEffect(tx, projection.project_id, peer.value);
        }
      }
      persistEffect(tx, project_id, effect.value);
      return effect.value.data;
    });
    io.stdout(JSON.stringify(result));
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
    ["confirm-same-machine"],
  );
  const confirmSameMachine = parsed.flags["confirm-same-machine"];
  if (
    confirmSameMachine !== undefined &&
    (confirmSameMachine !== true || parsed.positionals.length !== 1)
  )
    throw new CliError(
      "--confirm-same-machine 是无值开关，只接受一个工作项编号",
      EXIT.usage,
    );
  const workItemId = parseWorkItem(parsed.positionals[0]);
  const roleId = required(parsed.flags, "role");
  const machine = optional(parsed.flags, "machine");
  const recoverySource = optional(parsed.flags, "recovery-source");
  if (
    recoverySource !== undefined &&
    !["main", "backup"].includes(recoverySource)
  )
    throw new CliError("--recovery-source 只接受 main 或 backup", EXIT.usage);
  const employee = optional(parsed.flags, "employee");

  if (start)
    await secureDataDirectory(
      await launchExecution(
        io,
        resolveDataDir(io, optional(parsed.flags, "data-dir")),
      ),
    );

  const store = await openPlacementStore(io, parsed.flags);
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
        const result = assignOrDefer(
          state,
          actor,
          {
            work_item_id: workItemId,
            role_id: roleId,
            ...(employee === undefined ? {} : { employee_id: employee }),
            ...(machine === undefined ? {} : { machine_id: machine }),
            ...(confirmSameMachine ? { confirm_same_machine: true } : {}),
            ...(recoverySource
              ? { recovery_source: recoverySource as "main" | "backup" }
              : {}),
            ...(optional(parsed.flags, "os")
              ? { os: required(parsed.flags, "os") }
              : {}),
            ...(optional(parsed.flags, "arch")
              ? { arch: required(parsed.flags, "arch") }
              : {}),
            ...(optional(parsed.flags, "tags")
              ? {
                  required_tags: required(parsed.flags, "tags")
                    .split(",")
                    .filter(Boolean),
                }
              : {}),
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
        if (start || caller.kind !== "human" || "deferred" in created) return;
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

    if ("deferred" in assignment)
      throw new CliError(`未能选机，已交 PM：${assignment.reason}`, EXIT.usage);
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
      backfillStandingModesInTransaction(tx, project_id);
      // CLI rotation and launch share the upgrade fence, audit and tool ceiling.
      return issueTokenForAssignment(tx, project_id, assignment.id, role);
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
      : [
          "project",
          "data-dir",
          "mcp-url",
          "hc-session",
          ...(sub === "rotate" ? ["employee"] : []),
        ];
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
    if (sub === "rotate") {
      const employee = optional(parsed.flags, "employee");
      await rotateHostOps({
        ...(employee === undefined ? {} : { employee }),
        store,
        io,
        project_id,
        dataDir: resolveDataDir(io, optional(parsed.flags, "data-dir")),
        ...(optional(parsed.flags, "hc-session")
          ? { session: optional(parsed.flags, "hc-session") as string }
          : {}),
      });
    }
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
    let unknownGraceMs: number;
    try {
      unknownGraceMs = parseRuntimeUnknownGraceMs(
        io.env.CARDIGAN_RUNTIME_UNKNOWN_GRACE_SECONDS,
      );
    } catch (error) {
      throw new CliError((error as Error).message, EXIT.usage);
    }
    const now = systemClock.now();
    const { decisions, actions, later, incidents, noticeList, held, waiting } =
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
          // C-212: deferred items, listed only as one folded line.
          later: needs.later,
          // Same source as the Workbench 知会 section (§7.4): newest first.
          noticeList: notices(state),
          incidents: tx.assignments.list(project_id).filter(
            (a) =>
              a.status === "active" &&
              ["lost", "unknown"].includes(a.runtime_state) &&
              // C-228: same grace period as the Workbench Needs You.
              !runtimeUnknownDeferred(state.events, a, now, unknownGraceMs),
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
            ...(decision.human_required_reason
              ? [`    须由你亲自决定：${decision.human_required_reason}`]
              : []),
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
                  `    ${action.triage === "host" ? (action.host_operator === "external" ? "主机操作（外接操作员）：" : "主机操作：") : ""}${action.handoff.title}（项目经理已改写）`,
                  ...(action.handoff.todo
                    ? [`    你要做什么：${action.handoff.todo}`]
                    : []),
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
    if (later.length > 0)
      lines.push(
        `稍后（${later.length}，还没到时机）：${later.map((item) => `${item.id}（${item.waiting_for}）`).join("、")}`,
      );
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

      const reference = optional(parsed.flags, "employee");
      let employeeId = existing?.employee_id;
      if (!existing || reference !== undefined) {
        const selected = selectStandingEmployee(
          {
            project_id,
            assignments,
            employees: tx.employees.list(),
            employee_activity: tx.employees.assignmentActivity?.() ?? [],
          },
          "pm",
          reference,
        );
        if (!selected.ok)
          throw new CliError(selected.error.message, EXIT.usage);
        if (existing && selected.value?.id !== employeeId)
          throw new CliError("Assignment 的员工创建后不能修改", EXIT.usage);
        employeeId = selected.value?.id;
      }
      const stamped =
        existing === undefined
          ? applyStandingMode(
              {
                id: tx.ids.next(project_id, "assignment"),
                scope: "standing",
                ...(employeeId ? { employee_id: employeeId } : {}),
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

async function humanActionDone(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
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

  const store = await openPlacementStore(io, parsed.flags);
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
      ...resolveCommandIdentity(io, project_id, store),
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
async function openPlacementStore(
  io: CliIo,
  flags: Args["flags"],
): Promise<Store> {
  const dataDir = announceDataDir(io, optional(flags, "data-dir"));
  const limits = await loadRunCapacityConfig({ env: io.env });
  const store = openCardiganStore({ dataDir });
  configureMachinePlacement(store, dataDir, io.env, limits, () =>
    loadOptionalConfigSync(cliLaunchPaths(io, dataDir)),
  );
  return store;
}
function openStoreFrom(io: CliIo, flags: Args["flags"]): Store {
  return openCardiganStore({
    dataDir: announceDataDir(io, optional(flags, "data-dir")),
  });
}

function cardMergeShadow(args: readonly string[], io: CliIo): number {
  const { flags, positionals } = parseArgs(args, []);
  const parsed = parseId("card", positionals[0]);
  if (
    positionals.length !== 1 ||
    !parsed.ok ||
    Object.keys(flags).some((k) => !["project", "data-dir"].includes(k))
  )
    throw new CliError(
      "用法：cardigan card merge-shadow <C-n> [--project <p>]",
      EXIT.usage,
    );
  const store = openStoreFrom(io, flags);
  try {
    const project = resolveProject(store, io, optional(flags, "project"));
    // Local human read; Agent tokens must use their scoped get_card tool.
    if (resolveActor(io, project, store).kind !== "human")
      throw new CliError("此查询仅限本机人类入口", EXIT.usage);
    const view = store.uow.read((tx) => {
      const state = loadCommandState(tx, project);
      const card = state.cards.find((c) => c.id === parsed.value.id);
      if (!card) throw new CliError("卡片不存在", EXIT.usage);
      return {
        classification: mergeClassificationView(state, card) ?? null,
        comparisons: mergeShadowComparisons(state, card.id),
      };
    });
    io.stdout(JSON.stringify(view, null, 2));
    return EXIT.ok;
  } finally {
    store.close();
  }
}
