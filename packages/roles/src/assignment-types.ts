import type { Employee, Harness } from "@cardigan/domain";
import type { CompiledFile } from "./launch-types.js";
import type { LaunchConfig } from "./schema-definition.js";
export const RUN_RESOURCE_RULE =
  '开发服务、浏览器及临时命令中的任务私用进程必须经 /usr/bin/python3 -IB -c "$CARDIGAN_RUN_COMMAND" R-n --private -- 命令 参数 启动（R-n 取当前门铃，不沿用上次编号）。Vite 项目可用同一入口 R-n --private-vite 已分配端口立即启动，或显式改用 --private-vite-on-demand 已分配端口，首次连接才启动。后者仅在从未接入时可自动释放监听，不自动停止已启动的 Vite。其它长驻服务或浏览器由实际持有私用控制连接的启动器监听 CARDIGAN_PRIVATE_LIFETIME_FD 收尾。临时文件写入该命令的 $TMPDIR。不要把共享服务当作私用任务登记；未登记或不能证明独占的进程只审计，不自动停止。';
export const MCP_SERVER_NAME = "card";
export const TOKEN_ENV_VAR = "MCP_TOKEN";
/** The token file the wrapper reads and removes before starting the CLI. */
export const TOKEN_FILE_NAME = "token";
export const LAUNCH_SCRIPT_NAME = "launch.sh";
/** Provider credentials for one launch; sourced and deleted by `launch.sh`. */
export const SECRETS_FILE_NAME = "secrets.env";
/**
 * The host writes this sentinel after `dispatchRun` commits; `launch.sh` waits
 * for it before starting the CLI. Without it a fast Agent can call the MCP
 * endpoint while its Run is still `queued`, and the "first tool call
 * acknowledges the Run" hook would have nothing to acknowledge (M2 §4 step 5–8).
 */
export const START_FILE_NAME = "start";

/**
 * P2a-14 ⑧: role capability that adds the host's local headless browser as a
 * second, stdio-only MCP server. It travels with the role version, so a role
 * gets the browser only after `role upgrade --from-default` brings the rules
 * that come with it (Core Prompt: never open the production Workbench).
 */
export const BROWSER_CAPABILITY = "browser";
export const BROWSER_MCP_SERVER_NAME = "playwright";
/** Harness allow-list entry for every tool of the browser server. */
export const BROWSER_TOOL_PATTERN = `mcp__${BROWSER_MCP_SERVER_NAME}__*`;
/** Default roles that carry the `browser` capability (ADR 0006 decision 6). */
export const BROWSER_ROLES = [
  "frontend_engineer",
  "ui_ux_designer",
  "design_director",
  "independent_reviewer",
] as const;

/**
 * P2a-14 ⑧: the local browser's boundary. A role rule, not a network
 * restriction (ADR 0006 decision 6): the Agent already has a shell, and the
 * real boundaries are the Workbench password and the Card MCP token.
 */
export const BROWSER_BOUNDARY_RULE = `有浏览器工具（\`${BROWSER_TOOL_PATTERN}\`）时，被测页面只能是你自己起的本地 dev server（验证方在主机准备的可写构建目录，产出方在当前 worktree）；不得打开生产 Workbench，不得导航到 127.0.0.1:7781 或其它已知 Workbench 端口，也不在浏览器里登录任何账号。没有浏览器工具时如实写未核，不声称看过页面。`;

/** Fixed arguments; the host config cannot add to or override them. */
export const BROWSER_MCP_ARGS = [
  "--headless",
  "--isolated",
  "--browser",
  "chromium",
] as const;

export interface AssignmentRoleInput {
  readonly role_id: string;
  readonly harness: Harness;
  /** Name of the launch profile in `launch.yaml` (§10.2). */
  readonly launch_profile: string;
  /** Full Core Prompt; §6.3's protocol must be part of it. */
  readonly core_prompt?: string;
  readonly instructions?: string;
  /** Card MCP tools this role may call; the CLI allow-list is derived from it. */
  readonly allowed_tools: readonly string[];
  /** `none` roles (PM) run in the run directory instead of a worktree. */
  readonly worktree: "none" | "write" | "readonly";
  /** Role capabilities; `browser` asks for the local browser server. */
  readonly capabilities?: readonly string[];
}

export interface AssignmentIdentity {
  readonly assignment_id: string;
  readonly run_id: string;
  readonly card_id?: string;
  readonly work_item_id?: string;
  readonly project_id?: string;
}

export interface AssignmentMcpEndpoint {
  /** Card MCP streamable HTTP endpoint, e.g. `http://127.0.0.1:3004/mcp`. */
  readonly url: string;
  readonly server_name?: string;
  /**
   * C-600: per-launch key the harness sends as `MCP_SESSION_HEADER` from its
   * own MCP configuration (never the session's environment), so the endpoint
   * can tell this harness's native requests from any other client of the
   * Token. Codex hands it to its Card bridge only (`MCP_BRIDGE_SESSION_ENV`).
   */
  readonly session_key?: string;
  /**
   * C-600: interpreter that runs the Codex Card bridge where the harness
   * starts (`DEFAULT_MCP_BRIDGE_PYTHON` when absent).
   */
  readonly bridge_python?: string;
}

/** C-600: header and key shape shared with the Card MCP endpoint. */
export { MCP_SESSION_HEADER, MCP_SESSION_KEY_PATTERN } from "@cardigan/domain";

export interface CompileAssignmentInput {
  readonly assignment: AssignmentIdentity;
  /** Employee profiles select the CLI as well as its model/provider. */
  readonly employee?: {
    readonly launch_profile_ref: string | null;
    readonly identity?: Pick<Employee, "name" | "title" | "bio">;
  };
  readonly role: AssignmentRoleInput;
  /** Whole launch config; the profile is looked up by `role.launch_profile`. */
  readonly launch: LaunchConfig;
  readonly mcp: AssignmentMcpEndpoint;
  /** `<CARDIGAN_DATA_DIR>/runs/<assignment_id>/`; outside the worktree. */
  readonly run_dir: string;
  /** Where the CLI starts: the worktree, or the run directory for `none`. */
  readonly work_dir: string;
  /**
   * C-235: the host-verified canonical (realpath) form of a worktree
   * `work_dir`, i.e. the exact key pi 1.4 looks up in `trust.json`
   * (`canonicalizePath(resolvePath(cwd))`). Set only when the worktree leaf
   * itself is not a symlink; without it pi gets no pre-trust (fail closed).
   * The compiler cannot check the filesystem, so only the host may set it,
   * and only from `piTrustedWorktreePath(work_dir)` in `@cardigan/host`.
   */
  readonly work_dir_real?: string;
  /** Host-selected base clone containing the worktree's common .git directory. */
  readonly repository_root?: string;
  /** P2a-3: a readonly verifier's writable build checkout (outside the worktree). */
  readonly build_dir?: string;
  /** First message the agent receives (a bell-shaped prompt, M2 §4 step 7). */
  readonly first_prompt: string;
  /** Values from `secrets.env`, keyed by secret name. */
  readonly secrets: Readonly<Record<string, string>>;
  /** CPU niceness increment for the Agent and its children; defaults to 10. */
  readonly agent_nice?: number;
  /** Non-secret project tool variables from the selected private worker binding. */
  readonly worker_env?: Readonly<Record<string, string>>;
  /** Host policy for local employee sessions, never a project setting. */
  readonly resource_bindings?: readonly {
    key: string;
    generation: string;
    port?: number;
    device?: string;
  }[];
  /**
   * C-679: this Run's own adb server port and, with the emulator, console
   * port. `null`: the machine hands out slots but this Run has none, so adb is
   * disabled. Omitted: the machine does not manage adb ports.
   */
  readonly adb_slot?: {
    readonly slot: number;
    readonly adb_port: number;
    readonly emulator_port?: number;
  } | null;
  readonly test_max_workers?: number;
  /** Employee self-tests must not start real hc or end-to-end scenarios. */
  readonly agent_local_tests?: boolean;
  /** Read-only directory of the prebuilt attachment tools on this machine. */
  readonly agent_tools_dir?: string;
  readonly run_resources?: { source: string; target: string };
  /** Remote worker's administrator-preinstalled, non-replaceable lock inode. */
  readonly worker_test_lock?: { path: string; python: string; helper: string };
  /** Trusted worker wrapper; material and persistent session homes are separate. */
  readonly worker_launch?: {
    readonly command: readonly string[];
    readonly session_dir: string;
  };
}

export interface CompiledAssignmentLaunch {
  readonly harness: Harness;
  readonly role_id: string;
  readonly profile: string;
  /** Command `launch.sh` starts, e.g. `claude`. */
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Non-secret environment for the CLI. Provider credentials are NOT here (see
   * `secret_env`); the MCP token is added by `launch.sh` at runtime.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Provider credentials taken from `secrets.env`. They are written only to the
   * run directory's `secrets.env` (0600), which `launch.sh` sources and deletes
   * before starting the CLI. Callers must not print them, log them, or copy
   * them anywhere else (§10.2, §14).
   */
  readonly secret_env: Readonly<Record<string, string>>;
  /** Everything the host writes, including `launch.sh`. */
  readonly files: readonly CompiledFile[];
  /** The wrapper the runtime starts. */
  readonly launch_script: string;
  /** Token file the wrapper consumes; the host creates it right before starting. */
  readonly token_file: string;
  /** `mcp__card__whoami` style names, for the harness allow-list. */
  readonly mcp_tool_names: readonly string[];
  /** Whether the local browser MCP server was configured for this launch. */
  readonly browser: boolean;
}

export interface BrowserServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
