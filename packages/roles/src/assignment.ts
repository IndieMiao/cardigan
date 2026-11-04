import { join } from "node:path";
import {
  type CompiledFile,
  type CompiledLaunch,
  compileLaunch,
} from "./compile.js";
import type { Harness } from "./harness.js";
import type { LaunchConfig, LaunchProfileDefinition } from "./schema.js";

/**
 * Compile "start this Assignment" on top of the M1.8 launch compiler.
 *
 * The result is pure data: the CLI command, its arguments, environment, and the
 * files the host must write into the assignment's run directory. Nothing here
 * touches the filesystem, and no file ever contains the Assignment's MCP token:
 * the host writes it to `<run_dir>/token`, and `launch.sh` reads that file, deletes
 * it, and exports `MCP_TOKEN` (§10.2, §14, M2 plan §3).
 *
 * The input types are declared here on purpose: M2.4 must not depend on the
 * domain types that M2.1 introduces.
 */

export const MCP_SERVER_NAME = "card";
export const TOKEN_ENV_VAR = "MCP_TOKEN";
/** The token file the wrapper reads and removes before starting the CLI. */
export const TOKEN_FILE_NAME = "token";
export const LAUNCH_SCRIPT_NAME = "launch.sh";
/** Provider credentials for one launch; sourced and deleted by `launch.sh`. */
export const SECRETS_FILE_NAME = "secrets.env";

export interface AssignmentRoleInput {
  readonly role_id: string;
  readonly harness: Harness;
  /** Name of the launch profile in `launch.yaml` (§10.2). */
  readonly launch_profile: string;
  /** Full Core Prompt; §6.3's protocol must be part of it. */
  readonly core_prompt: string;
  /** Card MCP tools this role may call; the CLI allow-list is derived from it. */
  readonly allowed_tools: readonly string[];
  /** `none` roles (PM) run in the run directory instead of a worktree. */
  readonly worktree: "none" | "write" | "readonly";
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
}

export interface CompileAssignmentInput {
  readonly assignment: AssignmentIdentity;
  readonly role: AssignmentRoleInput;
  /** Whole launch config; the profile is looked up by `role.launch_profile`. */
  readonly launch: LaunchConfig;
  readonly mcp: AssignmentMcpEndpoint;
  /** `<CARDIGAN_DATA_DIR>/runs/<assignment_id>/`; outside the worktree. */
  readonly run_dir: string;
  /** Where the CLI starts: the worktree, or the run directory for `none`. */
  readonly work_dir: string;
  /** First message the agent receives (a bell-shaped prompt, M2 §4 step 7). */
  readonly first_prompt: string;
  /** Values from `secrets.env`, keyed by secret name. */
  readonly secrets: Readonly<Record<string, string>>;
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
}

export function compileAssignmentLaunch(
  input: CompileAssignmentInput,
): CompiledAssignmentLaunch {
  const serverName = input.mcp.server_name ?? MCP_SERVER_NAME;
  const tokenFile = join(input.run_dir, TOKEN_FILE_NAME);
  const coreFile = join(input.run_dir, "core.md");
  const firstFile = join(input.run_dir, "first.md");
  const launchScript = join(input.run_dir, LAUNCH_SCRIPT_NAME);

  const base = compileLaunch({
    config: input.launch,
    profile: input.role.launch_profile,
    secrets: input.secrets,
    runtimeDir: input.run_dir,
    instanceId: "assignment",
  });

  if (base.harness !== input.role.harness) {
    throw new Error(
      `Role ${input.role.role_id} uses ${input.role.harness} but profile ${input.role.launch_profile} launches ${base.harness}`,
    );
  }

  const toolNames = input.role.allowed_tools.map(
    (tool) => `mcp__${serverName}__${tool}`,
  );

  const harnessFiles: CompiledFile[] = [];
  const harnessEnv: Record<string, string> = {};
  const harnessArgs: string[] = [];

  switch (input.role.harness) {
    case "claude-code":
      // §M2.4: strict MCP config, explicit Card tool allow-list, Core Prompt file.
      harnessFiles.push({
        path: join(input.run_dir, "mcp.json"),
        content: `${JSON.stringify(
          {
            mcpServers: {
              [serverName]: {
                type: "http",
                url: input.mcp.url,
                headers: { Authorization: `Bearer \${${TOKEN_ENV_VAR}}` },
              },
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
      if (toolNames.length > 0) {
        harnessArgs.push("--allowedTools", toolNames.join(","));
      }
      // Agents never update themselves mid-run.
      harnessEnv.DISABLE_AUTOUPDATER = "1";
      break;

    case "codex":
      // Codex reads config.toml from CODEX_HOME; the file holds no credentials,
      // only the environment variable name.
      harnessFiles.push({
        path: join(input.run_dir, "codex", "config.toml"),
        content: codexConfig(
          serverName,
          input.mcp.url,
          input.role.allowed_tools,
          coreFile,
        ),
        mode: 0o600,
      });
      harnessEnv.CODEX_HOME = join(input.run_dir, "codex");
      break;

    case "pi":
      // Pi reads mcp.json from its agent directory and takes the prompt as a
      // path (verified in 0.4 §3).
      harnessFiles.push({
        path: join(input.run_dir, "pi", "mcp.json"),
        content: `${JSON.stringify(
          {
            mcpServers: {
              [serverName]: {
                url: input.mcp.url,
                headers: { Authorization: `Bearer \${${TOKEN_ENV_VAR}}` },
              },
            },
          },
          null,
          2,
        )}\n`,
        mode: 0o600,
      });
      harnessEnv.PI_CODING_AGENT_DIR = join(input.run_dir, "pi");
      harnessArgs.push("--append-system-prompt", coreFile);
      break;
  }

  const args = [...base.args, ...harnessArgs];
  const command = base.command;

  // Provider credentials never travel in `env` or in a long-lived file: they go
  // to `secrets.env` (0600), which launch.sh sources and deletes before exec.
  const secretKeys = new Set(base.secretEnvKeys);
  const env: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...base.env, ...harnessEnv })) {
    if (secretKeys.has(name)) secretEnv[name] = value;
    else env[name] = value;
  }
  // Claude Code keeps provider settings in its settings file instead of the
  // process environment, so collect those credentials from the file too.
  for (const file of base.files) {
    let parsed: { env?: Record<string, string> };
    try {
      parsed = JSON.parse(file.content) as { env?: Record<string, string> };
    } catch {
      continue;
    }
    for (const [name, value] of Object.entries(parsed.env ?? {})) {
      if (secretKeys.has(name) && secretEnv[name] === undefined) {
        secretEnv[name] = value;
      }
    }
  }
  const strippedBaseFiles = base.files.map((file) => {
    if (secretKeys.size === 0) return file;
    try {
      const parsed = JSON.parse(file.content) as {
        env?: Record<string, string>;
      };
      if (parsed.env === undefined) return file;
      const keptEnv = Object.fromEntries(
        Object.entries(parsed.env).filter(([name]) => !secretKeys.has(name)),
      );
      return {
        ...file,
        content: `${JSON.stringify({ ...parsed, env: keptEnv }, null, 2)}\n`,
      };
    } catch {
      return file;
    }
  });
  const secretsFile = join(input.run_dir, SECRETS_FILE_NAME);
  const secretsFiles: CompiledFile[] =
    Object.keys(secretEnv).length === 0
      ? []
      : [
          {
            path: secretsFile,
            content: secretsFileContent(secretEnv),
            mode: 0o600,
          },
        ];

  return {
    harness: input.role.harness,
    role_id: input.role.role_id,
    profile: base.profile,
    command,
    args,
    env,
    secret_env: secretEnv,
    files: [
      {
        path: coreFile,
        content: withTrailingNewline(input.role.core_prompt),
        mode: 0o600,
      },
      {
        path: firstFile,
        content: withTrailingNewline(input.first_prompt),
        mode: 0o600,
      },
      ...strippedBaseFiles,
      ...harnessFiles,
      ...secretsFiles,
      {
        path: launchScript,
        content: launchScriptContent({
          tokenFile,
          firstPromptFile: firstFile,
          secretsFile: secretsFiles.length === 0 ? undefined : secretsFile,
          command,
          args,
          env,
        }),
        mode: 0o700,
      },
    ],
    launch_script: launchScript,
    token_file: tokenFile,
    mcp_tool_names: toolNames,
  };
}

function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * `config.toml` for Codex: the Card server with an env-var token reference and
 * per-tool approval, plus the Core Prompt as the model instruction file.
 * `model_instructions_file` replaces Codex's own instructions, so the Core
 * Prompt carries the full protocol (§M2.4).
 */
function codexConfig(
  serverName: string,
  url: string,
  tools: readonly string[],
  coreFile: string,
): string {
  const lines = [
    `model_instructions_file = ${JSON.stringify(coreFile)}`,
    "",
    "[features]",
    "shell_tool = true",
    "",
    `[mcp_servers.${serverName}]`,
    `url = ${JSON.stringify(url)}`,
    `bearer_token_env_var = ${JSON.stringify(TOKEN_ENV_VAR)}`,
    "",
  ];
  for (const tool of tools) {
    lines.push(
      `[mcp_servers.${serverName}.tools.${tool}]`,
      'approval_mode = "approve"',
      "",
    );
  }
  return `${lines.join("\n")}`;
}

/**
 * The wrapper the runtime starts. It reads the token file, deletes it, exports
 * `MCP_TOKEN`, and replaces itself with the CLI so signals and the exit code
 * pass through unchanged. The token is never written into this script.
 */
function launchScriptContent(options: {
  readonly tokenFile: string;
  readonly firstPromptFile: string;
  readonly secretsFile: string | undefined;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}): string {
  const quote = (value: string): string =>
    `'${value.replaceAll("'", `'\\''`)}'`;
  const exports = Object.entries(options.env)
    .map(([name, value]) => `export ${name}=${quote(value)}`)
    .join("\n");
  const args = options.args.map(quote).join(" ");
  const credentials =
    options.secretsFile === undefined
      ? ""
      : `secrets_file=${quote(options.secretsFile)}
if [ ! -f "$secrets_file" ]; then
  echo "cardigan: secrets file is missing: $secrets_file" >&2
  exit 78
fi
# Source with export-all, then delete the credentials before the CLI starts.
set -a
. "$secrets_file"
set +a
rm -f "$secrets_file"
`;
  return `#!/bin/sh
# Generated by Cardigan. Reads the Assignment token and provider credentials,
# deletes both files, then starts the agent CLI. No credential is written here.
set -eu
token_file=${quote(options.tokenFile)}
if [ ! -f "$token_file" ]; then
  echo "cardigan: token file is missing: $token_file" >&2
  exit 78
fi
MCP_TOKEN=$(cat "$token_file")
rm -f "$token_file"
if [ -z "$MCP_TOKEN" ]; then
  echo "cardigan: token file is empty" >&2
  exit 78
fi
export MCP_TOKEN
${credentials}${exports}
# The first task message is the last positional argument: claude, codex and pi
# all start an interactive session with one (see the harness table below). It is
# read here, never embedded in this script, and kept verbatim: the x sentinel
# preserves trailing newlines that command substitution would otherwise drop.
first_file=${quote(options.firstPromptFile)}
if [ ! -f "$first_file" ]; then
  echo "cardigan: first prompt file is missing: $first_file" >&2
  exit 78
fi
first_message=$(cat "$first_file"; printf x)
first_message=\${first_message%x}
exec ${quote(options.command)}${args ? ` ${args}` : ""} "$first_message"
`;
}

/** `NAME='value'` lines, safe to source; the file is deleted by launch.sh. */
function secretsFileContent(secrets: Readonly<Record<string, string>>): string {
  const quote = (value: string): string =>
    `'${value.replaceAll("'", `'\\''`)}'`;
  return `${Object.entries(secrets)
    .map(([name, value]) => `${name}=${quote(value)}`)
    .join("\n")}\n`;
}

export type { CompiledLaunch, LaunchProfileDefinition };
