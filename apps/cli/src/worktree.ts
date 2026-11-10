import type {
  Assignment,
  AssignmentId,
  Decision,
  ProjectId,
} from "@cardigan/domain";
import { parseId, recordDecision } from "@cardigan/domain";
import {
  CentralRepositoryService,
  GitWorktreeService,
} from "@cardigan/git-service";
import {
  CentralGitTransport,
  LocalGitTransport,
  type WorkspaceGit,
} from "@cardigan/git-transport";
import { HerdrRuntime, resolveExecutionConfig } from "@cardigan/runtime-herdr";
import { openStore as openCardiganStore, type Store } from "@cardigan/store";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import {
  announceDataDir,
  resolveActor,
  resolveDataDir,
  resolveProject,
  runCommand,
  systemClock,
} from "./host.js";
import type { CliIo } from "./io.js";

/**
 * M4.4 worktree commands (plan §3.6, development plan §12.6).
 *
 * `diff` shows what a cleanup would lose. `clean --force` and `keep` record the
 * human's answer to the open `worktree_cleanup` decision; the cleanup loop then
 * backs the worktree up (patch + commits) and removes it, or leaves it alone.
 * No Git deletion happens here, so the command cannot bypass the audit trail.
 */
const USAGE = [
  "用法：",
  "  cardigan worktree diff <A-n> [--project <p>]        看 worktree 的未提交改动和未跟踪文件",
  "  cardigan worktree clean <A-n> --force [--quote <原话>]  确认强制清理（先备份补丁和提交）",
  "  cardigan worktree keep <A-n> [--quote <原话>]       保留 worktree，之后不再询问",
  "",
  "通用：--project 省略时取 CARDIGAN_PROJECT，再取数据库里唯一的项目；",
  "      --data-dir 省略时取 CARDIGAN_DATA_DIR，再取 ~/.local/share/cardigan。",
].join("\n");

interface Args {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}
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
    if (booleans.includes(name)) {
      flags[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new CliError(`${token} 需要一个值`, EXIT.usage, [USAGE]);
    flags[name] = value;
    index += 1;
  }
  return { positionals, flags };
}
const optional = (flags: Args["flags"], name: string): string | undefined => {
  const value = flags[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};
function assignmentId(raw: string | undefined): AssignmentId {
  const parsed = parseId("assignment", raw);
  if (!parsed.ok)
    throw new CliError(
      `Assignment 编号不合法：${JSON.stringify(raw)}`,
      EXIT.usage,
      [USAGE],
    );
  return parsed.value.id;
}
function open(io: CliIo, flags: Args["flags"]): Store {
  return openCardiganStore({
    dataDir: announceDataDir(io, optional(flags, "data-dir")),
  });
}

export async function runWorktreeCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "diff":
      return await diffCommand(rest, io);
    case "clean":
      return cleanCommand(rest, io, "force_clean");
    case "keep":
      return cleanCommand(rest, io, "keep");
    default:
      throw new CliError(
        "用法：cardigan worktree diff|clean|keep <A-n>",
        EXIT.usage,
        [USAGE],
      );
  }
}

/** The assignment, its project and the newest unresolved cleanup decision. */
function context(
  store: Store,
  project_id: ProjectId,
  id: AssignmentId,
): { assignment: Assignment; decision: Decision | undefined } {
  const assignment = store.uow.read((tx) => tx.assignments.get(project_id, id));
  if (assignment === undefined)
    throw new CliError(`Assignment ${id} 不存在`, EXIT.usage);
  if (
    assignment.scope !== "work_item" ||
    assignment.worktree_path === undefined
  )
    throw new CliError(`${id} 没有 worktree`, EXIT.usage);
  const decision = store.uow.read((tx) =>
    tx.decisions
      .list(project_id)
      .filter(
        (candidate) =>
          candidate.trigger === "worktree_cleanup" &&
          candidate.assignment_id === assignment.id &&
          candidate.status !== "superseded",
      )
      .at(-1),
  );
  return { assignment, decision };
}

function worktrees(
  store: Store,
  project_id: ProjectId,
  dataDir: string,
  execution: ReturnType<typeof resolveExecutionConfig>,
  workspace?: WorkspaceGit,
) {
  const central = new CentralRepositoryService(
    new CentralGitTransport({
      dataDir,
      ...(execution.mode === "agent-ssh"
        ? { agentRoot: execution.agentRoot }
        : {}),
    }),
    {
      dataDir,
      ...(execution.mode === "agent-ssh"
        ? { repositoriesRoot: `${execution.agentRoot}/repos` }
        : {}),
    },
  );
  const record = store.getProject(project_id);
  if (record?.repo_path === undefined || record.repo_path === null)
    throw new CliError(
      `项目 ${project_id} 还没有登记仓库，先运行 cardigan project set-repo`,
      EXIT.usage,
    );
  return {
    central,
    project: {
      project_id,
      source_repo: record.repo_path,
      base_branch: record.base_branch ?? "main",
    },
    service: new GitWorktreeService(
      new LocalGitTransport("git", 30_000, workspace),
      central,
      {
        dataDir,
        ...(execution.mode === "agent-ssh"
          ? {
              repositoriesRoot: `${execution.agentRoot}/repos`,
              worktreesRoot: `${execution.agentRoot}/worktrees`,
            }
          : {}),
      },
    ),
  };
}

async function diffCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs(args, []);
  const id = assignmentId(parsed.positionals[0]);
  const store = open(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const dataDir = resolveDataDir(io, optional(parsed.flags, "data-dir"));
    const execution = resolveExecutionConfig({
      ...io.env,
      CARDIGAN_DATA_DIR: dataDir,
    });
    // Workspace Git in agent-ssh mode must run as the agent (§12.6).
    const runtime =
      execution.mode === "agent-ssh"
        ? await (async () => {
            const created = await HerdrRuntime.create({
              execution,
              session: io.env.CARDIGAN_HC_SESSION ?? "cardigan",
            });
            if (!created.ok)
              throw new CliError(
                formatCommandError("连接运行时", "Herdr", created.error),
                EXIT.failure,
              );
            return created.value;
          })()
        : undefined;
    // agent-ssh: workspace Git runs through the Agent entry, never as the host.
    const workspace: WorkspaceGit | undefined =
      runtime === undefined
        ? undefined
        : {
            run: async (argv) => {
              const at = argv.indexOf("-C"),
                target = at >= 0 ? argv[at + 1] : undefined;
              const result = await runtime.captureAgent("git", [
                ...(target === undefined
                  ? []
                  : ["-c", `safe.directory=${target}`]),
                ...argv,
              ]);
              if (!result.ok)
                throw new CliError(
                  formatCommandError("读取工作区差异", id, result.error),
                  EXIT.failure,
                );
              return result.value;
            },
          };
    const binding = worktrees(store, project_id, dataDir, execution, workspace);
    const { assignment } = context(store, project_id, id);
    const diff = await binding.service.diffWorktree({
      project: binding.project,
      assignment,
    });
    const lines = [
      `${id}  ${diff.worktree_path}${diff.branch === undefined ? "" : `  分支 ${diff.branch}`}`,
      `HEAD ${diff.head_sha}${diff.reachable ? "（已在中心仓库里）" : "（不在中心仓库里）"}`,
      `已跟踪改动（${diff.tracked.length}）：${diff.tracked.length === 0 ? "无" : ""}`,
      ...diff.tracked.map((path) => `  ${path}`),
      `未跟踪文件（${diff.untracked.length}）：${diff.untracked.length === 0 ? "无" : ""}`,
      ...diff.untracked.map((path) => `  ${path}`),
      "",
      diff.patch.trim().length === 0
        ? "（没有 git diff HEAD 内容）"
        : diff.patch,
    ];
    io.stdout(lines.join("\n"));
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function cleanCommand(
  args: readonly string[],
  io: CliIo,
  option: "force_clean" | "keep",
): number {
  const parsed = parseArgs(args, ["force"]);
  const id = assignmentId(parsed.positionals[0]);
  if (option === "force_clean" && parsed.flags.force !== true)
    throw new CliError(
      `强制清理需要显式加 --force（先看 cardigan worktree diff ${id}）`,
      EXIT.usage,
      [USAGE],
    );
  const store = open(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const { assignment, decision } = context(store, project_id, id);
    if (decision === undefined)
      throw new CliError(
        `${id} 没有待处理的清理决策；清理决策由对账/清理循环在 worktree 有未提交改动时发起`,
        EXIT.usage,
      );
    if (decision.status === "resolved") {
      io.stdout(
        `${id} 的清理决策已经处理过：${decision.resolution?.option ?? decision.status}`,
      );
      return EXIT.ok;
    }
    runCommand(store, {
      operation: option === "keep" ? "保留工作区" : "清理工作区",
      target: id,
      project_id,
      actor: resolveActor(io, project_id, store),
      reduce: (state, actor, ports) =>
        recordDecision(
          state,
          actor,
          {
            decision_id: decision.id,
            option,
            rationale: `${option} ${assignment.id}`,
            raw_quote:
              optional(parsed.flags, "quote") ??
              `cardigan worktree ${option === "keep" ? "keep" : "clean --force"} ${id}`,
          },
          ports,
        ),
      clock: systemClock,
    });
    io.stdout(
      option === "keep"
        ? `已决定保留 ${id} 的 worktree（${decision.id}），之后不再询问`
        : `已确认强制清理 ${id}（${decision.id}）：清理循环会先备份补丁和提交，再删除 worktree`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}
