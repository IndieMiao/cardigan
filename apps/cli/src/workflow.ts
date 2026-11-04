import type { Assignment, HumanActionId, WorkItemId } from "@cardigan/domain";
import {
  assign,
  completeHumanAction,
  createCard,
  parseId,
} from "@cardigan/domain";
import { openStore as openCardiganStore, type Store } from "@cardigan/store";
import { type StartById, startAssignmentById } from "./assignment.js";
import { CliError, EXIT } from "./errors.js";
import {
  humanActor,
  issueTokenForAssignment,
  printToken,
  resolveDataDir,
  resolveProject,
  roleInTransaction,
  runCommand,
} from "./host.js";
import type { CliIo } from "./io.js";

const USAGE = [
  "用法：",
  "  cardigan card create --template dev --title <标题> --goal <目标> --acceptance <标准1;标准2> --repo <仓库> [--base-branch main] [--project <p>]",
  "  cardigan assign <W-n> --role <角色> [--machine local] [--start] [--project <p>]",
  "  cardigan token issue <A-n> [--project <p>]",
  "  cardigan pm create --office|--ops [--project <p>]",
  "  cardigan human-action done <h(n)> --text <结果> [--project <p>]",
  "",
  "通用：--project 省略时取 CARDIGAN_PROJECT，再取数据库里唯一的项目；",
  "      --data-dir 省略时取 CARDIGAN_DATA_DIR，再取 .data。",
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
    const [name, inline] = token.slice(2).split("=", 2) as [string, string?];
    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }
    const next = args[index + 1];
    if (booleans.includes(name)) {
      flags[name] = true;
      continue;
    }
    if (next === undefined) {
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
      return cardCreate(rest, io);
    case "assign":
      return await assignWorkItem(rest, io, hooks);
    case "token":
      return tokenIssue(rest, io);
    case "pm":
      return pmCreate(rest, io);
    case "human-action":
      return humanActionDone(rest, io);
    default:
      throw new CliError(`不认识的命令：${args.join(" ")}`, EXIT.usage, [
        USAGE,
      ]);
  }
}

function cardCreate(args: readonly string[], io: CliIo): number {
  const [sub, ...rest] = args;
  if (sub !== "create") {
    throw new CliError("用法：cardigan card create ...", EXIT.usage, [USAGE]);
  }
  const parsed = parseArgs(rest, []);
  const template = required(parsed.flags, "template");
  if (template !== "dev") {
    throw new CliError("M1 只有 dev 模板", EXIT.usage, [USAGE]);
  }
  const acceptance = list(required(parsed.flags, "acceptance"));
  if (acceptance.length === 0) {
    throw new CliError("--acceptance 至少写一条标准", EXIT.usage, [USAGE]);
  }

  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const card = runCommand(store, {
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
            repo: required(parsed.flags, "repo"),
            base_branch: optional(parsed.flags, "base-branch") ?? "main",
            template,
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

  const store = openStoreFrom(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    let issued: ReturnType<typeof issueTokenForAssignment> | undefined;
    const assignment = runCommand(store, {
      project_id,
      actor: humanActor(project_id),
      reduce: (state, actor, ports) =>
        assign(
          state,
          actor,
          {
            work_item_id: workItemId,
            role_id: roleId,
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
        `已指派 ${workItemId} → ${assignment.id}（${assignment.role_id} v${assignment.role_version}）`,
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
        throw new CliError(`Assignment ${assignmentId} 不存在`, EXIT.usage);
      }
      if (assignment.status !== "active") {
        throw new CliError(
          `Assignment ${assignmentId} 状态是 ${assignment.status}，只有 active 才能签发 Token`,
          EXIT.usage,
        );
      }
      const role = roleInTransaction(
        tx,
        project_id,
        assignment.role_id,
        assignment.role_version,
      );
      // A rotation keeps the assignment's own tool scope: re-issuing the Ops
      // token must not hand it record_decision (that would silently promote it).
      const previous = tx.tokensForAssignment(project_id, assignment.id).at(-1);
      return issueTokenForAssignment(tx, project_id, assignment.id, {
        role_version: role.role_version,
        allowed_tools: previous?.allowed_tools ?? role.allowed_tools,
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
      // The Office may record decisions; Ops runs without that tool (§10.4).
      const tools = office
        ? latest.allowed_tools
        : latest.allowed_tools.filter((tool) => tool !== "record_decision");
      if (!office && tools.length === latest.allowed_tools.length) {
        throw new CliError(
          "PM 角色里没有 record_decision，无法区分 Ops；先运行 cardigan role add 补上",
          EXIT.usage,
        );
      }

      // §7.1 / §10.4: Office and Ops are two standing assignments of the same
      // pm role. They are told apart by the tools their newest token carries,
      // which is the only place the distinction lives (no domain field for it).
      const standing = tx.assignments
        .list(project_id)
        .filter(
          (candidate) =>
            candidate.scope === "standing" &&
            candidate.role_id === "pm" &&
            candidate.status === "active",
        );
      const isOffice = (id: Parameters<typeof tx.tokensForAssignment>[1]) =>
        (
          tx.tokensForAssignment(project_id, id).at(-1)?.allowed_tools ?? []
        ).includes("record_decision");
      const existing = standing.find(
        (candidate) => isOffice(candidate.id) === office,
      );

      const assignment: Assignment = existing ?? {
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
      };
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

/** Open the store from `--data-dir`, `CARDIGAN_DATA_DIR` or `.data`. */
function openStoreFrom(io: CliIo, flags: Args["flags"]): Store {
  return openCardiganStore({
    dataDir: resolveDataDir(io, optional(flags, "data-dir")),
  });
}
