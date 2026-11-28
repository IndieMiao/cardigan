import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  AGENT_PROTOCOL,
  type AssignmentRoleInput,
  type CompileAssignmentInput,
  type CompiledAssignmentLaunch,
  compileAssignmentLaunch,
  corePromptFor,
  type DefaultRoleId,
  defaultRoles,
  firstPrompt,
  type Harness,
  MCP_BRIDGE_SOURCE,
  mcpBridgeArgs,
  parseLaunchConfig,
  pathWithoutEmulator,
  START_FILE_NAME,
} from "./index.js";

/**
 * M2.4: compile "start this Assignment" for the three harnesses.
 *
 * The assignment's MCP token is a fixture value that only ever appears in the
 * run directory's `token` file at runtime; no generated file may contain it.
 */
const TOKEN = "fictional-assignment-token-never-written-to-a-file";
const RUN_DIR = "/srv/cardigan/runs/A-12";
const WORK_DIR = "/srv/agent/worktrees/A-12";
const REPOSITORY_ROOT = "/srv/agent/repos/p-demo";
const MCP_URL = "http://127.0.0.1:3004/mcp";

const launchConfig = parseLaunchConfig({
  providers: {
    gateway: {
      harness: "claude-code",
      env: { ANTHROPIC_BASE_URL: "https://gateway.example.invalid" },
      secret_env: { ANTHROPIC_AUTH_TOKEN: "CLAUDE_TOKEN" },
    },
    "codex-gateway": {
      harness: "codex",
      env: { OPENAI_BASE_URL: "https://codex.example.invalid/v1" },
      secret_env: { OPENAI_API_KEY: "CODEX_KEY" },
    },
    pi: { harness: "pi", secret_env: { DS_API_KEY: "PI_KEY" } },
  },
  profiles: {
    "claude-agent": {
      harness: "claude-code",
      provider: "gateway",
      model: "opus",
    },
    "codex-agent": {
      harness: "codex",
      provider: "codex-gateway",
      model: "gpt-6-astra",
    },
    "pi-agent": {
      harness: "pi",
      provider: "pi",
      provider_flag: "deepseek",
      model: "deepseek-flash",
    },
  },
});

const secrets = {
  CLAUDE_TOKEN: "fictional-claude-credential",
  CODEX_KEY: "fictional-codex-credential",
  PI_KEY: "fictional-pi-credential",
};

const TOOLS = [
  "whoami",
  "get_card",
  "get_updates",
  "ack_events",
  "submit_delivery",
];

function roleFor(
  harness: Harness,
  profile: string,
  roleId: DefaultRoleId = "coder",
): AssignmentRoleInput {
  return {
    role_id: roleId,
    harness,
    launch_profile: profile,
    worktree:
      roleId === "pm" ? "none" : roleId === "coder" ? "write" : "readonly",
    allowed_tools: TOOLS,
    core_prompt: corePromptFor(roleId),
  };
}

function compile(
  harness: Harness,
  profile: string,
  first: string,
  roleId: DefaultRoleId = "coder",
  employee?: CompileAssignmentInput["employee"],
  agentNice?: number,
): CompiledAssignmentLaunch {
  return compileAssignmentLaunch({
    ...(agentNice === undefined ? {} : { agent_nice: agentNice }),
    assignment: {
      assignment_id: "A-12",
      run_id: "R-5",
      card_id: "C-3",
      work_item_id: "W-7",
      project_id: "p-demo",
    },
    ...(employee === undefined ? {} : { employee }),
    role: roleFor(harness, profile, roleId),
    launch: launchConfig,
    mcp: { url: MCP_URL },
    run_dir: RUN_DIR,
    work_dir: WORK_DIR,
    work_dir_real: WORK_DIR,
    repository_root: REPOSITORY_ROOT,
    first_prompt: first,
    secrets,
  });
}

/** Every byte the host would write, plus the argv and env the CLI receives. */
function surface(compiled: CompiledAssignmentLaunch): string {
  return [
    compiled.command,
    ...compiled.args,
    ...Object.entries(compiled.env).map(([k, v]) => `${k}=${v}`),
    ...compiled.files.map((file) => `${file.path}\n${file.content}`),
  ].join("\n");
}

test.each([
  ["claude-code", "claude-agent"],
  ["codex", "codex-agent"],
  ["pi", "pi-agent"],
] as const)(
  "Flow Lite %s launch preserves delegation, review policy and acceptance ownership",
  (harness, profile) => {
    const pm = surface(compile(harness, profile, "Start", "pm"));
    for (const phrase of [
      "工作项级 PM 只负责自己的完成验收",
      "流程版本 ≥2 的合并检查 failed/timed_out",
      "系统对全部在途卡",
      "未开启时由 PM Ops 确认",
      "同一验证项连续第 3 次驳回时暂停并交 PM 排查",
      "只有手改与默认包冲突才交人",
      "流程版本 ≥5 的就绪验证项始终由系统自动指派",
      "工程卡选 `dev@2`，产品卡选 `product@1`，界面卡默认选 `ui@1`",
      "人已开启授权的类别由 PM Ops 按授权处理并知会",
    ])
      expect(pm).toContain(phrase);
    const reviewer = surface(compile(harness, profile, "Start", "reviewer"));
    expect(reviewer).toContain("逐条对照卡片和工作项的验收标准");
    expect(reviewer).toContain("对应行为、证据和未覆盖项，不能只写通过");
  },
);

test.each([false, true])(
  "employee local-test marker and agent tools reach launch material (remote=%s)",
  (remote) => {
    const compiled = compileAssignmentLaunch({
      assignment: { assignment_id: "A-1", run_id: "R-1" },
      role: roleFor("codex", "codex-agent"),
      launch: launchConfig,
      mcp: { url: MCP_URL },
      run_dir: RUN_DIR,
      work_dir: WORK_DIR,
      first_prompt: "fixture",
      secrets,
      agent_local_tests: true,
      agent_tools_dir: "/opt/cardigan/deploy/agent-tools",
      ...(remote
        ? {
            worker_launch: {
              command: ["fixture-worker"],
              session_dir: "/fixture/session",
            },
          }
        : {}),
    });
    expect(compiled.env.CARDIGAN_AGENT_LOCAL_TESTS).toBe("1");
    const material =
      compiled.files.find((file) =>
        file.path.endsWith(remote ? "/launch.json" : "/launch.sh"),
      )?.content ?? "";
    if (remote)
      expect(JSON.parse(material).env).toMatchObject({
        CARDIGAN_AGENT_LOCAL_TESTS: "1",
        CARDIGAN_AGENT_TOOLS: "/opt/cardigan/deploy/agent-tools",
      });
    else {
      expect(material).toContain("export CARDIGAN_AGENT_LOCAL_TESTS='1'");
      expect(material).toContain(
        "export CARDIGAN_AGENT_TOOLS='/opt/cardigan/deploy/agent-tools'",
      );
    }
  },
);

test("a worker tool variable cannot shadow a provider setting or credential, including custom names", () => {
  const input = {
    assignment: { assignment_id: "A-1", run_id: "R-1" },
    role: roleFor("claude-code", "example"),
    launch: parseLaunchConfig({
      providers: {
        fixture: {
          harness: "claude-code",
          env: { PROFILE_OPTION: "configured" },
          secret_env: { SERVICE_LOGIN: "fixture" },
        },
      },
      profiles: { example: { harness: "claude-code", provider: "fixture" } },
    }),
    mcp: { url: MCP_URL },
    run_dir: RUN_DIR,
    work_dir: WORK_DIR,
    first_prompt: "fixture",
    secrets: { fixture: "fixture-only" },
  };
  for (const key of ["PROFILE_OPTION", "SERVICE_LOGIN"])
    expect(() =>
      compileAssignmentLaunch({ ...input, worker_env: { [key]: "conflict" } }),
    ).toThrow("Worker environment conflicts with launch profile");
});

test("all Agent harnesses default to nice 10 and accept only integers from 0 to 19", () => {
  for (const [harness, profile, binary] of [
    ["claude-code", "claude-agent", "claude"],
    ["codex", "codex-agent", "codex"],
    ["pi", "pi-agent", "pi"],
  ] as const) {
    for (const value of [undefined, 0, 19]) {
      const compiled = compile(
        harness,
        profile,
        "fixture",
        "coder",
        undefined,
        value,
      );
      expect(surface(compiled)).toContain(
        `exec nice -n ${value ?? 10} '${binary}'`,
      );
    }
    for (const value of [-1, 20, 0.5, Number.NaN])
      expect(() =>
        compile(harness, profile, "fixture", "coder", undefined, value),
      ).toThrow(/niceness/);
  }
});

test("C-656: local sessions with run resources start through the private TMPDIR and scope wrapper", () => {
  const launchFile = (compiled: CompiledAssignmentLaunch) =>
    compiled.files.find((file) => file.path === compiled.launch_script)
      ?.content ?? "";
  const plain = launchFile(compile("claude-code", "claude-agent", "fixture"));
  expect(plain).toContain("\nexec nice -n 10 'claude'");
  expect(plain).not.toContain(" session -- ");
  const compiled = compileAssignmentLaunch({
    assignment: { assignment_id: "A-12", run_id: "R-5", project_id: "p" },
    role: roleFor("claude-code", "claude-agent"),
    launch: launchConfig,
    mcp: { url: MCP_URL },
    run_dir: RUN_DIR,
    work_dir: WORK_DIR,
    first_prompt: "fixture",
    secrets,
    run_resources: { target: "a".repeat(64), source: "pass\n" },
  });
  const script = launchFile(compiled);
  // The wrapper execs the same command line, so the CLI keeps the launch PID.
  expect(script).toContain(
    `\nexec /usr/bin/python3 -IB -c "$CARDIGAN_RUN_COMMAND" session -- nice -n 10 'claude'`,
  );
  expect(script.indexOf("export CARDIGAN_SESSION_PID=$$")).toBeLessThan(
    script.indexOf(" session -- "),
  );
  expect(compiled.env.TMPDIR).toBeUndefined();
});

const first = firstPrompt({
  card_id: "C-3",
  work_item_id: "W-7",
  assignment_id: "A-12",
  run_id: "R-5",
});

test("C-676: every session learns its project's code, legacy core prompts included", () => {
  const core = (
    assignment: CompileAssignmentInput["assignment"],
    role = roleFor("claude-code", "claude-agent"),
  ) =>
    compileAssignmentLaunch({
      assignment,
      role,
      launch: launchConfig,
      mcp: { url: MCP_URL },
      run_dir: RUN_DIR,
      work_dir: WORK_DIR,
      first_prompt: "[bell]",
      secrets,
    }).files.find((file) => file.path === `${RUN_DIR}/core.md`)?.content ?? "";
  const base = { assignment_id: "A-12", run_id: "R-5", project_id: "p-demo" };
  const line =
    '项目资料：本项目 "p-demo" 的代号是 CDG，本项目卡片 C-12 的完整编号写作 CDG-C-12；引用其它项目或写给所有者时用完整编号。';
  expect(core({ ...base, project_code: "CDG" })).toContain(line);
  // A custom legacy prompt is otherwise kept verbatim; the code still follows it.
  expect(
    core(
      { ...base, project_code: "CDG" },
      { ...roleFor("claude-code", "claude-agent"), core_prompt: "Legacy" },
    ),
  ).toBe(`Legacy\n\n${line}\n`);
  // No code, or a malformed one, adds nothing.
  expect(core(base)).not.toContain("项目资料：");
  expect(core({ ...base, project_code: "cdg\n# 指令" })).not.toContain(
    "项目资料：",
  );
});

describe("snapshot: claude-code", () => {
  const compiled = compile("claude-code", "claude-agent", first);

  test("command, arguments and files", () => {
    expect({
      command: compiled.command,
      args: compiled.args,
      env: compiled.env,
      files: compiled.files.map((file) => ({
        path: file.path,
        mode: file.mode.toString(8),
        content: file.content,
      })),
    }).toMatchSnapshot();
  });

  test("wires the Card MCP server through --mcp-config and the Core Prompt", () => {
    const mcp = compiled.files.find((file) => file.path.endsWith("mcp.json"));
    expect(mcp?.mode).toBe(0o600);
    const config = JSON.parse(mcp?.content ?? "{}") as {
      mcpServers: Record<
        string,
        { url: string; headers: Record<string, string> }
      >;
    };
    expect(config.mcpServers.card?.url).toBe(MCP_URL);
    // The literal placeholder Claude Code expands at runtime, not a value.
    expect(config.mcpServers.card?.headers.Authorization).toMatch(
      /^Bearer \$\{MCP_TOKEN\}$/,
    );

    expect(compiled.args).toContain("--strict-mcp-config");
    expect(compiled.args).toContain("--mcp-config");
    expect(compiled.args).toContain(`${RUN_DIR}/core.md`);
    const toolsIndex = compiled.args.indexOf("--allowedTools");
    expect(compiled.args[toolsIndex + 1]).toContain(
      "mcp__card__submit_delivery",
    );
    expect(compiled.env.DISABLE_AUTOUPDATER).toBe("1");
    expect(compiled.env.CLAUDE_CONFIG_DIR).toBe(`${RUN_DIR}/claude`);
  });

  test("the Core Prompt and the first prompt are written into the run directory", () => {
    const core = compiled.files.find(
      (file) => file.path === `${RUN_DIR}/core.md`,
    );
    const opening = compiled.files.find(
      (file) => file.path === `${RUN_DIR}/first.md`,
    );
    expect(core?.content).toContain("# 角色：coder");
    expect(opening?.content).toContain(
      "[bell] card=C-3 wi=W-7 asg=A-12 run=R-5",
    );
  });
});

describe("snapshot: codex", () => {
  const compiled = compile("codex", "codex-agent", first);

  test("command, arguments and files", () => {
    expect({
      command: compiled.command,
      args: compiled.args,
      env: compiled.env,
      files: compiled.files.map((file) => ({
        path: file.path,
        mode: file.mode.toString(8),
        // C-600: the Card bridge's source is pinned by mcp-bridge.test.ts.
        content: file.content.replace(
          JSON.stringify(MCP_BRIDGE_SOURCE),
          '"<MCP_BRIDGE_SOURCE>"',
        ),
      })),
    }).toMatchSnapshot();
  });

  test("points CODEX_HOME at the run directory and approves the Card tools", () => {
    expect(compiled.env.CODEX_HOME).toBe(`${RUN_DIR}/codex`);
    expect(compiled.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    const config = compiled.files.find(
      (file) => file.path === `${RUN_DIR}/codex/config.toml`,
    );
    expect(config?.content).toContain("[mcp_servers.card]");
    // C-600: the Card server is the stdio bridge to MCP_URL; Codex forwards
    // the Token from its environment to the bridge only.
    expect(config?.content).toContain(
      `args = [${mcpBridgeArgs(MCP_URL)
        .map((arg) => JSON.stringify(arg))
        .join(", ")}]`,
    );
    expect(config?.content).toContain('env_vars = ["MCP_TOKEN"]');
    expect(config?.content).not.toContain(TOKEN);
    expect(config?.content).toContain(
      "[mcp_servers.card.tools.submit_delivery]",
    );
    expect(config?.content).toContain('approval_mode = "approve"');
  });

  test("the Core Prompt is the model instruction file", () => {
    const config = compiled.files.find(
      (file) => file.path === `${RUN_DIR}/codex/config.toml`,
    );
    // Codex replaces its own instructions with model_instructions_file, so the
    // Core Prompt has to be reachable from the config we write.
    expect(config?.content).toMatch(/model_instructions_file|core\.md/);
  });
});

describe("snapshot: pi", () => {
  const compiled = compile("pi", "pi-agent", first);

  test("command, arguments and files", () => {
    expect({
      command: compiled.command,
      args: compiled.args,
      env: compiled.env,
      files: compiled.files.map((file) => ({
        path: file.path,
        mode: file.mode.toString(8),
        content: file.content,
      })),
    }).toMatchSnapshot();
  });

  test("uses PI_CODING_AGENT_DIR and appends the Core Prompt without disabling extensions", () => {
    expect(compiled.env.PI_CODING_AGENT_DIR).toBe(`${RUN_DIR}/pi`);
    expect(compiled.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(compiled.args).toContain("--append-system-prompt");
    expect(compiled.args).toContain(`${RUN_DIR}/core.md`);
    expect(compiled.args).not.toContain("--no-extensions");
  });

  test("exposes Card tools directly and keeps the token as an environment reference", () => {
    vi.stubEnv("MCP_TOKEN", TOKEN);
    try {
      const withToken = compile("pi", "pi-agent", first);
      const mcp = withToken.files.find(
        (file) => file.path === `${withToken.env.PI_CODING_AGENT_DIR}/mcp.json`,
      );
      expect(mcp?.mode).toBe(0o600);
      expect(JSON.parse(mcp?.content ?? "{}")).toEqual({
        mcpServers: {
          card: {
            url: MCP_URL,
            exposure: "direct",
            headers: { Authorization: `Bearer \${MCP_TOKEN}` },
          },
        },
      });
      expect(surface(withToken)).not.toContain(TOKEN);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the token never reaches a generated file", () => {
  for (const [harness, profile] of [
    ["claude-code", "claude-agent"],
    ["codex", "codex-agent"],
    ["pi", "pi-agent"],
  ] as const) {
    test(`${harness}: no plaintext token in files, argv or env`, () => {
      const compiled = compile(harness, profile, first);
      const text = surface(compiled);
      expect(text).not.toContain(TOKEN);
      // Only the variable reference appears.
      expect(text).toContain("MCP_TOKEN");
      // The wrapper never receives the token as an argument.
      expect(compiled.args.join(" ")).not.toContain("token=");
      expect(Object.keys(compiled.env)).not.toContain("MCP_TOKEN");
    });
  }

  test("launch.sh reads the token file, deletes it and exports MCP_TOKEN", () => {
    const compiled = compile("pi", "pi-agent", first);
    const script = compiled.files.find((file) =>
      file.path.endsWith("launch.sh"),
    );
    expect(script?.mode).toBe(0o700);
    const content = script?.content ?? "";
    expect(content).toContain("token_file=");
    expect(content).toContain(`cat "$token_file"`);
    expect(content).toContain('rm -f "$token_file"');
    expect(content).toContain("export MCP_TOKEN");
    expect(content).toContain("exec nice -n 10 'pi'");
    // Reading before deleting, and failing loudly when the file is gone.
    expect(content.indexOf('cat "$token_file"')).toBeLessThan(
      content.indexOf('rm -f "$token_file"'),
    );
    expect(content).toContain("exit 78");
    expect(compiled.token_file).toBe(`${RUN_DIR}/token`);
    expect(compiled.launch_script).toBe(`${RUN_DIR}/launch.sh`);
  });
});

describe("default role pack", () => {
  // §6.3 as written in the plan, independent of the exported constant, so
  // deleting a rule from the role pack cannot delete the expectation too.
  const SPEC_RULES = [
    {
      name: "开始读更新",
      phrases: ["每次 Run 开始时调用 `get_updates`", "结束前再调用一次"],
    },
    { name: "ACK", phrases: ["`ack_events`"] },
    {
      name: "结构化产出",
      phrases: ["`submit_delivery` 或 `submit_review`", "不能只在终端里说"],
    },
    {
      name: "请求拍板",
      phrases: ["`request_decision`", "finish_run(outcome=blocked)"],
    },
    { name: "结束 Run", phrases: ["本次 Run 结束必须调用 `finish_run`"] },
    { name: "空闲自查", phrases: ["空闲时", "`get_updates` 自查", "防止漏铃"] },
  ] as const;

  test("the exported protocol is the six §6.3 rules", () => {
    expect(AGENT_PROTOCOL).toHaveLength(SPEC_RULES.length);
    const joined = AGENT_PROTOCOL.join("\n");
    for (const rule of SPEC_RULES) {
      for (const phrase of rule.phrases) {
        expect(joined, `${rule.name} is missing: ${phrase}`).toContain(phrase);
      }
    }
  });

  const DEFAULT_ROLE_IDS = [
    "pm",
    "coder",
    "reviewer",
    "designer",
    "tester",
  ] as const;

  // P2a-4 expectations come from the card, not the production rule arrays.
  const SHARED_TASK_RULES = [
    "验证时不得人为制造 CPU 负载（空转、压测）；偶发失败只重复运行，次数不超过 20。",
    "实现卡不修改开发方案正文；设计说明可写在卡片、PR 描述或 `docs/plans/<卡号>.md`，开发方案由里程碑收尾统一同步。",
    "只运行卡片或工作项写明范围的测试；未写明范围时只运行改动所在包的测试。全量测试和端到端测试由合并前的主机检查负责。",
  ];
  const CODER_REPAIR_RULE =
    "收到修复或退回修改（包括 `fix` Run、`merge_changes_requested`、合并冲突）时，先把最新的基线分支合入当前工作分支并解决冲突，再跑测试并交付；交付摘要里写明合入的基线提交 SHA。";

  function expectTaskRules(prompt: string, roleId: DefaultRoleId): void {
    for (const rule of SHARED_TASK_RULES) {
      expect(prompt, `${roleId}: ${rule}`).toContain(`- ${rule}\n`);
    }
    if (roleId === "coder") {
      expect(prompt).toContain(`- ${CODER_REPAIR_RULE}\n`);
    } else {
      expect(prompt).not.toContain("最新的基线分支");
      expect(prompt).not.toContain("合入的基线提交 SHA");
    }
  }

  test.each(DEFAULT_ROLE_IDS)(
    "P2a-4: %s carries shared task boundaries and only coder has the repair rule",
    (roleId) => {
      expectTaskRules(corePromptFor(roleId), roleId);
    },
  );

  describe.each([
    ["claude-code", "claude-agent"],
    ["codex", "codex-agent"],
    ["pi", "pi-agent"],
  ] as const)("P2a-4: %s launch", (harness, profile) => {
    test.each(DEFAULT_ROLE_IDS)(
      "%s loads task rules through its configured Core Prompt",
      (roleId) => {
        const compiled = compile(harness, profile, first, roleId);
        const corePath = `${RUN_DIR}/core.md`;
        const core = compiled.files.find((file) => file.path === corePath);
        expectTaskRules(core?.content ?? "", roleId);

        if (harness === "codex") {
          const config = compiled.files.find(
            (file) => file.path === `${RUN_DIR}/codex/config.toml`,
          );
          expect(config?.content).toContain(
            `model_instructions_file = "${corePath}"`,
          );
        } else {
          const flag =
            harness === "claude-code"
              ? "--append-system-prompt-file"
              : "--append-system-prompt";
          const index = compiled.args.indexOf(flag);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(compiled.args[index + 1]).toBe(corePath);
        }
      },
    );
  });

  test("every role's Core Prompt carries all of §6.3", () => {
    const titles = {
      pm: "PM",
      coder: "coder",
      reviewer: "reviewer",
      designer: "designer",
      tester: "tester",
    } as const;
    for (const role of DEFAULT_ROLE_IDS) {
      const prompt = corePromptFor(role);
      for (const rule of SPEC_RULES) {
        for (const phrase of rule.phrases) {
          expect(
            prompt,
            `${role} is missing ${rule.name}: ${phrase}`,
          ).toContain(phrase);
        }
      }
      expect(prompt).toContain(`# 角色：${titles[role]}`);
    }
  });

  test("the protocol names the MCP tools the agent must call", () => {
    const prompt = corePromptFor("coder");
    for (const tool of [
      "get_updates",
      "ack_events",
      "submit_delivery",
      "submit_review",
      "request_decision",
      "finish_run",
    ]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toContain("finish_run(outcome=blocked)");
  });

  test("M5.S S20: the coder prompt bounds delivery summaries and routes long content elsewhere", () => {
    const prompt = corePromptFor("coder");
    for (const phrase of [
      "`summary` 不超过 160 字",
      "`test_results`",
      "`known_gaps`",
      "附件",
      "不要塞进 `summary`",
    ])
      expect(prompt, `coder is missing: ${phrase}`).toContain(phrase);
  });

  test.each([
    [
      "designer",
      [
        "验证型角色",
        "只读的 worktree",
        "只审当前版本",
        "界面、交互和文案",
        "截图",
        "`submit_review` 提交结论",
        "`target_sha` 必须等于交付的 `subject`",
        "`verdict` 与 `blocking` 由服务端计算",
        "第二轮起新增 critical 仍须带 proof",
        "新增 major 必须是必改问题",
        "不改代码",
        "不 push",
      ],
    ],
    [
      "tester",
      [
        "验证型角色",
        "只读的 worktree",
        "只审当前版本",
        "实际运行和测试",
        "什么命令",
        "什么环境",
        "模拟",
        "真机",
        "未覆盖",
        "不要声称测过",
        "`submit_review` 提交结论",
        "`target_sha` 必须等于交付的 `subject`",
        "`verdict` 与 `blocking` 由服务端计算",
        "第二轮起新增 critical 仍须带 proof",
        "新增 major 必须是必改问题",
        "不改代码",
        "不 push",
      ],
    ],
  ] as const)(
    "M5.S designer and tester role: %s keeps the review contract",
    (role, phrases) => {
      const prompt = corePromptFor(role);
      for (const phrase of phrases)
        expect(prompt, `${role} is missing: ${phrase}`).toContain(phrase);
    },
  );

  // M3 plan §3.4 / development plan §7.1 and §7.3, again written from the plan.
  const PM_MODES = [
    {
      name: "Office",
      phrases: ["PM Office（前台）", "和人讨论需求", "阶段总结"],
    },
    {
      name: "Ops",
      phrases: ["PM Ops（后台）", "重新规划", "升级"],
    },
    {
      name: "how to tell the mode",
      phrases: ["`whoami`", "record_decision", "前台"],
    },
    {
      name: "bells",
      phrases: ["Needs You", "Router 升级上来的事件", "合并"],
    },
    {
      name: "interruption rule",
      phrases: ["需要人做决定", "明显损失", "不要往对话里写汇报"],
    },
    {
      name: "Office records the human's words",
      phrases: ["`record_decision`", "`raw_quote`", "原话", "pm_office_chat"],
    },
  ] as const;

  test("the pm Core Prompt explains both contexts and the interruption rules", () => {
    const prompt = corePromptFor("pm");
    for (const mode of PM_MODES) {
      for (const phrase of mode.phrases) {
        expect(prompt, `${mode.name} is missing: ${phrase}`).toContain(phrase);
      }
    }
    // The two contexts must be presented side by side, not one after the other.
    expect(prompt).toContain("| | PM Office（前台） | PM Ops（后台） |");
  });

  test("M5.S S14: PM acceptance reviews the completion request, not the product delivery", () => {
    const prompt = corePromptFor("pm");
    for (const phrase of [
      "工作项上的 PM 验收审的是完成申请",
      "`kind=card_completion`",
      "不审产出交付",
      "常驻 PM 不直接提交审核",
      "`whoami` 的 `worktree_path`",
      "指派",
    ])
      expect(prompt, `pm is missing: ${phrase}`).toContain(phrase);
    for (const role of [
      "coder",
      "reviewer",
      "independent_reviewer",
      "designer",
      "ui_ux_designer",
      "design_director",
      "tester",
    ] as const) {
      expect(corePromptFor(role), role).not.toContain("不审产出交付");
      expect(corePromptFor(role), role).not.toContain("常驻 PM 不直接提交审核");
    }
  });

  test("non-PM prompts stay free of PM instructions", () => {
    for (const role of [
      "coder",
      "reviewer",
      "independent_reviewer",
      "designer",
      "ui_ux_designer",
      "design_director",
      "tester",
    ] as const) {
      const prompt = corePromptFor(role);
      expect(prompt).not.toContain("PM Office");
      expect(prompt).not.toContain("`record_decision`");
    }
  });

  test("defaultRoles builds every default role from the given harness mappings", () => {
    const roles = defaultRoles({
      host_ops: {
        harness: "codex",
        launch_profile: "codex-agent",
        worktree: "none",
        allowed_tools: ["whoami"],
      },
      pm: {
        harness: "claude-code",
        launch_profile: "claude-agent",
        worktree: "none",
        allowed_tools: ["whoami"],
      },
      coder: {
        harness: "codex",
        launch_profile: "codex-agent",
        worktree: "write",
        allowed_tools: TOOLS,
      },
      frontend_engineer: {
        harness: "claude-code",
        launch_profile: "claude-opus",
        worktree: "write",
        allowed_tools: TOOLS,
      },
      reviewer: {
        harness: "claude-code",
        launch_profile: "claude-agent",
        worktree: "readonly",
        allowed_tools: ["submit_review"],
      },
      independent_reviewer: {
        harness: "claude-code",
        launch_profile: "claude-opus",
        worktree: "readonly",
        allowed_tools: ["submit_review", "withdraw_review"],
      },
      designer: {
        harness: "claude-code",
        launch_profile: "claude-agent",
        worktree: "readonly",
        allowed_tools: ["submit_review"],
      },
      ui_ux_designer: {
        harness: "codex",
        launch_profile: "codex-astra",
        worktree: "write",
        allowed_tools: ["submit_delivery"],
      },
      design_director: {
        harness: "claude-code",
        launch_profile: "claude-opus",
        worktree: "readonly",
        allowed_tools: ["submit_review"],
      },
      tester: {
        harness: "claude-code",
        launch_profile: "claude-agent",
        worktree: "readonly",
        allowed_tools: ["submit_review"],
      },
    });

    expect(roles.map((role) => role.role_id)).toEqual([
      "pm",
      "coder",
      "frontend_engineer",
      "reviewer",
      "independent_reviewer",
      "designer",
      "ui_ux_designer",
      "design_director",
      "tester",
      "host_ops",
    ]);
    expect(roles.map((role) => role.worktree)).toEqual([
      "none",
      "write",
      "write",
      "readonly",
      "readonly",
      "readonly",
      "write",
      "readonly",
      "readonly",
      "none",
    ]);
    for (const role of roles) {
      for (const rule of AGENT_PROTOCOL) {
        expect(role.core_prompt).toContain(rule);
      }
      // Same §6.3 phrases as above, so a role cannot ship a trimmed protocol.
      expect(role.core_prompt).toContain("本次 Run 结束必须调用 `finish_run`");
      expect(role.core_prompt).toContain("防止漏铃");
      // Every role carries the shared boundaries, not just the protocol.
      for (const phrase of [
        "身份只来自 Token",
        "不要 push",
        "不要修改 Git 凭据",
        "实现细节、数值和阈值由作者或 PM",
      ])
        expect(role.core_prompt, `${role.role_id}: ${phrase}`).toContain(
          phrase,
        );
    }
  });

  test("firstPrompt is a bell, not a brief", () => {
    expect(first).toContain(
      "[bell] card=C-3 wi=W-7 asg=A-12 run=R-5 kind=initial",
    );
    expect(first).toContain("whoami");
    expect(first).toContain("get_card");
    expect(first).toContain("get_updates");
    expect(first).not.toContain("请实现");
  });
});

describe("mismatched role and profile are refused", () => {
  test("a codex role cannot use a claude profile", () => {
    expect(() =>
      compileAssignmentLaunch({
        assignment: { assignment_id: "A-1", run_id: "R-1" },
        role: { ...roleFor("codex", "claude-agent") },
        launch: launchConfig,
        mcp: { url: MCP_URL },
        run_dir: RUN_DIR,
        work_dir: WORK_DIR,
        first_prompt: "hello",
        secrets,
      }),
    ).toThrow(/claude-code/);
  });
});

test("Codex trusts only the Assignment worktree and its common-dir repository root", () => {
  const compiled = compile("codex", "codex-agent", first);
  const config =
    compiled.files.find((file) => file.path.endsWith("config.toml"))?.content ??
    "";
  expect(
    [...config.matchAll(/^\[projects\.(.+)\]\ntrust_level = "trusted"$/gm)].map(
      (m) => JSON.parse(m[1] ?? ""),
    ),
  ).toEqual([WORK_DIR, REPOSITORY_ROOT]);
});

test("Codex without a worktree trusts only its cwd, with TOML metacharacters escaped", () => {
  const cwd = '/srv/runs/project "quoted"/A-1';
  const compiled = compileAssignmentLaunch({
    assignment: { assignment_id: "A-1", run_id: "R-1" },
    role: { ...roleFor("codex", "codex-agent"), worktree: "none" },
    launch: launchConfig,
    mcp: { url: MCP_URL },
    run_dir: RUN_DIR,
    work_dir: cwd,
    repository_root: cwd,
    first_prompt: first,
    secrets,
  });
  const config =
    compiled.files.find((file) => file.path.endsWith("config.toml"))?.content ??
    "";
  expect(
    [...config.matchAll(/^\[projects\.(.+)\]$/gm)].map((m) =>
      JSON.parse(m[1] ?? ""),
    ),
  ).toEqual([cwd]);
});

function compilePi(work_dir_real?: string): CompiledAssignmentLaunch {
  return compileAssignmentLaunch({
    assignment: { assignment_id: "A-12", run_id: "R-5" },
    role: roleFor("pi", "pi-agent"),
    launch: launchConfig,
    mcp: { url: MCP_URL },
    run_dir: RUN_DIR,
    work_dir: WORK_DIR,
    ...(work_dir_real === undefined ? {} : { work_dir_real }),
    repository_root: REPOSITORY_ROOT,
    first_prompt: first,
    secrets,
  });
}
const trustFiles = (compiled: CompiledAssignmentLaunch) =>
  compiled.files.filter((file) => file.path.endsWith("trust.json"));

test("C-235 pi trust key is the host-verified real path, not the configured path", () => {
  const real = "/data/agent/worktrees/A-12";
  const trust = trustFiles(compilePi(real));
  expect(JSON.parse(trust[0]?.content ?? "")).toEqual({ [real]: true });
});

test("C-235 pi gets no pre-trust without a usable verified real path (fail closed)", () => {
  for (const real of [undefined, "relative/A-12", "/srv/x/../A-12", RUN_DIR])
    expect(trustFiles(compilePi(real))).toEqual([]);
});

test("C-211 pi pre-trusts exactly its worktree in the run's own agent dir, nothing else", () => {
  const compiled = compilePi(WORK_DIR);
  const trust = compiled.files.filter((file) =>
    file.path.endsWith("trust.json"),
  );
  expect(trust.map((file) => file.path)).toEqual([`${RUN_DIR}/pi/trust.json`]);
  // One exact path: no parent folder, no pattern, no global default.
  expect(JSON.parse(trust[0]?.content ?? "")).toEqual({ [WORK_DIR]: true });
  expect(trust[0]?.mode).toBe(0o600);
  expect(compiled.env.PI_CODING_AGENT_DIR).toBe(`${RUN_DIR}/pi`);
  expect(compiled.args).not.toContain("--approve");
  expect(compiled.args).not.toContain("-a");
  expect(
    compiled.files.some((file) => file.content.includes("defaultProjectTrust")),
  ).toBe(false);
});

test("C-211 pi without a worktree (cwd is the run directory) gets no trust entry", () => {
  const compiled = compileAssignmentLaunch({
    assignment: { assignment_id: "A-1", run_id: "R-1" },
    role: { ...roleFor("pi", "pi-agent"), worktree: "none" },
    launch: launchConfig,
    mcp: { url: MCP_URL },
    run_dir: RUN_DIR,
    work_dir: RUN_DIR,
    work_dir_real: RUN_DIR,
    first_prompt: first,
    secrets,
  });
  expect(compiled.files.some((file) => file.path.endsWith("trust.json"))).toBe(
    false,
  );
  // The other harnesses get no pi trust file either.
  for (const [harness, profile] of [
    ["claude-code", "claude-agent"],
    ["codex", "codex-agent"],
  ] as const)
    expect(
      compile(harness, profile, first).files.some((file) =>
        file.path.endsWith("trust.json"),
      ),
    ).toBe(false);
});

/** Recursively read every regular file under `dir`. */
function readTree(dir: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readTree(path));
    else out.push({ path, content: readFileSync(path, "utf8") });
  }
  return out;
}

const SECRET_VALUES = [secrets.CLAUDE_TOKEN, secrets.CODEX_KEY, secrets.PI_KEY];

describe("provider credentials leave the run directory", () => {
  test("secrets go to the 0600 secrets file, never into env or launch.sh", () => {
    for (const [harness, profile] of [
      ["claude-code", "claude-agent"],
      ["codex", "codex-agent"],
      ["pi", "pi-agent"],
    ] as const) {
      const compiled = compile(harness, profile, first);
      // `env` is what a caller may log; it carries no credential.
      expect(Object.values(compiled.env)).not.toContain(secrets.PI_KEY);
      expect(Object.keys(compiled.env)).not.toContain("OPENAI_API_KEY");
      // The credentials are declared separately and written to one file.
      expect(Object.keys(compiled.secret_env).length).toBeGreaterThan(0);
      const secretsFile = compiled.files.find((file) =>
        file.path.endsWith("secrets.env"),
      );
      expect(secretsFile?.mode).toBe(0o600);
      for (const value of SECRET_VALUES) {
        const inSecretsFile = secretsFile?.content.includes(value) ?? false;
        // Only the file that the wrapper deletes may carry a credential.
        if (value === secrets.PI_KEY && harness === "pi") {
          expect(inSecretsFile).toBe(true);
        }
      }
      // No other file carries it, and the wrapper only names the variables.
      const script = compiled.files.find((file) =>
        file.path.endsWith("launch.sh"),
      );
      for (const value of SECRET_VALUES) {
        expect(script?.content).not.toContain(value);
      }
      for (const file of compiled.files) {
        if (file.path.endsWith("secrets.env")) continue;
        for (const value of SECRET_VALUES) {
          expect(file.content, `${file.path} leaks a credential`).not.toContain(
            value,
          );
        }
      }
    }
  });

  test("the Claude settings file keeps its endpoint but not the token", () => {
    const compiled = compile("claude-code", "claude-agent", first);
    const settings = compiled.files.find((file) =>
      file.path.endsWith("claude-settings.json"),
    );
    const parsed = JSON.parse(settings?.content ?? "{}") as {
      env: Record<string, string>;
    };
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe(
      "https://gateway.example.invalid",
    );
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(compiled.secret_env.ANTHROPIC_AUTH_TOKEN).toBe(secrets.CLAUDE_TOKEN);
  });

  for (const [harness, profile, binary] of [
    ["claude-code", "claude-agent", "claude"],
    ["codex", "codex-agent", "codex"],
    ["pi", "pi-agent", "pi"],
  ] as const) {
    test(`${harness}: launch.sh hands over the credentials and deletes both files`, () => {
      const root = mkdtempSync(join(tmpdir(), "cardigan-launch-script-"));
      try {
        const sdk = "/fixture/Android's SDK $(false)";
        const runDir = join(root, "run");
        mkdirSync(runDir, { recursive: true });
        mkdirSync(join(root, "bin"), { recursive: true });
        const fakeCli = join(root, "bin", binary);
        writeFileSync(
          fakeCli,
          `#!/bin/sh\nenv | grep -E '^(MCP_TOKEN|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|DS_API_KEY|ANDROID_HOME)=' | sort\necho "args=$*"\n`,
        );
        chmodSync(fakeCli, 0o755);

        const compiled = compileAssignmentLaunch({
          assignment: { assignment_id: "A-12", run_id: "R-5" },
          role: roleFor(harness, profile),
          launch: launchConfig,
          mcp: { url: MCP_URL },
          run_dir: runDir,
          work_dir: runDir,
          first_prompt: first,
          secrets,
          worker_env: { ANDROID_HOME: sdk },
        });
        for (const file of compiled.files) {
          mkdirSync(join(file.path, ".."), { recursive: true });
          writeFileSync(file.path, file.content, { mode: file.mode });
          chmodSync(file.path, file.mode);
        }
        writeFileSync(compiled.token_file, "fictional-runtime-token\n", {
          mode: 0o600,
        });
        // The wrapper waits for the host to dispatch the Run first.
        writeFileSync(join(runDir, START_FILE_NAME), "");

        const env = {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
        };
        const output = execFileSync("sh", [compiled.launch_script], {
          encoding: "utf8",
          env,
        });

        expect(output).toContain(`ANDROID_HOME=${sdk}\n`);
        // The CLI saw both the token and the provider credential.
        expect(output).toContain("MCP_TOKEN=fictional-runtime-token");
        const secret = Object.values(compiled.secret_env)[0] ?? "";
        expect(output).toContain(secret);

        // Both credential files are gone, and nothing left on disk holds them.
        expect(existsSync(compiled.token_file)).toBe(false);
        expect(existsSync(join(runDir, "secrets.env"))).toBe(false);
        for (const file of readTree(runDir)) {
          expect(file.content).not.toContain("fictional-runtime-token");
          for (const value of SECRET_VALUES) {
            expect(
              file.content,
              `${file.path} still holds a credential`,
            ).not.toContain(value);
          }
        }
        // The remaining files are the prompts and the harness config only.
        for (const file of readTree(runDir)) {
          expect(statSync(file.path).isFile()).toBe(true);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("a missing secrets file refuses to start", () => {
    const root = mkdtempSync(join(tmpdir(), "cardigan-launch-script-"));
    try {
      const runDir = join(root, "run");
      mkdirSync(runDir, { recursive: true });
      const compiled = compileAssignmentLaunch({
        assignment: { assignment_id: "A-12", run_id: "R-5" },
        role: roleFor("pi", "pi-agent"),
        launch: launchConfig,
        mcp: { url: MCP_URL },
        run_dir: runDir,
        work_dir: runDir,
        first_prompt: first,
        secrets,
      });
      for (const file of compiled.files) {
        if (file.path.endsWith("secrets.env")) continue;
        mkdirSync(join(file.path, ".."), { recursive: true });
        writeFileSync(file.path, file.content, { mode: file.mode });
        chmodSync(file.path, file.mode);
      }
      writeFileSync(compiled.token_file, "fictional-runtime-token\n", {
        mode: 0o600,
      });
      expect(() =>
        execFileSync("sh", [compiled.launch_script], { encoding: "utf8" }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test.each([null, "codex-agent"])(
  "employee profile %s selects the compiler/CLI while preserving role permissions",
  (profile) => {
    const compiled = compileAssignmentLaunch({
      assignment: { assignment_id: "A-12", run_id: "R-5" },
      role: roleFor("pi", "pi-agent"),
      employee: { launch_profile_ref: profile },
      launch: launchConfig,
      mcp: { url: MCP_URL },
      run_dir: RUN_DIR,
      work_dir: WORK_DIR,
      first_prompt: "Fixture",
      secrets,
    });
    expect(compiled.profile).toBe(profile ?? "pi-agent");
    expect(compiled.harness).toBe(profile ? "codex" : "pi");
    expect(compiled.command).toBe(profile ? "codex" : "pi");
    expect(compiled.mcp_tool_names).toEqual(
      TOOLS.map((t) => `mcp__card__${t}`),
    );
    expect(
      compiled.files.find((f) => f.path.endsWith("/core.md"))?.content,
    ).toBe(corePromptFor("coder"));
  },
);

describe.each([
  ["claude-code", "claude-agent"],
  ["codex", "codex-agent"],
  ["pi", "pi-agent"],
] as const)("employee identity: %s", (harness, profile) => {
  const identity = {
    name: "诸葛亮 Mary",
    title: "开发工程师",
    bio: "负责实现和测试。",
  };
  const readPrompt = (result: CompiledAssignmentLaunch, name: string) =>
    result.files.find((file) => file.path === join(RUN_DIR, name))?.content;

  test("both Core Prompt and first message contain identity without changing launch options", () => {
    const plain = compile(harness, profile, first);
    const named = compile(harness, profile, first, "coder", {
      launch_profile_ref: null,
      identity,
    });
    for (const filename of ["core.md", "first.md"]) {
      const prompt = readPrompt(named, filename);
      expect(prompt).toContain('你是 "诸葛亮 Mary"，职位 "开发工程师"');
      expect(prompt).toContain('简介："负责实现和测试。"');
      expect(prompt).toContain("请在评论和交付摘要里用上述员工名字称呼自己");
    }
    expect(readPrompt(named, "core.md")).toContain('显示名："诸葛亮 Mary"');
    expect(readPrompt(named, "first.md")).toContain(first);
    expect(named.args).toEqual(plain.args);
    expect(named.env).toEqual(plain.env);
    expect(readPrompt(plain, "core.md")).toBe(corePromptFor("coder"));
    expect(readPrompt(plain, "first.md")).toBe(`${first}\n`);
  });

  test("optional bio and shell/Markdown-looking text remain quoted data only", () => {
    const name = '`name` $(touch nope) "quoted"';
    const result = compile(harness, profile, first, "coder", {
      launch_profile_ref: null,
      identity: { name, title: "## title", bio: "" },
    });
    expect(readPrompt(result, "core.md")).toContain(
      `显示名：${JSON.stringify(name)}`,
    );
    expect(readPrompt(result, "core.md")).not.toContain("简介：");
    expect(
      result.files.find((file) => file.path.endsWith("launch.sh"))?.content,
    ).not.toContain(name);
  });

  test.each([
    { name: "x".repeat(41) },
    { title: "x".repeat(41) },
    { bio: "x".repeat(201) },
    { name: " " },
    { title: " " },
    { name: "a\nb" },
    { title: "a\u0000b" },
    { bio: "a\u202eb" },
    { bio: "a\u2028b" },
  ])("rejects invalid persisted identity before compiling (%j)", (invalid) => {
    expect(() =>
      compile(harness, profile, first, "coder", {
        launch_profile_ref: null,
        identity: { ...identity, ...invalid },
      }),
    ).toThrow();
  });

  test("Unicode lengths count characters, not UTF-16 units", () => {
    expect(() =>
      compile(harness, profile, first, "coder", {
        launch_profile_ref: null,
        identity: {
          name: "😀".repeat(40),
          title: "😀".repeat(40),
          bio: "😀".repeat(200),
        },
      }),
    ).not.toThrow();
  });
});

test("C-679 a Run's own adb slot sets its port and emulator; a pinned worker port never overrides it; no slot disables adb", () => {
  const input = {
    assignment: { assignment_id: "A-1", run_id: "R-1", project_id: "demo" },
    role: roleFor("codex", "codex-agent", "coder"),
    launch: launchConfig,
    mcp: { url: MCP_URL },
    run_dir: RUN_DIR,
    work_dir: WORK_DIR,
    first_prompt: "test",
    secrets,
    worker_env: { ANDROID_ADB_SERVER_PORT: "5137", ANDROID_HOME: "/sdk" },
  };
  const emulator = compileAssignmentLaunch({
    ...input,
    adb_slot: { slot: 1, adb_port: 15101, emulator_port: 5602 },
  });
  expect(emulator.env).toMatchObject({
    ANDROID_ADB_SERVER_PORT: "15101",
    CARDIGAN_ADB_SLOT: "1",
    CARDIGAN_EMULATOR_PORT: "5602",
    ANDROID_SERIAL: "emulator-5602",
    ANDROID_HOME: "/sdk",
  });
  expect(emulator.env.ADB_SERVER_SOCKET).toBeUndefined();
  expect(surface(emulator)).toContain("-port $CARDIGAN_EMULATOR_PORT");
  const godot = compileAssignmentLaunch({
    ...input,
    adb_slot: { slot: 2, adb_port: 15102 },
  });
  expect(godot.env.ANDROID_ADB_SERVER_PORT).toBe("15102");
  expect(godot.env.CARDIGAN_EMULATOR_PORT).toBeUndefined();
  expect(godot.env.ANDROID_SERIAL).toBe("cardigan-unassigned");
  expect(surface(godot)).not.toContain("-port $CARDIGAN_EMULATOR_PORT");
  const none = compileAssignmentLaunch({ ...input, adb_slot: null });
  expect(none.env.ANDROID_ADB_SERVER_PORT).toBeUndefined();
  expect(none.env.ADB_SERVER_SOCKET).toBe("localfilesystem:/dev/null");
  expect(surface(none)).not.toContain("adb");
  // Machines without slots keep the worker binding unchanged.
  expect(compileAssignmentLaunch(input).env.ANDROID_ADB_SERVER_PORT).toBe(
    "5137",
  );
});

test("C-844 a Run without an emulator gets an AVD directory without AVDs and no SDK emulator directory on PATH; SDK and adb stay", () => {
  const input = {
    assignment: { assignment_id: "A-1", run_id: "R-1", project_id: "demo" },
    role: roleFor("codex", "codex-agent", "coder"),
    launch: launchConfig,
    mcp: { url: MCP_URL },
    run_dir: RUN_DIR,
    work_dir: WORK_DIR,
    first_prompt: "test",
    secrets,
    worker_env: {
      ANDROID_AVD_HOME: "/home/cg/.android/avd",
      ANDROID_HOME: "/sdk",
    },
  };
  const path =
    "/sdk/platform-tools:/sdk/emulator:/sdk/build-tools/35.0.0:/opt/emulator/:/usr/bin:/bin";
  const denied = compileAssignmentLaunch({
    ...input,
    adb_slot: { slot: 2, adb_port: 15102 },
    no_emulator: { path },
  });
  expect(denied.env).toMatchObject({
    ANDROID_AVD_HOME: RUN_DIR,
    ANDROID_HOME: "/sdk",
    ANDROID_ADB_SERVER_PORT: "15102",
    PATH: "/sdk/platform-tools:/sdk/build-tools/35.0.0:/usr/bin:/bin",
  });
  // Without a known session PATH only the AVD directory changes.
  const local = compileAssignmentLaunch({ ...input, no_emulator: {} });
  expect(local.env.ANDROID_AVD_HOME).toBe(RUN_DIR);
  expect(local.env.PATH).toBeUndefined();
  // A Run holding an emulator keeps the binding's AVD directory and PATH.
  const emulator = compileAssignmentLaunch({
    ...input,
    adb_slot: { slot: 1, adb_port: 15101, emulator_port: 5602 },
  });
  expect(emulator.env.ANDROID_AVD_HOME).toBe("/home/cg/.android/avd");
  expect(emulator.env.PATH).toBeUndefined();
  expect(pathWithoutEmulator("/a/emulator-tools:/emulator:emulator:/b")).toBe(
    "/a/emulator-tools:/b",
  );
});

test("C-813 ANDROID_SERIAL for emulator only, USB device only, and both; slot Runs without a device on a device machine get ADB_USB=0", () => {
  const input = {
    assignment: { assignment_id: "A-1", run_id: "R-1", project_id: "demo" },
    role: roleFor("codex", "codex-agent", "coder"),
    launch: launchConfig,
    mcp: { url: MCP_URL },
    run_dir: RUN_DIR,
    work_dir: WORK_DIR,
    first_prompt: "test",
    secrets,
    worker_env: { ANDROID_ADB_SERVER_PORT: "5137", ADB_USB: "1" },
  };
  const serial = "WGC6R21609003324";
  const emulator = compileAssignmentLaunch({
    ...input,
    adb_slot: { slot: 0, adb_port: 15100, emulator_port: 5600, usb_off: true },
  });
  expect(emulator.env).toMatchObject({
    ANDROID_ADB_SERVER_PORT: "15100",
    ANDROID_SERIAL: "emulator-5600",
    ADB_USB: "0",
  });
  expect(emulator.env.CARDIGAN_DEVICE_SERIAL).toBeUndefined();
  expect(surface(emulator)).toContain("用户 USB 真机");
  const device = compileAssignmentLaunch({
    ...input,
    adb_slot: { slot: 1, adb_port: 15101 },
    device_session: {
      env: { ANDROID_SERIAL: serial, CARDIGAN_DEVICE_SERIAL: serial },
      rules: ["DEVICE-RULE"],
    },
  });
  expect(device.env).toMatchObject({
    ANDROID_ADB_SERVER_PORT: "15101",
    ANDROID_SERIAL: serial,
    CARDIGAN_DEVICE_SERIAL: serial,
  });
  // The holder's own server must be free to claim USB.
  expect(device.env.ADB_USB).toBeUndefined();
  expect(surface(device)).toContain("DEVICE-RULE");
  expect(surface(device)).not.toContain("用户 USB 真机");
  const both = compileAssignmentLaunch({
    ...input,
    adb_slot: { slot: 2, adb_port: 15102, emulator_port: 5604 },
    device_session: {
      env: {
        CARDIGAN_DEVICE_SERIAL: serial,
        CARDIGAN_EMULATOR_SERIAL: "emulator-5604",
      },
      rules: ["BOTH-RULE"],
    },
  });
  expect(both.env).toMatchObject({
    ANDROID_SERIAL: "emulator-5604",
    CARDIGAN_EMULATOR_PORT: "5604",
    CARDIGAN_EMULATOR_SERIAL: "emulator-5604",
    CARDIGAN_DEVICE_SERIAL: serial,
  });
  expect(both.env.ADB_USB).toBeUndefined();
  expect(surface(both)).toContain("-port $CARDIGAN_EMULATOR_PORT");
  expect(surface(both)).toContain("BOTH-RULE");
  // A provider can only name the device, never other variables.
  expect(() =>
    compileAssignmentLaunch({
      ...input,
      adb_slot: { slot: 1, adb_port: 15101 },
      device_session: { env: { PATH: "/tmp" }, rules: [] },
    }),
  ).toThrow("Invalid device session environment");
  // Machines without devices keep the worker's ADB_USB and the C-679 env.
  expect(
    compileAssignmentLaunch({
      ...input,
      adb_slot: { slot: 2, adb_port: 15102 },
    }).env.ADB_USB,
  ).toBe("1");
});

test("C-497 role and environment expose only this admission; no assigned device never selects user USB", () => {
  const input = {
    assignment: { assignment_id: "A-1", run_id: "R-1", project_id: "demo" },
    role: roleFor("codex", "codex-agent", "coder"),
    launch: launchConfig,
    mcp: { url: MCP_URL },
    run_dir: RUN_DIR,
    work_dir: WORK_DIR,
    first_prompt: "test",
    secrets,
  };
  const bound = compileAssignmentLaunch({
    ...input,
    resource_bindings: [
      { key: "fixture", generation: "g1", port: 17071, device: "synthetic-1" },
    ],
  });
  expect(bound.env.ADB_SERVER_SOCKET).toBe("tcp:localhost:17071");
  expect(bound.env.ANDROID_SERIAL).toBe("synthetic-1");
  expect(bound.env.CARDIGAN_RESOURCE_BINDINGS).toContain("g1");
  expect(surface(bound)).toContain("禁止裸 adb");
  const unassigned = compileAssignmentLaunch({
    ...input,
    resource_bindings: [],
  });
  expect(unassigned.env.ANDROID_SERIAL).toBe("cardigan-unassigned");
  expect(unassigned.env.ADB_SERVER_SOCKET).not.toContain("5037");
  expect(
    compileAssignmentLaunch(input).env.CARDIGAN_RESOURCE_BINDINGS,
  ).toBeUndefined();
});

// C-823: every Claude launch trusts its exact cwd, worktree or run directory.
test.each([
  ["coder", WORK_DIR],
  ["pm", RUN_DIR],
] as const)(
  "claude-code %s trusts its cwd locally and on a worker",
  (roleId, cwd) => {
    const input = {
      assignment: { assignment_id: "A-1", run_id: "R-1" },
      role: roleFor("claude-code", "example", roleId),
      launch: parseLaunchConfig({
        profiles: { example: { harness: "claude-code" } },
      }),
      mcp: { url: MCP_URL },
      run_dir: RUN_DIR,
      work_dir: cwd,
      first_prompt: "fixture",
      secrets: {},
    };
    const local = compileAssignmentLaunch(input).files.find((file) =>
      file.path.endsWith("/launch.sh"),
    );
    expect(local?.content).toContain(
      `"$claude_config_dir" '${cwd}'\nexec nice`,
    );
    expect(local?.content).toContain("hasTrustDialogAccepted");
    const remote = compileAssignmentLaunch({
      ...input,
      worker_launch: { command: ["fixture-worker"], session_dir: "/s" },
    }).files.find((file) => file.path.endsWith("/launch.json"));
    expect(JSON.parse(remote?.content ?? "{}")).toMatchObject({
      cwd,
      trust_worktree: true,
    });
  },
);
