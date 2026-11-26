import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectPreferences } from "@cardigan/domain";
import { loadMergeGateConfig } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { listRoleVersions, Store } from "@cardigan/store";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { roleConfig } from "../../../test-support/launch-fixture.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { comparablePreferences, GATE_PREFERENCES } from "./project-copy.js";
import { checkWorkflowSource } from "./project-doctor.js";

const root = new URL("../../../", import.meta.url);
const template = readFileSync(
  new URL("docs/templates/cardigan-check.yml", root),
  "utf8",
);
const executorSnippet = readFileSync(
  new URL("docs/templates/merge-gate-github-executor.yaml", root),
  "utf8",
);
const ownWorkflow = readFileSync(
  new URL(".github/workflows/cardigan-check.yml", root),
  "utf8",
);

let dataDir: string;
let out: string[];
let err: string[];
let io: CliIo;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-cli-doctor-"));
  out = [];
  err = [];
  io = {
    env: {
      CARDIGAN_CONFIG_DIR: roleConfig(dataDir, "codex-agent", "claude-opus"),
      CARDIGAN_DATA_DIR: dataDir,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
    cwd: dataDir,
    platform: "linux",
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("project commands must not spawn");
    },
    // Real git for the repository checks; nothing else is spawned.
    captureCommand: async (command, args) => {
      if (command !== "git") throw new Error(`unexpected ${command}`);
      const result = spawnSync(command, args, { encoding: "utf8" });
      return {
        code: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<number> {
  out = [];
  return main(argv, io);
}

function gitRepo(dir: string, files: Record<string, string>): void {
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  mkdirSync(dir, { recursive: true });
  git("init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-q",
    "-m",
    "init",
  );
}

/** A fully onboarded source project, the way an existing project looks. */
async function sourceProject(): Promise<void> {
  const steps: string[][] = [
    ["project", "create", "alpha", "--code", "ALP"],
    [
      "role",
      "add",
      "alpha",
      "pm",
      "--allowed-tools",
      "record_decision,post_comment,get_card,whoami,finish_run",
    ],
    ["role", "add", "alpha", "coder", "--allowed-tools", "submit_delivery"],
    ["role", "add", "alpha", "reviewer", "--allowed-tools", "submit_review"],
    ["role", "add", "alpha", "host_ops", "--allowed-tools", "post_comment"],
    [
      "role",
      "copy",
      "independent_reviewer",
      "independent_reviewer",
      "--from-default",
      "--project",
      "alpha",
    ],
    ["role", "deactivate", "independent_reviewer", "--project", "alpha"],
    [
      "preference",
      "set",
      "system-merge-shadow-policy",
      '{"role_rule_paths":["roles/**"],"release_paths":[]}',
      "--project",
      "alpha",
    ],
    ["preference", "set", "flow-version", "5", "--project", "alpha"],
    ["preference", "set", "auto-merge", "on", "--project", "alpha"],
    [
      "preference",
      "set",
      "high-risk-paths",
      '["src/auth/**"]',
      "--project",
      "alpha",
    ],
    [
      "preference",
      "set",
      "auto-security-paths",
      '[".github/**","deploy/**"]',
      "--project",
      "alpha",
    ],
    [
      "preference",
      "set",
      "decision-delegation",
      "spending",
      "on",
      "--project",
      "alpha",
    ],
    [
      "preference",
      "set",
      "human-card-templates",
      "dev",
      "on",
      "--project",
      "alpha",
    ],
    ["preference", "set", "review-max-rounds", "6", "--project", "alpha"],
    [
      "employee",
      "add",
      "--name",
      "张良",
      "--title",
      "PM",
      "--role",
      "pm",
      "--avatar",
      "library:zhang-liang",
    ],
    [
      "employee",
      "add",
      "--name",
      "关羽",
      "--title",
      "运维",
      "--role",
      "host_ops",
      "--avatar",
      "library:guan-yu",
    ],
    ["employee", "add", "--name", "赵云", "--title", "开发", "--role", "coder"],
    [
      "employee",
      "add",
      "--name",
      "诸葛亮",
      "--title",
      "审核",
      "--role",
      "reviewer",
    ],
  ];
  for (const argv of steps) {
    const code = await run(argv);
    expect(code, `${argv.join(" ")}\n${err.join("\n")}`).toBe(0);
  }
}

function snapshot(project: string) {
  const store = Store.open({ dataDir });
  try {
    return store.uow.read((tx) => ({
      roles: [
        ...new Map(
          listRoleVersions(tx, project).map((r) => [r.role_id, r]),
        ).values(),
      ],
      preferences: projectPreferences(loadCommandState(tx, project)),
    }));
  } finally {
    store.close();
  }
}

describe("project copy-setup", () => {
  test("create --from copies every active role and the preferences", async () => {
    await sourceProject();
    const before = snapshot("alpha");
    expect(
      await run([
        "project",
        "create",
        "beta",
        "--code",
        "BET",
        "--from",
        "alpha",
      ]),
    ).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("已从项目 alpha 复制到 beta");
    // PM decision C-794#8: authorizations and gates stay at the defaults.
    expect(text).toContain(
      "授权和门禁类不复制，保持本项目原值，需要时由人设置：flow-version、decision-delegation、auto-merge、high-risk-paths、auto-security-paths、system-merge-shadow-policy",
    );
    const alpha = snapshot("alpha");
    const beta = snapshot("beta");
    const active = (roles: typeof alpha.roles) =>
      roles
        .filter((r) => r.status !== "inactive")
        .map((r) => ({
          id: r.role_id,
          tools: r.allowed_tools,
          kind: r.kind,
          profile: r.launch_profile_ref,
          instructions: r.instructions,
        }));
    // Same number of active roles, same definitions; the inactive one stays behind.
    expect(active(beta.roles)).toEqual(active(alpha.roles));
    expect(active(beta.roles)).toHaveLength(4);
    expect(beta.roles.map((r) => r.role_id)).not.toContain(
      "independent_reviewer",
    );
    expect(comparablePreferences(beta.preferences)).toBe(
      comparablePreferences(alpha.preferences),
    );
    expect(beta.preferences).toMatchObject({
      review_max_rounds: 6,
      human_card_templates: ["story", "dev"],
    });
    for (const gate of [
      "flow_version",
      "decision_delegation",
      "auto_merge",
      "high_risk_paths",
      "auto_security_paths",
      "system_merge_shadow_policy",
    ] as const)
      expect(beta.preferences[gate]).toBeUndefined();
    expect(alpha.preferences.auto_merge).toBe("on");
    // The source is only read.
    expect(alpha).toEqual(before);
  });

  test("no authorization or gate preference is ever copied", async () => {
    await sourceProject();
    // Every gate set to a non-default value, written directly.
    const gates = {
      flow_version: 5,
      decision_delegation: { spending: true, publish: true },
      auto_merge: "on",
      auto_merge_after_minutes: 30,
      auto_merge_paused: true,
      pm_merge_confirmation: false,
      pm_confirm_role_rule_implementations: false,
      pm_confirm_human_decided_merges: false,
      enable_reviewer_browser: true,
      independent_review_limit_delegation: true,
      independent_review_limit_delegation_max: 3,
      system_review_limit_raise: true,
      system_review_limit_max_raises: 2,
      high_risk_paths: ["src/**"],
      auto_security_paths: [".github/**", "src/**"],
      role_rule_paths: ["roles/**"],
      system_merge_shadow_policy: { role_rule_paths: [], release_paths: [] },
    } as const;
    expect(Object.keys(gates).sort()).toEqual(
      Object.keys(GATE_PREFERENCES).sort(),
    );
    const store = Store.open({ dataDir });
    try {
      store.uow.run((tx) =>
        tx.project_preferences.put("alpha", {
          ...snapshot("alpha").preferences,
          ...gates,
          tick_profile: true,
        }),
      );
    } finally {
      store.close();
    }
    expect(
      await run([
        "project",
        "create",
        "beta",
        "--code",
        "BET",
        "--from",
        "alpha",
      ]),
    ).toBe(0);
    const beta = snapshot("beta").preferences;
    // Absent, or null for auto_merge_after_minutes: the defaults.
    for (const key of Object.keys(gates))
      expect(beta[key as keyof typeof beta] ?? null, key).toBeNull();
    expect(beta.tick_profile).toBe(true);
    expect(out.join("\n")).toContain(
      `授权和门禁类不复制，保持本项目原值，需要时由人设置：${Object.values(GATE_PREFERENCES).join("、")}`,
    );
  });

  test("existing roles are kept and reported; a second copy changes nothing", async () => {
    await sourceProject();
    expect(await run(["project", "create", "beta", "--code", "BET"])).toBe(0);
    expect(
      await run([
        "role",
        "add",
        "beta",
        "coder",
        "--allowed-tools",
        "submit_delivery,post_comment",
      ]),
    ).toBe(0);
    expect(
      await run([
        "project",
        "copy-setup",
        "--from",
        "alpha",
        "--project",
        "beta",
      ]),
    ).toBe(0);
    expect(out.join("\n")).toContain("目标项目已有、未覆盖的角色：coder");
    const coder = snapshot("beta").roles.find((r) => r.role_id === "coder");
    expect(coder?.allowed_tools).toEqual(["submit_delivery", "post_comment"]);
    expect(
      await run([
        "project",
        "copy-setup",
        "--from",
        "alpha",
        "--project",
        "beta",
      ]),
    ).toBe(0);
    expect(out.join("\n")).toContain("角色 0 个：无");
  });

  test("a role whose launch profile is missing on this host copies nothing", async () => {
    await sourceProject();
    io = {
      ...io,
      env: {
        ...io.env,
        CARDIGAN_CONFIG_DIR: roleConfig(join(dataDir, "other"), "claude-opus"),
      },
    };
    expect(await run(["project", "create", "beta", "--code", "BET"])).toBe(0);
    expect(
      await run([
        "project",
        "copy-setup",
        "--from",
        "alpha",
        "--project",
        "beta",
      ]),
    ).toBe(2);
    expect(err.join("\n")).toContain("未复制任何内容");
    expect(snapshot("beta").roles).toEqual([]);
  });

  test("the source must exist and differ from the target", async () => {
    await sourceProject();
    expect(
      await run([
        "project",
        "copy-setup",
        "--from",
        "nope",
        "--project",
        "alpha",
      ]),
    ).toBe(2);
    expect(
      await run([
        "project",
        "copy-setup",
        "--from",
        "alpha",
        "--project",
        "alpha",
      ]),
    ).toBe(2);
  });

  test("Token mode cannot run either command", async () => {
    io = { ...io, env: { ...io.env, CARDIGAN_TOKEN: "x" } };
    expect(await run(["project", "doctor"])).toBe(2);
    expect(await run(["project", "copy-setup", "--from", "alpha"])).toBe(2);
    expect(err.join("\n")).toContain("仅限人类");
  });
});

describe("project doctor", () => {
  test("a bare project lists the missing onboarding steps", async () => {
    expect(await run(["project", "create", "beta", "--code", "BET"])).toBe(0);
    expect(await run(["project", "doctor", "--project", "beta"])).toBe(1);
    const text = out.join("\n");
    for (const line of [
      "✗ 1 仓库克隆到主机",
      "✓ 2 建项目并登记代号：代号 BET",
      "✗ 3 登记仓库和基线：未登记",
      "✗ 4 角色：0 个启用角色；缺 pm、host_ops",
      "! 6 项目偏好",
      "✗ 7 merge-gate.yaml 项目段和执行器：没有本项目段",
      "- 8 GitHub App 和部署密钥：未用 GitHub 执行器，不需要",
      "✗ 10 常驻 PM Office、PM Ops、主机运维：未建：PM Office、PM Ops、主机运维",
      "? 11 给常驻 PM 发开工指令：项目还没有卡",
      "- 12-18 远程机器：项目只用本机（local）",
      "- 19 run-capacity.yaml 项目上限和资源名额：未设（可选），共用机器名额",
    ])
      expect(text).toContain(line);
    expect(text).toContain("（改后重启 server）");
  });

  test("simulated onboarding of a new project from an existing one", async () => {
    await sourceProject();
    // Hand edits counted here: one merge-gate.yaml section, one workflow file.
    const repo = join(dataDir, "repos", "beta");
    gitRepo(repo, { ".github/workflows/cardigan-check.yml": template });
    const credentials = join(dataDir, "credentials");
    mkdirSync(credentials, { mode: 0o700 });
    for (const file of ["app.pem", "deploy-key", "known_hosts"]) {
      writeFileSync(join(credentials, file), "fixture", { mode: 0o600 });
      chmodSync(join(credentials, file), 0o600);
    }
    writeFileSync(
      join(io.env.CARDIGAN_CONFIG_DIR as string, "merge-gate.yaml"),
      executorSnippet
        .replaceAll("<project_id>", "beta")
        .replaceAll("<owner>/<repo>", "acme/beta")
        .replace("<GitHub App 编号>", "1")
        .replace("<安装编号>", "2")
        .replace("<App 私钥，相对数据目录的路径>", "credentials/app.pem")
        .replace("<App 名>[bot]", "beta-checks[bot]")
        .replace("<部署私钥，相对数据目录的路径>", "credentials/deploy-key")
        .replace(
          "<known_hosts，相对数据目录的路径>",
          "credentials/known_hosts",
        ),
      { mode: 0o600 },
    );
    const steps: string[][] = [
      ["project", "create", "beta", "--code", "BET", "--from", "alpha"],
      ["project", "set-repo", "--path", repo, "--project", "beta"],
      // Gates the copy leaves to the human.
      [
        "preference",
        "set",
        "system-merge-shadow-policy",
        '{"role_rule_paths":[],"release_paths":[]}',
        "--project",
        "beta",
      ],
      ["preference", "set", "flow-version", "5", "--project", "beta"],
      ["preference", "set", "auto-merge", "on", "--project", "beta"],
      [
        "preference",
        "set",
        "high-risk-paths",
        '["lib/**"]',
        "--project",
        "beta",
      ],
      [
        "preference",
        "set",
        "auto-security-paths",
        '[".github/**"]',
        "--project",
        "beta",
      ],
      ["pm", "create", "--office", "--project", "beta"],
      ["pm", "create", "--ops", "--project", "beta"],
      ["host-ops", "create", "--project", "beta"],
    ];
    for (const argv of steps) {
      const code = await run(argv);
      expect(code, `${argv.join(" ")}\n${err.join("\n")}`).toBe(0);
    }
    const code = await run(["project", "doctor", "--project", "beta"]);
    const text = out.join("\n");
    expect(code, text).toBe(0);
    for (const line of [
      `✓ 1 仓库克隆到主机：${repo}（main）`,
      "✓ 3 登记仓库和基线",
      "✓ 4 角色：4 个启用角色",
      "✓ 5 员工",
      "✓ 6 项目偏好：流程版本 5，自动合并 on，高危路径 1 条",
      "✓ 7 merge-gate.yaml 项目段和执行器：执行器 github-actions-beta（GitHub acme/beta，已配步骤合同）",
      "? 8 GitHub App 和部署密钥",
      "✓ 9 基线上的检查工作流：main 的 .github/workflows/cardigan-check.yml 与步骤合同一致",
      "! 10 常驻 PM Office、PM Ops、主机运维：未启动：PM Office、PM Ops、主机运维",
      "缺 0 项",
    ])
      expect(text).toContain(line);
  });

  test("a registered remote machine without a binding is reported", async () => {
    expect(await run(["project", "create", "beta", "--code", "BET"])).toBe(0);
    expect(
      await run([
        "machine",
        "register",
        "mini",
        "--label",
        "Mini",
        "--os",
        "darwin",
        "--arch",
        "arm64",
        "--status",
        "offline",
        "--project",
        "beta",
      ]),
    ).toBe(0);
    expect(await run(["project", "doctor", "--project", "beta"])).toBe(1);
    const text = out.join("\n");
    expect(text).toContain(
      "✗ 12-15 mini 接入向导、上线、开启远程派发：登记状态 offline；runtime-workers.yaml 没有本项目绑定",
    );
    expect(text).toContain(
      "cardigan machine update mini --project beta --status online",
    );
  });
});

describe("check workflow source", () => {
  test("the template matches its step contract", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "cardigan-doctor-gate-"));
    try {
      const credentials = join(dataDir, "keys");
      mkdirSync(credentials, { mode: 0o700 });
      writeFileSync(join(credentials, "app.pem"), "x", { mode: 0o600 });
      writeFileSync(
        join(configDir, "merge-gate.yaml"),
        executorSnippet
          .replaceAll("<project_id>", "p")
          .replaceAll("<owner>/<repo>", "acme/p")
          .replace("<GitHub App 编号>", "1")
          .replace("<安装编号>", "2")
          .replace("<App 私钥，相对数据目录的路径>", "keys/app.pem")
          .replace("<App 名>[bot]", "p[bot]")
          .replace(/ {4}push:\n(?: {6}.*\n)+/u, ""),
        { mode: 0o600 },
      );
      const gate = (
        await loadMergeGateConfig({ projectIds: ["p"], configDir, dataDir })
      ).forProject("p");
      expect(gate).toMatchObject({ status: "enabled" });
      const executor = gate.status === "enabled" ? gate.executor : undefined;
      if (executor?.type !== "github") throw new Error("github executor");
      expect(executor.stepContract).toBeDefined();
      expect(
        checkWorkflowSource(template, {
          branch: "main",
          scopedChecks: true,
          ...(executor.stepContract ? { contract: executor.stepContract } : {}),
        }),
      ).toEqual([]);
      // Without the contract the host expects Cardigan's own workflow.
      expect(checkWorkflowSource(template, { branch: "main" })).toHaveLength(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("Cardigan's own workflow passes without a contract", () => {
    expect(
      checkWorkflowSource(ownWorkflow, { branch: "main", scopedChecks: true }),
    ).toEqual([]);
  });

  test("broken workflows name what is wrong", () => {
    expect(
      checkWorkflowSource(
        template.replace("run-name: cardigan/", "run-name: x/"),
        {
          branch: "main",
        },
      )[0],
    ).toContain("run-name");
    expect(
      checkWorkflowSource(template.replace("      kind:\n", "      kinds:\n"), {
        branch: "main",
        contract: { steps: [], postSteps: [] },
      }),
    ).toContain("缺输入 kind");
    expect(
      checkWorkflowSource(template.replace("  check:\n", "  verify:\n"), {
        branch: "main",
      }),
    ).toContain("须只有一个名为 check 的 job");
    const renamed = checkWorkflowSource(
      template.replace("- name: lint\n", "- name: Lint\n"),
      {
        branch: "main",
        contract: {
          steps: [
            "Checkout candidate",
            "Verify candidate identity",
            "Setup Node",
            "install",
            "build",
            "test",
            "lint",
            "deps",
            "e2e",
          ].map((name) => ({ name })),
          postSteps: [],
        },
      },
    );
    expect(renamed).toContain("检查步骤 lint 须各出现一次");
    expect(renamed.join("\n")).toContain("第 7 步应为 lint，实际 Lint");
    expect(checkWorkflowSource("a: [", { branch: "main" })).toEqual([
      "不是合法的 YAML",
    ]);
  });
});
