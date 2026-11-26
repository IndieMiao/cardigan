import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  highRiskPaths,
  type ProjectId,
  projectFlowVersion,
  validBranchName,
} from "@cardigan/domain";
import {
  CASE_WORKFLOW_STEPS,
  compareGithubStepContract,
  enrolledUpgradeIdentity,
  GITHUB_CHECK_NAMES,
  GITHUB_WORKFLOW_STEPS,
  type GithubStepContract,
  githubCheckRunName,
  githubStepShape,
  loadRunCapacityConfig,
  loadRuntimeWorkers,
  type MergeGateExecutor,
  type RuntimeWorker,
  readWorktreePreparation,
  runtimeTargetBinding,
  runtimeWorkersPath,
} from "@cardigan/host";
import { DEFAULT_DB_FILE, listRoleVersions, Store } from "@cardigan/store";
import { parse as parseYaml } from "yaml";
import { loadOptionalConfigSync } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import {
  announceDataDir,
  loadProjectMergeGate,
  resolveProject,
} from "./host.js";
import type { CliIo } from "./io.js";
import { cliLaunchPaths } from "./paths.js";
import { GATE_PREFERENCES } from "./project-copy.js";

/**
 * C-794: `cardigan project doctor` — read-only walk over the onboarding
 * checklist (docs/project-onboarding.md) for one project. It reads the store
 * and the host's private YAML files, never credentials, the network or a
 * worker; steps it cannot observe are reported for a person to confirm.
 */

export type DoctorStatus = "ok" | "missing" | "warn" | "manual" | "skip";
export interface DoctorItem {
  /** Checklist step number, e.g. `7` or `16 mac-mini`. */
  readonly step: string;
  readonly title: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly fix?: string;
  /** The running server only picks the change up after a restart. */
  readonly restart?: true;
}

const USAGE =
  "用法：cardigan project doctor [--project <p>] [--data-dir <目录>]";
const MARK: Record<DoctorStatus, string> = {
  ok: "✓",
  missing: "✗",
  warn: "!",
  manual: "?",
  skip: "-",
};
const CHECK_INPUTS = ["sha", "tree", "card", "delivery", "attempt", "kind"];
const SCOPE_INPUTS = ["merge_tier", "scope", "affected_paths", "skip_checks"];

export async function runProjectDoctor(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i]?.startsWith("--") ? args[i]?.slice(2) : undefined;
    const value = args[i + 1];
    if (
      name === undefined ||
      !["project", "data-dir"].includes(name) ||
      flags[name] !== undefined ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new CliError(`不认识的参数：${args[i]}`, EXIT.usage, [USAGE]);
    flags[name] = value;
    i++;
  }
  const dataDir = announceDataDir(io, flags["data-dir"]);
  // Read-only: never create a database or apply migrations to a live one.
  if (!existsSync(join(dataDir, DEFAULT_DB_FILE)))
    throw new CliError(`数据目录里没有数据库：${dataDir}`, EXIT.usage);
  const store = Store.open({ dataDir, migrate: false });
  try {
    const project = resolveProject(store, io, flags.project);
    const items = await projectDoctor({
      store,
      project,
      io,
      dataDir,
      now: new Date().toISOString(),
    });
    const code = store.getProject(project)?.code;
    io.stdout(formatDoctor(project, code ?? null, items));
    return items.some((item) => item.status === "missing")
      ? EXIT.failure
      : EXIT.ok;
  } finally {
    store.close();
  }
}

export function formatDoctor(
  project: string,
  code: string | null,
  items: readonly DoctorItem[],
): string {
  const count = (status: DoctorStatus) =>
    items.filter((item) => item.status === status).length;
  return [
    `项目 ${project}${code ? `（${code}）` : ""} 接入检查：`,
    ...items.flatMap((item) => [
      `${MARK[item.status]} ${item.step} ${item.title}：${item.detail}`,
      ...(item.fix && !["ok", "skip"].includes(item.status)
        ? [`    → ${item.fix}${item.restart ? "（改后重启 server）" : ""}`]
        : []),
    ]),
    `缺 ${count("missing")} 项，提醒 ${count("warn")} 项，需人工核对 ${count("manual")} 项`,
  ].join("\n");
}

export interface DoctorInput {
  readonly store: Store;
  readonly project: ProjectId;
  readonly io: CliIo;
  readonly dataDir: string;
  readonly now: string;
}

export async function projectDoctor(input: DoctorInput): Promise<DoctorItem[]> {
  const { store, project, io } = input;
  const record = store.getProject(project);
  const snapshot = store.uow.read((tx) => {
    const roles = [
      ...new Map(
        listRoleVersions(tx, project).map((role) => [role.role_id, role]),
      ).values(),
    ].filter((role) => role.status !== "inactive");
    return {
      roles,
      preferences: tx.project_preferences.get(project, project) ?? {
        id: project,
        auto_merge_after_minutes: null,
      },
      employees: tx.employees
        .list()
        .filter(
          (e) =>
            e.status === "active" &&
            (!e.projects?.length || e.projects.includes(project)),
        ),
      cards: tx.cards.list(project),
      standing: tx.assignments
        .list(project)
        .filter(
          (a) =>
            a.scope === "standing" &&
            ["active", "suspended"].includes(a.status),
        ),
      machines: tx.machines.list(project).filter((m) => m.id !== "local"),
    };
  });
  const items: DoctorItem[] = [];
  const repo = record?.repo_path ?? null;
  const base = record?.base_branch ?? "main";

  // 1–3: the project row and its source checkout.
  if (repo === null)
    items.push({
      step: "1",
      title: "仓库克隆到主机",
      status: "missing",
      detail: "还没有登记仓库，无法核对",
      fix: "先在主机上 git clone，再做第 3 步",
    });
  else {
    const present = existsSync(repo) && statSync(repo).isDirectory();
    const branch =
      present &&
      validBranchName(base) &&
      (await git(io, repo, ["rev-parse", "--verify", `refs/heads/${base}`]));
    items.push({
      step: "1",
      title: "仓库克隆到主机",
      status: branch ? "ok" : "missing",
      detail: !present
        ? `${repo} 不存在`
        : branch
          ? `${repo}（${base}）`
          : `${repo} 没有基线分支 ${base}`,
      fix: "在主机上 git clone 并检出基线分支",
    });
  }
  items.push({
    step: "2",
    title: "建项目并登记代号",
    status: record?.code ? "ok" : "missing",
    detail: record?.code ? `代号 ${record.code}` : "没有代号",
    fix: `cardigan project code --set <代号> --project ${project}`,
  });
  items.push({
    step: "3",
    title: "登记仓库和基线",
    status: repo === null ? "missing" : "ok",
    detail: repo === null ? "未登记" : `${repo}，基线 ${base}`,
    fix: `cardigan project set-repo --path <本地仓库> --base-branch <基线> --project ${project}（改基线后重启 server）`,
  });

  // 4–6: roles, employees and preferences (live, no restart).
  const roleIds = new Set(snapshot.roles.map((role) => role.role_id));
  const missingRoles = ["pm", "host_ops"].filter((id) => !roleIds.has(id));
  const pm = snapshot.roles.find((role) => role.role_id === "pm");
  const roleProblems = [
    ...(missingRoles.length ? [`缺 ${missingRoles.join("、")}`] : []),
    ...(pm && !pm.allowed_tools.includes("record_decision")
      ? ["pm 没有 record_decision，pm create --ops 会失败"]
      : []),
    ...(snapshot.roles.some((role) => role.kind === "produce")
      ? []
      : ["没有产出角色"]),
    ...(snapshot.roles.some((role) => role.kind === "verify")
      ? []
      : ["没有审核角色"]),
  ];
  let profiles: ReadonlySet<string> | undefined;
  try {
    // launch.yaml only: unlike `role copy`, never open secrets.env.
    const config = loadOptionalConfigSync(cliLaunchPaths(io, input.dataDir));
    profiles = config ? new Set(Object.keys(config.profiles)) : undefined;
  } catch {
    profiles = undefined;
  }
  const unknownProfiles = profiles
    ? snapshot.roles
        .filter((role) => !profiles?.has(role.launch_profile_ref))
        .map((role) => `${role.role_id}→${role.launch_profile_ref}`)
    : [];
  items.push({
    step: "4",
    title: "角色",
    status: roleProblems.length || unknownProfiles.length ? "missing" : "ok",
    detail: [
      `${snapshot.roles.length} 个启用角色`,
      ...roleProblems,
      ...(unknownProfiles.length
        ? [`launch.yaml 没有这些启动配置：${unknownProfiles.join("、")}`]
        : []),
      ...(profiles ? [] : ["读不了 launch.yaml，未核对启动配置"]),
    ].join("；"),
    fix: `cardigan project copy-setup --from <现有项目> --project ${project}`,
  });
  const staffed = new Set(snapshot.employees.map((e) => e.role_id));
  const unstaffedStanding = ["pm", "host_ops"].filter(
    (id) => roleIds.has(id) && !staffed.has(id),
  );
  const unstaffed = snapshot.roles
    .map((role) => role.role_id)
    .filter((id) => !staffed.has(id) && !unstaffedStanding.includes(id));
  items.push({
    step: "5",
    title: "员工",
    status: unstaffedStanding.length
      ? "missing"
      : unstaffed.length
        ? "warn"
        : "ok",
    detail: [
      `${snapshot.employees.length} 名在职员工服务本项目`,
      ...(unstaffedStanding.length
        ? [`常驻角色没有员工：${unstaffedStanding.join("、")}`]
        : []),
      ...(unstaffed.length ? [`没有员工的角色：${unstaffed.join("、")}`] : []),
    ].join("；"),
    fix: `员工是全局的：cardigan employee update <E-n> --projects <原项目>,${project}（整表替换），或 employee add`,
  });
  const preferences = snapshot.preferences;
  const defaults = [
    ...(preferences.flow_version === undefined
      ? ["flow-version（默认 1）"]
      : []),
    ...(preferences.high_risk_paths === undefined
      ? ["high-risk-paths（默认是 Cardigan 仓库的路径）"]
      : []),
    ...(preferences.auto_security_paths === undefined
      ? ["auto-security-paths（默认是 Cardigan 仓库的路径）"]
      : []),
  ];
  // Never copied from another project; the human sets the ones they want.
  const unsetGates = Object.entries(GATE_PREFERENCES)
    .filter(
      ([key]) =>
        (preferences[key as keyof typeof preferences] ?? null) === null,
    )
    .map(([, name]) => name);
  items.push({
    step: "6",
    title: "项目偏好",
    status: defaults.length ? "warn" : "ok",
    detail: [
      `流程版本 ${projectFlowVersion(preferences)}，自动合并 ${preferences.auto_merge ?? "off"}，高危路径 ${highRiskPaths(preferences).length} 条`,
      ...(defaults.length ? [`仍是默认值：${defaults.join("、")}`] : []),
      ...(unsetGates.length
        ? [`授权和门禁类（复制不带，由人设置）未设：${unsetGates.join("、")}`]
        : []),
    ].join("；"),
    fix: `其余偏好用 cardigan project copy-setup --from <现有项目> --project ${project} 复制；流程版本和路径类由人按新仓库设置（cardigan preference set …）`,
  });

  // 7–9: merge gate, GitHub and the baseline workflow.
  let gate: Awaited<ReturnType<typeof loadProjectMergeGate>> | undefined;
  let gateError: string | undefined;
  try {
    gate = await loadProjectMergeGate(store, project, io, input.dataDir);
  } catch (error) {
    gateError = error instanceof Error ? error.message : String(error);
  }
  const executor =
    gate?.status === "enabled" ? gate.executor : (undefined as undefined);
  items.push({
    step: "7",
    title: "merge-gate.yaml 项目段和执行器",
    status: gate?.status === "enabled" ? "ok" : "missing",
    detail:
      gate === undefined
        ? `读不了：${gateError}`
        : gate.status === "disabled"
          ? "没有本项目段，合并检查未启用"
          : gate.status === "invalid"
            ? `配置无效：${gate.reason}`
            : `执行器 ${describeExecutor(executor)}，检查 ${gate.checks.map((c) => c.name).join("/")}${executor?.type === "github" && !gate.push?.length ? "；没有推送路线，GitHub 上的基线不会自动同步" : ""}`,
    fix: "在 merge-gate.yaml 加 projects 段和本项目专用的执行器（一个执行器只服务一个项目）；项目须在 server 启动前已建好",
    restart: true,
  });
  if (executor?.type === "github") {
    items.push({
      step: "8",
      title: "GitHub App 和部署密钥",
      status: "manual",
      detail: `确认 App 已装到 ${executor.repo}、部署密钥可推送基线（不读凭据、不联网，无法核对）`,
      fix: "所有者在 GitHub 仓库设置里操作",
    });
    const repository = existsSync(
      join(input.dataDir, "central", `${project}.git`),
    )
      ? join(input.dataDir, "central", `${project}.git`)
      : repo;
    const baselines = [
      ...new Set([
        base,
        ...snapshot.cards
          .filter((card) => !["done", "cancelled"].includes(card.status))
          .flatMap((card) => (card.base_branch ? [card.base_branch] : [])),
      ]),
    ];
    const problems: string[] = [];
    for (const branch of baselines) {
      // Card baselines come from Agents: never let one reach git as an
      // option. Only plain branch names, read as a blob below refs/heads.
      if (!validBranchName(branch)) {
        problems.push(
          `卡片基线 ${JSON.stringify(branch)} 不是合法的分支名，未核对`,
        );
        continue;
      }
      const text =
        repository === null
          ? false
          : await git(io, repository, [
              "cat-file",
              "blob",
              `refs/heads/${branch}:${executor.workflow}`,
            ]);
      if (text === false) {
        problems.push(`${branch}：没有 ${executor.workflow}`);
        continue;
      }
      for (const problem of checkWorkflowSource(text, {
        branch,
        scopedChecks: executor.scopedChecks === true,
        ...(executor.stepContract ? { contract: executor.stepContract } : {}),
      }))
        problems.push(`${branch}：${problem}`);
    }
    items.push({
      step: "9",
      title: "基线上的检查工作流",
      status: problems.length ? "missing" : "ok",
      detail: problems.length
        ? problems.join("；")
        : `${baselines.join("、")} 的 ${executor.workflow} 与步骤合同一致`,
      fix: "按 docs/templates/cardigan-check.yml 在每条基线加工作流，并把同目录 merge-gate-github-executor.yaml 里的 step_contract 写进执行器",
      restart: true,
    });
  } else
    for (const [step, title] of [
      ["8", "GitHub App 和部署密钥"],
      ["9", "基线上的检查工作流"],
    ] as const)
      items.push({
        step,
        title,
        status: "skip",
        detail: executor
          ? "检查在 SSH 执行器上跑，不需要"
          : "未用 GitHub 执行器，不需要",
      });

  // 10–11: standing roles and the first instruction.
  // A launched session; idle between bells still counts as started.
  const started = new Set(["provisioning", "idle", "running"]);
  const standing = [
    ["PM Office", "pm", "office", "pm create --office", "pm start"],
    ["PM Ops", "pm", "ops", "pm create --ops", "pm start"],
    ["主机运维", "host_ops", undefined, "host-ops create", "host-ops start"],
  ] as const;
  const absent: string[] = [];
  const idle: string[] = [];
  const fixes = new Set<string>();
  for (const [label, role, mode, create, start] of standing) {
    const found = snapshot.standing.filter(
      (a) =>
        a.role_id === role &&
        (mode === undefined || a.standing_mode === mode) &&
        (role !== "host_ops" || a.status === "active"),
    );
    if (!found.length) {
      absent.push(label);
      fixes.add(`cardigan ${create} --project ${project}`);
    } else if (!found.some((a) => started.has(a.runtime_state))) {
      idle.push(label);
      fixes.add(`cardigan ${start} --project ${project}`);
    }
  }
  items.push({
    step: "10",
    title: "常驻 PM Office、PM Ops、主机运维",
    status: absent.length ? "missing" : idle.length ? "warn" : "ok",
    detail: absent.length
      ? `未建：${absent.join("、")}${idle.length ? `；未启动：${idle.join("、")}` : ""}`
      : idle.length
        ? `未启动：${idle.join("、")}`
        : "都已建好并在运行",
    fix: [...fixes].join("；"),
  });
  items.push({
    step: "11",
    title: "给常驻 PM 发开工指令",
    status: "manual",
    detail: snapshot.cards.length
      ? `项目有 ${snapshot.cards.length} 张卡；开工评论无法自动判断`
      : "项目还没有卡，评论只能发在卡上",
    fix: "建一张需求卡，在卡上用评论点名 PM",
  });

  // 12–19: remote machines and the host's private YAML files.
  const configRoot = dirname(runtimeWorkersPath(io.env as NodeJS.ProcessEnv));
  let workers: readonly RuntimeWorker[] | undefined;
  let workersError: string | undefined;
  try {
    workers = loadRuntimeWorkers(
      input.dataDir,
      runtimeWorkersPath(io.env as NodeJS.ProcessEnv),
    ).filter((worker) => worker.project_id === project);
  } catch (error) {
    workersError = error instanceof Error ? error.message : String(error);
  }
  const preparation = readWorktreePreparation(
    io.env as NodeJS.ProcessEnv,
    input.now,
  );
  const capacity = await loadRunCapacityConfig({ env: io.env });
  if (!snapshot.machines.length)
    items.push({
      step: "12-18",
      title: "远程机器",
      status: "skip",
      detail: "项目只用本机（local）；加机器后再跑一次",
    });
  for (const machine of snapshot.machines) {
    const worker = workers?.find((w) => w.machine_id === machine.id);
    const online = ["online", "degraded"].includes(machine.status);
    items.push({
      step: `12-15 ${machine.id}`,
      title: "接入向导、上线、开启远程派发",
      status: online && worker?.allow_remote_launch === true ? "ok" : "missing",
      detail: [
        `登记状态 ${machine.status}`,
        workers === undefined
          ? `读不了 runtime-workers.yaml：${workersError}`
          : !worker
            ? "runtime-workers.yaml 没有本项目绑定"
            : worker.allow_remote_launch === true
              ? "已开启远程派发"
              : "未开启远程派发",
      ].join("；"),
      fix: online
        ? "在 Workbench 机器向导最后一步开启远程派发（CLI 接入则手改 allow_remote_launch）"
        : `cardigan machine update ${machine.id} --project ${project} --status online`,
    });
    if (!worker) continue;
    const execution = worker.execution;
    const incomplete = [
      ...(execution.path ? [] : ["path"]),
      ...(execution.gitHelper ? [] : ["git_helper"]),
      ...(execution.fileHelper ? [] : ["file_helper"]),
      ...(execution.publication ? [] : ["publication"]),
      ...(execution.mcp ? [] : ["mcp_url"]),
    ];
    const fingerprint = runtimeTargetBinding(worker).fingerprint;
    items.push({
      step: `16 ${machine.id}`,
      title: "runtime-workers.yaml 绑定",
      status: incomplete.length ? "missing" : "ok",
      detail: incomplete.length
        ? `缺 ${incomplete.join("、")}`
        : `指纹 ${fingerprint.slice(0, 12)}`,
      fix: "补齐绑定后运行 cardigan worker apply-config 或 machine check",
    });
    const proof = preparation(worker);
    items.push({
      step: `17 ${machine.id}`,
      title: "worktree-preparation.yaml 准备证据",
      status: proof === "verified" ? "ok" : "missing",
      detail: {
        verified: "有效",
        expired: "已过期",
        invalid: `与当前绑定不符（当前指纹 ${fingerprint.slice(0, 12)}；改过 path/env 后要重新登记）`,
        missing: "没有登记，自动选机不会选这台",
      }[proof],
      fix: `指定 --machine ${machine.id} 跑通一张小卡后，按其 Run 的目标指纹登记 ${project}/${machine.id}`,
    });
    let enrolled: string | undefined;
    let conflict = false;
    try {
      enrolled = enrolledUpgradeIdentity(configRoot, project, machine.id);
    } catch {
      conflict = true;
    }
    items.push({
      step: `18 ${machine.id}`,
      title: "helper 自动升级登记",
      status: conflict ? "missing" : enrolled ? "ok" : "warn",
      detail: conflict
        ? "新旧两份登记同时存在"
        : enrolled
          ? enrolled.endsWith(".bound")
            ? "已登记（按项目）"
            : "已登记（共用账号）"
          : "未登记，helper 只能手动升级",
      fix: `sh deploy/enroll-helper-controller.sh prepare ${project} ${machine.id} --project-config，再以 activate 运行一次，设备上运行 enroll-helper-worker.sh`,
    });
  }
  const quotas = ["local", ...snapshot.machines.map((m) => m.id)].flatMap(
    (machine) => {
      const quota = capacity.projectQuota(machine, project);
      return quota ? [`${machine} ${quota.limit ?? "—"}`] : [];
    },
  );
  items.push({
    step: "19",
    title: "run-capacity.yaml 项目上限和资源名额",
    status: capacity.errors.length ? "missing" : quotas.length ? "ok" : "skip",
    detail: capacity.errors.length
      ? `文件无效，重启后所有机器停止自动派发：${capacity.errors.join("；")}`
      : quotas.length
        ? `项目上限：${quotas.join("、")}`
        : "未设（可选），共用机器名额",
    fix: "修正 run-capacity.yaml",
    restart: true,
  });
  return items;
}

function describeExecutor(executor: MergeGateExecutor | undefined): string {
  if (!executor) return "local（本机）";
  return executor.type === "github"
    ? `${executor.name}（GitHub ${executor.repo}，${executor.stepContract ? "已配步骤合同" : "未配步骤合同"}）`
    : `${executor.name}（SSH）`;
}

/** `git -C <dir> …` stdout, or false when git failed. */
async function git(
  io: CliIo,
  dir: string,
  args: readonly string[],
): Promise<string | false> {
  const env = Object.fromEntries(
    Object.entries(io.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  try {
    const result = await io.captureCommand("git", ["-C", dir, ...args], {
      cwd: io.cwd,
      env,
      timeoutMs: 15_000,
    });
    return result.code === 0 ? result.stdout : false;
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Problems of a baseline's check workflow against what the host requires:
 * the run name, dispatch inputs, a single `check` job, the six check steps,
 * and the executor's step contract (Cardigan's own shape when absent). Only
 * main steps are compared: post steps depend on the actions used.
 */
export function checkWorkflowSource(
  text: string,
  options: {
    readonly branch: string;
    readonly scopedChecks?: boolean;
    readonly contract?: GithubStepContract;
  },
): string[] {
  let workflow: unknown;
  try {
    workflow = parseYaml(text);
  } catch {
    return ["不是合法的 YAML"];
  }
  if (!record(workflow)) return ["不是合法的工作流"];
  const problems: string[] = [];
  const sample = Object.fromEntries(CHECK_INPUTS.map((k) => [k, `<${k}>`]));
  const runName =
    typeof workflow["run-name"] === "string"
      ? workflow["run-name"].replace(
          /\$\{\{\s*(?:github\.event\.)?inputs\.(\w+)\s*\}\}/gu,
          (_match, key: string) => sample[key] ?? `<?${key}>`,
        )
      : undefined;
  if (runName !== githubCheckRunName(sample))
    problems.push(
      "run-name 须为 cardigan/<card>/<delivery>/<attempt>/<kind>/<sha>/<tree>",
    );
  const on = workflow.on ?? workflow.true;
  const dispatch = record(on) ? on.workflow_dispatch : undefined;
  const inputs =
    record(dispatch) && record(dispatch.inputs) ? dispatch.inputs : {};
  const absentInputs = [
    ...CHECK_INPUTS,
    ...(options.scopedChecks ? SCOPE_INPUTS : []),
  ].filter((key) => !Object.hasOwn(inputs, key));
  if (!record(dispatch)) problems.push("没有 workflow_dispatch 触发");
  else if (absentInputs.length)
    problems.push(`缺输入 ${absentInputs.join("、")}`);
  const jobs = record(workflow.jobs) ? Object.keys(workflow.jobs) : [];
  const job =
    jobs.length === 1 && jobs[0] === "check" && record(workflow.jobs)
      ? workflow.jobs.check
      : undefined;
  if (!record(job)) return [...problems, "须只有一个名为 check 的 job"];
  const steps = Array.isArray(job.steps) ? job.steps.filter(record) : [];
  const names = steps.map((step) =>
    typeof step.name === "string"
      ? step.name
      : typeof step.uses === "string"
        ? `Run ${step.uses}`
        : `Run ${String(step.run ?? "")
            .split("\n")[0]
            ?.trim()}`,
  );
  const absentChecks = GITHUB_CHECK_NAMES.filter(
    (name) => names.filter((n) => n === name).length !== 1,
  );
  if (absentChecks.length)
    problems.push(`检查步骤 ${absentChecks.join("、")} 须各出现一次`);
  if (options.contract) {
    const shape = githubStepShape(options.contract, options.branch);
    const actual = [
      ...(job.services === undefined ? [] : ["Initialize containers"]),
      ...names,
    ];
    const result = compareGithubStepContract(actual, {
      steps: shape.steps,
      postSteps: [],
    });
    if (!result.ok)
      problems.push(
        `与执行器步骤合同不符：第 ${result.index + 1} 步应为 ${result.expected}，实际 ${result.actual ?? "没有"}`,
      );
  } else {
    const own = [
      [...GITHUB_WORKFLOW_STEPS],
      CASE_WORKFLOW_STEPS,
      CASE_WORKFLOW_STEPS.filter((name) => name !== "Recovered agent_git"),
    ];
    if (!own.some((shape) => shape.join("\n") === names.join("\n")))
      problems.push(
        "执行器没配 step_contract 时，步骤须与 Cardigan 自己的工作流完全一致；用模板时把模板附带的 step_contract 写进执行器",
      );
  }
  return problems;
}
