import { describe, expect, test } from "vitest";
import {
  BROWSER_BOUNDARY_RULE,
  BROWSER_CAPABILITY,
  BROWSER_ROLES,
  BROWSER_SCREENSHOT_RULE,
  BROWSER_TOOL_PATTERN,
  type CompiledAssignmentLaunch,
  compileAssignmentLaunch,
  corePromptFor,
  DEFAULT_ROLE_KINDS,
  type DefaultRoleId,
  defaultRoleDefinition,
  defaultRoles,
  type Harness,
  LaunchConfigError,
  parseLaunchConfig,
} from "./index.js";

/** P2a-14 ⑧: the local headless browser as a second, stdio-only MCP server. */
const RUN_DIR = "/srv/cardigan/runs/A-40";
const BROWSERS = "/opt/playwright-chromium-1.56.0";
const MCP_BIN = "/opt/playwright-mcp-0.0.45/bin/mcp-server-playwright";

const base = {
  providers: {},
  profiles: {
    claude: { harness: "claude-code", model: "opus" },
    codex: { harness: "codex", model: "gpt-6-astra" },
    pi: { harness: "pi", provider_flag: "deepseek", model: "deepseek-flash" },
  },
};
const withBrowser = parseLaunchConfig({
  ...base,
  browser: { command: MCP_BIN, browsers_path: BROWSERS },
});
const withoutBrowser = parseLaunchConfig(base);

/** A Core Prompt that carries the browser boundary, as an upgraded role does. */
const CORE = `core\n- ${BROWSER_BOUNDARY_RULE}`;

const PROFILE: Record<Harness, string> = {
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
};

function compile(
  harness: Harness,
  options: {
    readonly capabilities?: readonly string[];
    readonly launch?: typeof withBrowser;
    readonly role_id?: string;
    readonly core_prompt?: string;
  } = {},
): CompiledAssignmentLaunch {
  return compileAssignmentLaunch({
    assignment: { assignment_id: "A-40", run_id: "R-9", card_id: "C-1" },
    role: {
      role_id: options.role_id ?? "independent_reviewer",
      harness,
      launch_profile: PROFILE[harness],
      worktree: "readonly",
      allowed_tools: ["whoami", "submit_review"],
      core_prompt: options.core_prompt ?? CORE,
      ...(options.capabilities === undefined
        ? { capabilities: ["verify", BROWSER_CAPABILITY] }
        : { capabilities: options.capabilities }),
    },
    launch: options.launch ?? withBrowser,
    mcp: { url: "http://127.0.0.1:3004/mcp" },
    run_dir: RUN_DIR,
    work_dir: "/srv/agent/worktrees/A-40",
    first_prompt: "bell",
    secrets: {},
  });
}

function file(compiled: CompiledAssignmentLaunch, suffix: string): string {
  const found = compiled.files.find((f) => f.path.endsWith(suffix));
  if (found === undefined) throw new Error(`missing ${suffix}`);
  return found.content;
}

/** Every launch setting the host writes or passes to the CLI. */
function surface(compiled: CompiledAssignmentLaunch): string {
  return [
    ...compiled.args,
    ...Object.entries(compiled.env).map(([k, v]) => `${k}=${v}`),
    // The Core Prompt may name the browser in its rules; the launch must not.
    ...compiled.files
      .filter((f) => !f.path.endsWith("/core.md"))
      .map((f) => `${f.path}\n${f.content}`),
  ].join("\n");
}

const EXPECTED_ARGS = [
  "--headless",
  "--isolated",
  "--browser",
  "chromium",
  "--output-dir",
  `${RUN_DIR}/playwright`,
];

describe("roles with the browser capability get a local stdio server", () => {
  test("claude-code: second mcpServers entry and the tool pattern in --allowedTools", () => {
    const compiled = compile("claude-code");
    const config = JSON.parse(file(compiled, "mcp.json")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(["card", "playwright"]);
    expect(config.mcpServers.playwright).toEqual({
      type: "stdio",
      command: MCP_BIN,
      args: EXPECTED_ARGS,
      env: { PLAYWRIGHT_BROWSERS_PATH: BROWSERS },
    });
    const allowed = compiled.args[compiled.args.indexOf("--allowedTools") + 1];
    expect(allowed?.split(",")).toEqual([
      "mcp__card__whoami",
      "mcp__card__submit_review",
      BROWSER_TOOL_PATTERN,
    ]);
    expect(BROWSER_TOOL_PATTERN).toBe("mcp__playwright__*");
    expect(compiled.browser).toBe(true);
    // Card tool names stay Card-only; the browser is not a Card tool.
    expect(compiled.mcp_tool_names).toEqual([
      "mcp__card__whoami",
      "mcp__card__submit_review",
    ]);
  });

  test("codex: a [mcp_servers.playwright] table with command, args and env", () => {
    const toml = file(compile("codex"), "config.toml");
    const section = toml.slice(toml.indexOf("[mcp_servers.playwright]"));
    expect(section).toContain(
      [
        "[mcp_servers.playwright]",
        `command = ${JSON.stringify(MCP_BIN)}`,
        `args = [${EXPECTED_ARGS.map((a) => JSON.stringify(a)).join(", ")}]`,
        'default_tools_approval_mode = "approve"',
        "",
        "[mcp_servers.playwright.env]",
        `PLAYWRIGHT_BROWSERS_PATH = ${JSON.stringify(BROWSERS)}`,
      ].join("\n"),
    );
    // The Card server keeps its own table and per-tool approvals.
    expect(toml).toContain("[mcp_servers.card]");
    expect(toml).toContain("[mcp_servers.card.tools.submit_review]");
  });

  test("pi: a second mcpServers entry with direct exposure", () => {
    const config = JSON.parse(file(compile("pi"), "pi/mcp.json")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(config.mcpServers.playwright).toEqual({
      command: MCP_BIN,
      args: EXPECTED_ARGS,
      env: { PLAYWRIGHT_BROWSERS_PATH: BROWSERS },
      exposure: "direct",
    });
  });

  test.each(["claude-code", "codex", "pi"] as const)(
    "%s: the browser server is stdio only, with no URL or token",
    (harness) => {
      const compiled = compile(harness);
      const content =
        harness === "codex"
          ? file(compiled, "config.toml")
          : file(compiled, harness === "pi" ? "pi/mcp.json" : "mcp.json");
      const browserPart =
        harness === "codex"
          ? content.slice(
              content.indexOf("[mcp_servers.playwright]"),
              content.indexOf("[projects."),
            )
          : JSON.stringify(
              (
                JSON.parse(content) as {
                  mcpServers: Record<string, unknown>;
                }
              ).mcpServers.playwright,
            );
      expect(browserPart).not.toMatch(/url|bearer|token|Authorization/iu);
      expect(browserPart).toContain("PLAYWRIGHT_BROWSERS_PATH");
    },
  );
});

describe("no browser leaks to other roles or hosts", () => {
  test.each(["claude-code", "codex", "pi"] as const)(
    "%s: a role without the capability (coder) gets nothing",
    (harness) => {
      const compiled = compile(harness, {
        role_id: "coder",
        capabilities: ["produce"],
      });
      expect(surface(compiled)).not.toMatch(/playwright|PLAYWRIGHT|chromium/u);
      expect(compiled.browser).toBe(false);
    },
  );

  test.each(["claude-code", "codex", "pi"] as const)(
    "%s: a host without a browser install gets nothing",
    (harness) => {
      const compiled = compile(harness, { launch: withoutBrowser });
      expect(surface(compiled)).not.toMatch(/playwright|PLAYWRIGHT|chromium/u);
      expect(compiled.browser).toBe(false);
    },
  );

  const harnesses = ["claude-code", "codex", "pi"] as const;
  test.each(
    harnesses.flatMap((harness) =>
      [
        "coder",
        "reviewer",
        "pm",
        "tester",
        "designer",
        "host_ops",
        "custom",
      ].map((role_id) => [harness, role_id] as const),
    ),
  )(
    "%s: %s declaring browser (even with the rule) still gets nothing",
    (harness, role_id) => {
      const compiled = compile(harness, {
        role_id,
        capabilities: [BROWSER_CAPABILITY],
      });
      expect(surface(compiled)).not.toMatch(/playwright|PLAYWRIGHT|chromium/u);
      expect(compiled.browser).toBe(false);
    },
  );

  test.each(
    harnesses.flatMap((harness) =>
      BROWSER_ROLES.map((role_id) => [harness, role_id] as const),
    ),
  )(
    "%s: %s on a role version without the Workbench rule gets nothing",
    (harness, role_id) => {
      const compiled = compile(harness, {
        role_id,
        core_prompt: "Existing role without browser boundary",
      });
      expect(surface(compiled)).not.toMatch(/playwright|PLAYWRIGHT|chromium/u);
      expect(compiled.browser).toBe(false);
    },
  );

  test.each(
    harnesses.flatMap((harness) =>
      BROWSER_ROLES.map((role_id) => [harness, role_id] as const),
    ),
  )(
    "%s: %s with capability, rule and host install gets the browser",
    (harness, role_id) => {
      expect(compile(harness, { role_id }).browser).toBe(true);
    },
  );

  test("the default pack's Core Prompts pass the boundary gate", () => {
    for (const role_id of BROWSER_ROLES) {
      const compiled = compileAssignmentLaunch({
        assignment: { assignment_id: "A-40", run_id: "R-9" },
        role: {
          role_id,
          harness: "claude-code",
          launch_profile: "claude",
          worktree: "readonly",
          allowed_tools: ["whoami"],
          core_prompt: corePromptFor(role_id),
          capabilities: defaultRoleDefinition(role_id, {
            harness: "claude-code",
            launch_profile_ref: "claude",
          }).capabilities,
        },
        launch: withBrowser,
        mcp: { url: "http://127.0.0.1:3004/mcp" },
        run_dir: RUN_DIR,
        work_dir: "/srv/agent/worktrees/A-40",
        first_prompt: "bell",
        secrets: {},
      });
      expect(compiled.browser, role_id).toBe(true);
    }
  });

  test("roles without capabilities (legacy callers) get nothing", () => {
    const compiled = compileAssignmentLaunch({
      assignment: { assignment_id: "A-40", run_id: "R-9" },
      role: {
        role_id: "independent_reviewer",
        harness: "claude-code",
        launch_profile: "claude",
        worktree: "readonly",
        allowed_tools: ["whoami"],
        core_prompt: CORE,
      },
      launch: withBrowser,
      mcp: { url: "http://127.0.0.1:3004/mcp" },
      run_dir: RUN_DIR,
      work_dir: "/srv/agent/worktrees/A-40",
      first_prompt: "bell",
      secrets: {},
    });
    expect(surface(compiled)).not.toMatch(/playwright/u);
  });

  test("the Card server cannot take the browser server's name", () => {
    expect(() =>
      compileAssignmentLaunch({
        assignment: { assignment_id: "A-40", run_id: "R-9" },
        role: {
          role_id: "independent_reviewer",
          harness: "claude-code",
          launch_profile: "claude",
          worktree: "readonly",
          allowed_tools: ["whoami"],
          core_prompt: CORE,
          capabilities: [BROWSER_CAPABILITY],
        },
        launch: withBrowser,
        mcp: { url: "http://127.0.0.1:3004/mcp", server_name: "playwright" },
        run_dir: RUN_DIR,
        work_dir: "/srv/agent/worktrees/A-40",
        first_prompt: "bell",
        secrets: {},
      }),
    ).toThrow(/reserved/u);
  });
});

describe("launch.yaml browser section", () => {
  test.each([
    [{ command: "mcp-server-playwright", browsers_path: BROWSERS }],
    [{ command: MCP_BIN, browsers_path: "playwright-chromium" }],
    [{ command: MCP_BIN }],
    [{ command: MCP_BIN, browsers_path: BROWSERS, port: 8931 }],
    // No free-form args: they could switch transport, attach an existing
    // browser, or move the browser and output directory (review V-646).
    ...[
      ["--port", "8931"],
      ["--extension"],
      ["--browser", "webkit"],
      ["--output-dir", "/tmp/elsewhere"],
      ["--viewport-size", "390,844"],
      [],
    ].map((args) => [{ command: MCP_BIN, browsers_path: BROWSERS, args }]),
  ])("rejects %j", (browser) => {
    expect(() => parseLaunchConfig({ ...base, browser })).toThrow(
      LaunchConfigError,
    );
  });
});

describe("default role pack", () => {
  const launch = { harness: "claude-code", launch_profile_ref: "x" } as const;
  const all = Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[];

  test("only the three browser roles carry the browser capability", () => {
    expect([...BROWSER_ROLES].sort()).toEqual(
      ["design_director", "independent_reviewer", "ui_ux_designer"].sort(),
    );
    for (const role of all) {
      const definition = defaultRoleDefinition(role, launch);
      expect(definition.capabilities.includes(BROWSER_CAPABILITY)).toBe(
        (BROWSER_ROLES as readonly string[]).includes(role),
      );
      // The browser is never a Card tool.
      expect(
        definition.allowed_tools.some((tool) => tool.includes("playwright")),
      ).toBe(false);
    }
  });

  test("defaultRoles passes the capability to the launch compiler", () => {
    const options = Object.fromEntries(
      all.map((role) => [
        role,
        {
          harness: "claude-code",
          launch_profile: "claude",
          worktree: "readonly",
          allowed_tools: [],
        },
      ]),
    ) as unknown as Parameters<typeof defaultRoles>[0];
    for (const role of defaultRoles(options))
      expect(role.capabilities?.includes(BROWSER_CAPABILITY) ?? false).toBe(
        (BROWSER_ROLES as readonly string[]).includes(role.role_id),
      );
  });

  test("browser roles carry the Workbench boundary; only the reviewer the screenshot rule", () => {
    expect(BROWSER_BOUNDARY_RULE).toContain("不得打开生产 Workbench");
    expect(BROWSER_BOUNDARY_RULE).toContain("127.0.0.1:7781");
    expect(BROWSER_SCREENSHOT_RULE).toContain("390px");
    expect(BROWSER_SCREENSHOT_RULE).toContain(
      "upload_attachment(kind=evidence)",
    );
    for (const role of all) {
      const { instructions } = defaultRoleDefinition(role, launch);
      const browser = (BROWSER_ROLES as readonly string[]).includes(role);
      expect(instructions?.includes(BROWSER_BOUNDARY_RULE)).toBe(browser);
      expect(instructions?.includes(BROWSER_SCREENSHOT_RULE)).toBe(
        role === "independent_reviewer",
      );
    }
  });
});
