import { join } from "node:path";
import {
  contextUsageThresholds,
  employeeDisplayName,
  HARNESS_CATALOG,
} from "@cardigan/domain";
import {
  BROWSER_MCP_SERVER_NAME,
  BROWSER_TOOL_PATTERN,
  MCP_SESSION_HEADER,
  TOKEN_ENV_VAR,
} from "../assignment-types.js";
import { DEFAULT_MCP_BRIDGE_PYTHON } from "../mcp-bridge.js";
import { readClaudeContext } from "./claude-context.js";
import { claudeStatusLineSetting, relayHostname } from "./claude-statusline.js";
import { CLAUDE_TRUST_SCRIPT } from "./claude-trust.js";
import { plain } from "./effort.js";
import { onlyKey } from "./provider.js";
import type { HarnessAdapter } from "./types.js";
export const claudeCode: HarnessAdapter = {
  ...HARNESS_CATALOG["claude-code"],
  probeCredential(p) {
    return onlyKey(
      Object.keys(p.secret_env).filter(
        (k) => k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN",
      ),
    );
  },
  endpointEnvKey() {
    return "ANTHROPIC_BASE_URL";
  },
  validateRoute(at, provider, _name, details) {
    if (provider.api && provider.api !== "anthropic-messages")
      details.push(`${at}.api 与 harness.claude-code 不兼容`);
  },
  normalizeProfile({ profile }) {
    if (profile.effort)
      profile.args = ["--effort", profile.effort, ...(profile.args ?? [])];
  },
  versionArgs: ["--version"],
  contextSource: "claude_transcript:last_usage",
  listsMcpToolsAtStartup: true,
  readContext: readClaudeContext,
  compile({ input, resolved, providerEnv, secretEnv, profileArgs, extraArgs }) {
    // Claude Code reads provider settings from a settings file. Cardigan writes
    // that file outside the repository, with 0600, and deletes it after exit.
    // Provider env (including resolved secrets) lives in the file, not in the
    // process environment, so the gateway token is not visible in `ps e`.
    // `<pid>-<random>` in the name keeps concurrent launches apart, and lets
    // the next launch find files left behind by a process that no longer runs.
    const settingsPath = join(
      input.runtimeDir,
      `cardigan-${input.instanceId ?? "static"}.${resolved.name}.claude-settings.json`,
    );
    const settings = {
      env: { ...providerEnv, ...secretEnv },
    };

    const args: string[] = ["--settings", settingsPath];
    if (resolved.profile.model !== undefined) {
      args.push("--model", resolved.profile.model);
    }
    if (resolved.profile.permission_mode !== undefined) {
      args.push("--permission-mode", resolved.profile.permission_mode);
    }
    args.push(...profileArgs, ...extraArgs);

    const env: Record<string, string> = {};
    if (resolved.profile.auto_update === false) {
      env.DISABLE_AUTOUPDATER = "1";
    }

    return {
      harness: "claude-code",
      profile: resolved.name,
      command: this.binary,
      args,
      env,
      files: [
        {
          path: settingsPath,
          content: `${JSON.stringify(settings, null, 2)}\n`,
          mode: 0o600,
        },
      ],
      secretEnvKeys: Object.keys(secretEnv),
    };
  },
  configureAssignment({
    input,
    sessionDir,
    coreFile,
    serverName,
    browser,
    toolNames,
    harnessEnv,
    harnessArgs,
    harnessFiles,
  }) {
    // §M2.4: strict MCP config, explicit Card tool allow-list, Core Prompt file.
    harnessFiles.push({
      path: join(input.run_dir, "mcp.json"),
      content: `${JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              type: "http",
              url: input.mcp.url,
              headers: {
                Authorization: `Bearer \${${TOKEN_ENV_VAR}}`,
                ...(input.mcp.session_key
                  ? { [MCP_SESSION_HEADER]: input.mcp.session_key }
                  : {}),
              },
            },
            ...(browser === undefined
              ? {}
              : {
                  [BROWSER_MCP_SERVER_NAME]: {
                    type: "stdio",
                    command: browser.command,
                    args: browser.args,
                    env: browser.env,
                  },
                }),
          },
        },
        null,
        2,
      )}\n`,
      mode: 0o600,
    });
    harnessArgs.push(
      "--strict-mcp-config",
      "--mcp-config",
      join(input.run_dir, "mcp.json"),
      "--append-system-prompt-file",
      coreFile,
    );
    if (toolNames.length > 0 || browser !== undefined) {
      harnessArgs.push(
        "--allowedTools",
        [
          ...toolNames,
          ...(browser === undefined ? [] : [BROWSER_TOOL_PATTERN]),
        ].join(","),
      );
    }
    // Agents never update themselves mid-run.
    harnessEnv.DISABLE_AUTOUPDATER = "1";
    harnessEnv.CLAUDE_CONFIG_DIR = join(sessionDir, "claude");
    // --allowedTools is variadic: protect the positional first message.
    harnessArgs.push("--");
  },
  effortFromArgs(args) {
    let effort: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? "";
      if (arg === "--") break;
      if (arg === "--effort") {
        effort = plain(args[index + 1]);
        index += 1;
      } else if (arg.startsWith("--effort="))
        effort = plain(arg.slice("--effort=".length));
    }
    return effort;
  },
  useStatuslineCache: true,
  allowWorktreeDescendant: true,
  assignmentSettings: { autoMemoryEnabled: false },
  assignmentSettingsFor(input, env) {
    // C-686: the same interpreter the worker already runs Cardigan helpers with.
    const python = input.mcp.bridge_python ?? DEFAULT_MCP_BRIDGE_PYTHON;
    if (!python.startsWith("/") && python !== "python3")
      throw new Error("Status line interpreter must be an absolute path");
    const name = input.employee?.identity?.name;
    const relay = relayHostname(env.ANTHROPIC_BASE_URL);
    const { card_id, work_item_id } = input.assignment;
    const defaults = contextUsageThresholds();
    return {
      statusLine: claudeStatusLineSetting(python, {
        ...(name ? { employee: employeeDisplayName(name) } : {}),
        assignment: input.assignment.assignment_id,
        role: input.role.role_id,
        ...(card_id ? { card: card_id } : {}),
        ...(work_item_id ? { work_item: work_item_id } : {}),
        run: input.assignment.run_id,
        ...(input.status_line?.base_ref
          ? { base_ref: input.status_line.base_ref }
          : {}),
        handoff_remaining_pct:
          input.status_line?.handoff_remaining_pct ?? defaults.handoff,
        restart_remaining_pct:
          input.status_line?.restart_remaining_pct ?? defaults.restart,
        ...(relay ? { relay } : {}),
      }),
    };
  },
  localSetup(input, quote) {
    const python = input.mcp.bridge_python ?? DEFAULT_MCP_BRIDGE_PYTHON;
    if (!python.startsWith("/") && python !== "python3")
      throw new Error("Claude trust interpreter must be an absolute path");
    return `# Session state belongs to this Assignment, not to the user's home.
claude_config_dir=${quote(join(input.run_dir, "claude"))}
if [ ! -e "$claude_config_dir" ] && [ ! -L "$claude_config_dir" ]; then
  (umask 077; mkdir -m 700 -- "$claude_config_dir")
fi
if [ -L "$claude_config_dir" ] || [ ! -d "$claude_config_dir" ] || [ ! -O "$claude_config_dir" ]; then
  echo "cardigan: Claude config directory must be a directory owned by the running user, not a symlink" >&2
  exit 78
fi
# The extra leading zero clears inherited setgid on shared run directories.
chmod 00700 -- "$claude_config_dir"
# C-823: on every launch (new, resumed or replaced session) trust the exact
# cwd in the Run's own Claude state, keeping everything else it holds; the
# first launch also seeds onboarding, theme and bypass confirmation.
${quote(python)} -IB -c ${quote(CLAUDE_TRUST_SCRIPT)} "$claude_config_dir" ${quote(input.work_dir)}
`;
  },
};
