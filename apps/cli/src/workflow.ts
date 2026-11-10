import type {
  Assignment,
  HumanActionId,
  ProjectId,
  WorkItemId,
} from "@cardigan/domain";
import {
  applyStandingMode,
  assign,
  completeHumanAction,
  createCard,
  isRoleActive,
  listNeedsYou,
  parseId,
  standingTools,
  supersedeCard,
  updateCard,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  resolveExecutionConfig,
  secureDataDirectory,
} from "@cardigan/runtime-herdr";
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
  humanActor,
  issueTokenForAssignment,
  printToken,
  resolveDataDir,
  resolveProject,
  roleInTransaction,
  runCommand,
  systemClock,
} from "./host.js";
import type { CliIo } from "./io.js";

const USAGE = [
  "用法：",
  "  cardigan card create [--template <id>] --title <标题> --goal <目标> [--acceptance <标准1;标准2>] [--repo <仓库>] [--base-branch main] [--project <p>]",
  "  cardigan card update <C-n> [--title <标题>] [--goal <目标>] [--acceptance <标准1;标准2>] [--priority <n>] [--status backlog|todo|cancelled] [--superseded-by <C-m>] [--project <p>]",
  "    update 至少提供一个修改字段；含分号的验收标准请加引号。",
  "    已完成卡片不能取消；请建新卡，再用 --superseded-by 标记已完成或已取消的旧卡。",
  "  cardigan assign <W-n> --role <角色> [--employee <E-n 或名字>] [--machine local] [--start] [--project <p>]",
  "  cardigan token issue <A-n> [--project <p>]",
  "  cardigan pm create --office|--ops [--project <p>]",
  "  cardigan pm start [--office] [--ops] [--project <p>]  一键启动常驻 PM（已在运行就跳过）",
  "  cardigan needs-you [--project <p>]                   看待你拍板和待你执行的事项",
  "  cardigan human-action done <h(n)> --text <结果> [--project <p>]",
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
      `HumanAction 编号不合法：${JSON.stringify(raw)}（形如 h(3)）`,
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
  throw new CliError("用法：cardigan card create|update ...", EXIT.usage, [
    USAGE,
  ]);
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
      : Number(required(flags, "priority"));
  if (priority !== undefined && !Number.isFinite(priority)) {
    throw new CliError("--priority 必须是有限数值", EXIT.usage, [USAGE]);
  }
  const acceptance =
    flags.acceptance === undefined
      ? undefined
      : list(required(flags, "acceptance"));
  if (acceptance?.length === 0) {
    throw new CliError("--acceptance 至少写一条标准", EXIT.usage, [USAGE]);
  }
  const patch: Omit<Parameters<typeof updateCard>[2], "card_id"> = {
    ...(flags.title === undefined ? {} : { title: required(flags, "title") }),
    ...(flags.goal === undefined ? {} : { goal: required(flags, "goal") }),
    ...(acceptance === undefined ? {} : { acceptance_criteria: acceptance }),
    ...(priority === undefined ? {} : { priority }),
    ...(status === undefined ? {} : { status }),
  };
  const cardId = parsedId.value.id;
  const store = openStoreFrom(io, flags);
  try {
    const project_id = resolveProject(store, io, optional(flags, "project"));
    store.uow.run((tx) => {
      const actor = humanActor(project_id);
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
      actor: humanActor(project_id),
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
      resolveExecutionConfig({
        ...io.env,
        CARDIGAN_DATA_DIR: resolveDataDir(
          io,
          optional(parsed.flags, "data-dir"),
        ),
      }),
    );

  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    let issued: ReturnType<typeof issueTokenForAssignment> | undefined;
    const assignment = runCommand(store, {
      operation: "指派工作项",
      target: workItemId,
      project_id,
      actor: humanActor(project_id),
      reduce: (state, actor, ports) =>
        assign(
          state,
          actor,
          {
            work_item_id: workItemId,
            role_id: roleId,
            ...(employee === undefined ? {} : { employee_id: employee }),
            ...(machine === undefined ? {} : { machine_id: machine }),
          },
          ports,
        ),
      // `--start` issues the only token inside `startAssignment`, into the run
      // directory; issuing one here would print a token that is revoked at once.
      after: (tx, created) => {
        if (start) return;
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

/** `cardigan pm create|start`: the two standing PM assignments (§7.1). */
async function pmCommand(
  args: readonly string[],
  io: CliIo,
  hooks: CliHooks,
): Promise<number> {
  const [sub] = args;
  if (sub === "start") return await pmStart(args.slice(1), io, hooks);
  return pmCreate(args, io);
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
 * (development plan §7.3): open human decisions and pending human actions.
 */
function needsYou(args: readonly string[], io: CliIo): number {
  const parsed = parseArgs(args, []);
  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const { decisions, actions, incidents } = store.uow.read((tx) => ({
      decisions: tx.decisions
        .list(project_id)
        .filter(
          (decision) =>
            decision.decider === "human" &&
            ["open", "provisional"].includes(decision.status),
        ),
      actions: unwrap(
        listNeedsYou(loadCommandState(tx, project_id), humanActor(project_id)),
      ).data.human_actions,
      // §13.9: a lost runtime needs the human to decide whether to take over,
      // so it belongs on the same page as decisions and human actions.
      incidents: tx.assignments
        .list(project_id)
        .filter(
          (assignment) =>
            assignment.status === "active" &&
            ["lost", "unknown"].includes(assignment.runtime_state),
        ),
    }));

    if (
      decisions.length === 0 &&
      actions.length === 0 &&
      incidents.length === 0
    ) {
      io.stdout("Needs You 是空的：没有待你拍板的事项，也没有待你执行的操作。");
      return EXIT.ok;
    }
    const lines: string[] = [];
    if (decisions.length > 0) {
      lines.push(`待你拍板（${decisions.length}）`);
      for (const decision of decisions) {
        lines.push(
          [
            `  ${decision.id}${decision.card_id === undefined ? "" : `  ${decision.card_id}`}`,
            `    ${decision.question}`,
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
            `    ${action.instructions}`,
            `    为什么需要你：${action.why_human}`,
            `    期望返回：${action.expected_return}`,
            ...(action.due === undefined ? [] : [`    截止：${action.due}`]),
          ].join("\n"),
        );
      }
    }
    io.stdout(lines.join("\n"));
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
      const standing = tx.assignments
        .list(project_id)
        .filter(
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
      "用法：cardigan human-action done <h(n)> --text <结果>",
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
      actor: humanActor(project_id),
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
