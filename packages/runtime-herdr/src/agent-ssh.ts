import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { checkLockName } from "./agent-files.js";
import { fail, type HcClient } from "./client.js";
import { type ExecutionConfig, shellQuote } from "./execution.js";
import { isHcVersionCompatible, warnIfHcUntested } from "./hc-version.js";
import { MACOS_CORE_SCRIPT } from "./macos-core.js";

type AgentConfig = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
export const AGENT_PATH =
  "/var/lib/cardigan-agent/.local/bin:/usr/local/bin:/usr/bin:/bin";
export function validateSshConfig(config: AgentConfig) {
  for (const [name, value] of [
    ["host", config.host],
    ["user", config.user],
    ["hostKeyAlias", config.hostKeyAlias],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(value) &&
          !(
            name !== "user" &&
            /^[a-fA-F0-9:.]+$/u.test(value) &&
            isIP(value) === 6
          )))
    )
      fail("invalid_launch", `Invalid SSH ${name}`);
  }
  if (
    config.port !== undefined &&
    (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  )
    fail("invalid_launch", "SSH port must be an integer from 1 to 65535");
  // -i and -o values expand %-tokens and ${VAR}; -o values have their own
  // parser. Require one literal absolute path, not a list or expanded name.
  if (!literalPath(config.knownHostsFile))
    fail("invalid_launch", "Invalid SSH known_hosts path");
  if (!literalPath(config.identityFile))
    fail("invalid_launch", "Invalid SSH identity path");
  // agentRoot is joined into remote commands (pack services, check listing):
  // the literal-path rule plus merge-gate.yaml's agent_root charset, and
  // normalized so the joined path is the checked one.
  if (
    !literalPath(config.agentRoot) ||
    !/^\/[A-Za-z0-9._/-]+$/u.test(config.agentRoot) ||
    posix.normalize(config.agentRoot) !== config.agentRoot ||
    config.agentRoot.endsWith("/")
  )
    fail("invalid_launch", "Invalid SSH agent root path");
  if (
    config.path !== undefined &&
    !config.path
      .split(":")
      .every(
        (p) =>
          literalPath(p) &&
          posix.normalize(p) === p &&
          /^\/[A-Za-z0-9._/-]+$/u.test(p),
      )
  )
    fail("invalid_launch", "Invalid SSH executable path");
}
/**
 * One literal absolute non-root path: no whitespace, control/format
 * characters, quotes, backslashes or the `%` / `$` expansions of ssh.
 */
function literalPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    resolve(value) !== "/" &&
    !/[\s\p{Cc}\p{Cf}"'\\%$]/u.test(value)
  );
}
function sshArguments(config: AgentConfig): string[] {
  validateSshConfig(config);
  return [
    "-F",
    "/dev/null",
    "-T",
    "-i",
    config.identityFile,
    ...[
      "BatchMode=yes",
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "StrictHostKeyChecking=yes",
      `UserKnownHostsFile=${config.knownHostsFile}`,
      "GlobalKnownHostsFile=/dev/null",
      `HostKeyAlias=${config.hostKeyAlias ?? "cardigan-agent-local"}`,
      "HostKeyAlgorithms=ssh-ed25519",
      "ConnectTimeout=10",
    ].flatMap((option) => ["-o", option]),
    ...(config.port === undefined ? [] : ["-p", String(config.port)]),
    "--",
    `${config.user ?? "agent"}@${config.host ?? "localhost"}`,
  ];
}
export function agentSshCommand(config: AgentConfig): string {
  return [
    "ssh",
    ...sshArguments(config),
    "env",
    `PATH=${config.path ?? AGENT_PATH}`,
  ]
    .map(shellQuote)
    .join(" ");
}
/** Fixed macOS connect entry. hc's appended remote command is intentionally
 * unused: it may autostart/install through an environment we have not checked.
 * Linux retains its original hc --via command byte for byte.
 */
export function agentCoreCommand(config: AgentConfig, session: string): string {
  if (!config.macosCore) return agentSshCommand(config);
  const { python, retiredLaunchdLabel } = config.macosCore;
  if (
    !literalPath(python) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(retiredLaunchdLabel) ||
    !/^[A-Za-z0-9_-]{1,48}$/u.test(session) ||
    !config.user
  )
    fail("invalid_launch", "Invalid macOS core configuration");
  const remote = [
    'test -n "$SSH_CONNECTION" && exec env -i',
    shellQuote(`PATH=${config.path ?? AGENT_PATH}`),
    'HOME="$HOME" SSH_CONNECTION="$SSH_CONNECTION" HC_RUNTIME=1',
    ...[
      python,
      "-I",
      "-B",
      "-c",
      // hc validates --via before invoking the shell: its target cannot contain
      // any control character, including the Python source's newlines.
      `import base64;exec(base64.b64decode('${Buffer.from(MACOS_CORE_SCRIPT).toString("base64")}'))`,
      session,
      retiredLaunchdLabel,
      config.user,
    ].map(shellQuote),
  ].join(" ");
  const command = ["ssh", ...sshArguments(config), remote]
    .map(shellQuote)
    .join(" ");
  return ["sh", "-c", `exec ${command}`, "sh"].map(shellQuote).join(" ");
}
/** A streaming, credential-checked entry; the caller supplies an explicit environment. */
export async function agentProcessCommand(
  config: AgentConfig,
  args: readonly string[],
  options?: { readonly workerRuntimeDir: true },
) {
  await checkAgentFiles(config);
  return {
    file: "ssh",
    args: [
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=3",
      ...sshArguments(config),
      [
        ...["env", "-i", `PATH=${config.path ?? AGENT_PATH}`].map(shellQuote),
        // This one variable comes from the selected worker login (not the
        // controller). Keep it one literal env argument, even if empty.
        ...(options?.workerRuntimeDir
          ? ['"XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"']
          : []),
        ...args.map(shellQuote),
      ].join(" "),
    ],
  };
}
export async function registerAgentMachine(
  client: HcClient,
  config: AgentConfig,
  session: string,
  version: string,
) {
  await checkAgentFiles(config);
  const target = agentCoreCommand(config, session);
  const listing = JSON.parse(await client.exec(["machine", "ls", "--json"]));
  if (!Array.isArray(listing.machines))
    fail("runtime_unavailable", "Invalid hc machine list");
  const existing = listing.machines.find(
    (m: { name: string }) => m.name === config.machine,
  );
  if (
    existing &&
    (existing.target !== target ||
      existing.via !== true ||
      existing.session !== session)
  )
    fail(
      "invalid_launch",
      "Configured hc machine already points to another SSH endpoint",
    );
  const machine =
    existing ??
    JSON.parse(
      await client.exec([
        "machine",
        "add",
        "--name",
        config.machine,
        "--session",
        session,
        "--via",
        target,
        "--json",
      ]),
    );
  // hc checks the remote generation on machine.add/connect. Preserve existing aliases.
  if (!isHcVersionCompatible(machine.version, version))
    fail("version_mismatch", "Agent account hc version is unsupported");
  warnIfHcUntested(machine.version);
}

async function checkAgentFiles(config: AgentConfig) {
  validateSshConfig(config);
  if (process.platform !== "linux")
    fail("invalid_launch", "agent-ssh currently requires Linux");
  for (const path of [config.identityFile, config.knownHostsFile]) {
    const entry = await lstat(path);
    if (
      !entry.isFile() ||
      entry.uid !== process.getuid?.() ||
      (entry.mode & 0o777) !== 0o600
    )
      fail(
        "invalid_launch",
        "SSH credential files must be host-owned regular files with mode 0600",
      );
  }
}
/** captureAgent returns text; reuse the pinned SSH entry for Git's bidirectional binary stream. */
export async function agentUploadPack(
  config: AgentConfig,
  repository: string,
): Promise<string> {
  return agentPack(config, repository, "upload-pack");
}
export async function agentReceivePack(
  config: AgentConfig,
  repository: string,
): Promise<string> {
  return agentPack(config, repository, "receive-pack");
}
async function agentPack(
  config: AgentConfig,
  repository: string,
  service: "upload-pack" | "receive-pack",
): Promise<string> {
  // Validate agentRoot before it is used to bound the repository path.
  if (config.mode === "agent-ssh") validateSshConfig(config);
  if (
    config.mode !== "agent-ssh" ||
    !isAbsolute(repository) ||
    dirname(resolve(repository)) !== join(config.agentRoot, "repos")
  )
    fail(
      "invalid_launch",
      "Git pack service requires a configured Agent base repository",
    );
  await checkAgentFiles(config);
  const remote = `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c ${shellQuote(`safe.directory=${repository}`)} -c core.hooksPath=/dev/null -c transfer.fsckObjects=true ${service} -- ${shellQuote(repository)}`;
  // Ignore Git's appended path; the command is bound to the host-selected repository.
  return `sh -c ${shellQuote(`exec ${agentSshCommand(config)} ${shellQuote(remote)}`)} --`;
}

/** Read-only listing of one project's merge-check directories on an executor. */
export interface AgentCheckListing {
  /** Existing `<agentRoot>/checks/<project>/<attempt>/worktree` directories. */
  readonly directories: readonly string[];
  /** Worktrees registered in the executor's base clone below the checks root. */
  readonly registered: readonly string[];
}
export type AgentListRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ readonly code: number | null; readonly stdout: Buffer }>;
const LIST_SCRIPT = [
  "set -u",
  // present PATH CODE: 0 for a real directory, 1 only when absence is
  // confirmed (a searchable parent or agent root shows the name missing);
  // anything unknown (EACCES, symlink, wrong type) exits with CODE.
  "present() {",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX sh parameter expansion.
  "  p=$1; parent=${p%/*}; root=${parent%/*}",
  '  if [ -L "$p" ]; then exit "$2"; fi',
  '  if [ -d "$p" ]; then return 0; fi',
  '  if [ -d "$parent" ] && [ ! -L "$parent" ] && [ -x "$parent" ] && [ ! -e "$p" ]; then return 1; fi',
  '  if [ -d "$root" ] && [ -x "$root" ] && [ ! -e "$parent" ] && [ ! -L "$parent" ]; then return 1; fi',
  '  exit "$2"',
  "}",
  'if present "$1" 3; then find "$1" -mindepth 2 -maxdepth 2 -name worktree -type d -print0 || exit 3; fi',
  "printf '%s\\0' --",
  'if present "$2" 4; then git -c "safe.directory=$2" -c core.hooksPath=/dev/null -C "$2" worktree list --porcelain -z || exit 4; fi',
  "printf '%s\\0' --end",
].join("\n");
const runListing: AgentListRunner = (file, args, timeoutMs) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolvePromise({ code, stdout: Buffer.concat(chunks) }),
    );
  });
/**
 * P2a-12 C: list a project's check directories over the executor's pinned SSH
 * entry. Any failure (connection, permission, truncated output) throws: the
 * caller must report "unreachable", never treat it as an empty directory.
 */
export async function agentListChecks(
  config: AgentConfig,
  project: string,
  options: { readonly run?: AgentListRunner; readonly timeoutMs?: number } = {},
): Promise<AgentCheckListing> {
  if (
    config.mode !== "agent-ssh" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project)
  )
    fail("invalid_launch", "Check listing requires an agent-ssh project");
  const checks = posix.join(config.agentRoot, "checks", project),
    clone = posix.join(config.agentRoot, "repos", project);
  const command = await agentProcessCommand(config, [
    "GIT_CONFIG_NOSYSTEM=1",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "sh",
    "-c",
    LIST_SCRIPT,
    "sh",
    checks,
    clone,
  ]);
  const { code, stdout } = await (options.run ?? runListing)(
    command.file,
    command.args,
    options.timeoutMs ?? 60_000,
  );
  const fields = stdout.toString("utf8").split("\0");
  // Complete output ends with the trailer and one empty field after its NUL.
  if (code !== 0 || fields.pop() !== "" || fields.pop() !== "--end")
    fail("runtime_unavailable", "Executor check listing failed");
  const separator = fields.indexOf("--");
  if (separator < 0)
    fail("runtime_unavailable", "Executor check listing failed");
  const below = (path: string) =>
    path.startsWith(`${checks}/`) && posix.normalize(path) === path;
  return {
    directories: fields.slice(0, separator).filter(below).sort(),
    registered: fields
      .slice(separator + 1)
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length))
      .filter(below)
      .sort(),
  };
}

/** C-130: paths an executor prepared for one merge-check attempt. */
export interface AgentCheckPaths {
  /** `<agentRoot>/checks/<project>/<attempt>` */
  readonly container: string;
  /** `<agentRoot>/s/<alias>` */
  readonly alias: string;
  /** `<agentRoot>/<checkLockName(slot)>` when the check is serialized. */
  readonly lock?: string;
}
const CHECK_PROJECT = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u;
const CHECK_ATTEMPT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u;
const CHECK_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/u;
/**
 * Runs as the executor account. There is no host account on a remote
 * executor: the account owns its check namespace (`checks`, `s`), where
 * parents must be real directories (never symlinks) and leaves are created
 * exclusively as 0700. Every path is a positional argument; the script
 * itself is constant.
 *
 * The slot lock is different: mutual exclusion needs one persistent inode
 * that candidate code (running as this account) can never unlink, rename or
 * replace. So the lock is never created here. The operator provisions it,
 * and the lock and every ancestor up to `/` must be neither owned nor
 * writable by the account (a sticky ancestor is fine when the next component
 * is not the account's) — the remote counterpart of the host-owned 2750
 * agent root that protects the local lock (§12.2).
 */
const PREPARE_SCRIPT = [
  "set -u",
  "umask 077",
  "root=$1 project=$2 attempt=$3 alias=$4 lock=$5",
  'foreign() { [ ! -O "$1" ]; }',
  // anchored DIR CHILD: DIR cannot be used by this account to replace CHILD.
  "anchored() {",
  '  [ ! -L "$1" ] && foreign "$1" || return 1',
  '  [ ! -w "$1" ] || { [ -k "$1" ] && [ -n "$2" ] && foreign "$2"; }',
  "}",
  '[ ! -L "$root" ] && [ -d "$root" ] || exit 3',
  'if [ -n "$lock" ]; then',
  '  d=$root c="$root/$lock"',
  "  while :; do",
  '    anchored "$d" "$c" || exit 4',
  '    [ "$d" = / ] && break',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX sh parameter expansion.
  '    c=$d d=${d%/*}; [ -n "$d" ] || d=/',
  "  done",
  // Never created or repaired here: a missing or replaced lock is a start failure.
  '  l="$root/$lock"',
  '  [ -f "$l" ] && [ ! -L "$l" ] && foreign "$l" && [ -r "$l" ] && [ ! -w "$l" ] && [ ! -s "$l" ] || exit 7',
  "fi",
  // The openat equivalent: the working directory pins each validated level,
  // so a concurrent same-account check swapping a level for a symlink cannot
  // redirect what is created below it (C-130#15).
  'cd -P -- "$root" || exit 3',
  "R=$(pwd -P)",
  "exec 3<.",
  // enter NAME: step into an account-owned real child, creating it if missing.
  "enter() {",
  '  [ -L "$1" ] && exit 9',
  '  [ -e "$1" ] || mkdir -m 0700 -- "$1" 2>/dev/null || :',
  "  h=$(pwd -P)",
  '  cd -P -- "$1" 2>/dev/null || exit 9',
  '  [ "$(pwd -P)" = "$h/$1" ] && [ -O . ] || exit 10',
  "}",
  // A check never reuses a previous attempt (same rule as prepareAgentCheckout).
  'enter checks; enter "$project"',
  'mkdir -m 0700 -- "$attempt" || exit 5',
  'cd -P -- /proc/self/fd/3 && [ "$(pwd -P)" = "$R" ] || exit 10',
  "enter s",
  'if ! mkdir -m 0700 -- "$alias"; then',
  // The account can replace the leaf both between mkdir/open and between
  // an identity check/rmdir. No conditional unlink exists here: preserving
  // the failed attempt is safer than deleting an unproven replacement.
  "  exit 5",
  "fi",
  // The returned paths must still resolve to the leaves created above.
  'real() { [ "$(cd -P -- "$1" 2>/dev/null && pwd -P)" = "$2" ]; }',
  'real "$root/checks/$project/$attempt" "$R/checks/$project/$attempt" && real "$root/s/$alias" "$R/s/$alias" || exit 8',
  "printf 'prepared\\n'",
].join("\n");
const CLEANUP_SCRIPT = [
  "set -u",
  "root=$1; shift",
  'R=$(cd -P -- "$root" 2>/dev/null && pwd -P) || exit 6',
  "failed=0",
  // Only empty leaves are removed (the worker removed their contents), and
  // only from the validated parent, never through a swapped intermediate level.
  "for p; do",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX sh parameter expansion.
  "  parent=${p%/*} name=${p##*/}",
  '  [ -e "$parent" ] || [ -L "$parent" ] || continue',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX sh parameter expansion.
  '  ( cd -P -- "$parent" 2>/dev/null && [ "$(pwd -P)" = "$R${parent#"$root"}" ] && [ -O . ] || exit 1',
  '    rmdir -- "$name" 2>/dev/null || { [ ! -e "$name" ] && [ ! -L "$name" ]; } ) || failed=1',
  "done",
  '[ "$failed" = 0 ] || exit 6',
  "printf 'cleaned\\n'",
].join("\n");
function checkPaths(
  config: AgentConfig,
  input: {
    readonly project: string;
    readonly attempt: string;
    readonly alias: string;
    readonly lock?: string;
  },
): AgentCheckPaths {
  // Same rules as prepareAgentCheckout / prepareCheckoutAlias and
  // agentListChecks (C-127); agentRoot is checked by validateSshConfig.
  validateSshConfig(config);
  if (
    !CHECK_PROJECT.test(input.project) ||
    !CHECK_ATTEMPT.test(input.attempt) ||
    !CHECK_ALIAS.test(input.alias)
  )
    fail("invalid_launch", "Invalid executor check path component");
  return {
    container: posix.join(
      config.agentRoot,
      "checks",
      input.project,
      input.attempt,
    ),
    alias: posix.join(config.agentRoot, "s", input.alias),
    ...(input.lock === undefined
      ? {}
      : { lock: posix.join(config.agentRoot, input.lock) }),
  };
}
/**
 * C-130: the SSH command that prepares a merge check's lock, container and
 * alias on the executor itself. The caller must treat any non-zero exit or
 * missing `prepared` trailer as a start failure and never fall back to the host.
 */
export async function agentPrepareCheckCommand(
  config: AgentConfig,
  input: {
    readonly project: string;
    readonly attempt: string;
    readonly alias: string;
    /** Merge-check slot lock to prepare; omitted when not serialized. */
    readonly slot?: number;
  },
) {
  const lock = input.slot === undefined ? undefined : checkLockName(input.slot);
  const paths = checkPaths(config, {
    ...input,
    ...(lock === undefined ? {} : { lock }),
  });
  const command = await agentProcessCommand(config, [
    "sh",
    "-c",
    PREPARE_SCRIPT,
    "sh",
    config.agentRoot,
    input.project,
    input.attempt,
    input.alias,
    lock ?? "",
  ]);
  return { ...command, paths, expect: "prepared\n" };
}
/** C-130: remove the empty container and alias leaves on the executor. */
export async function agentCleanupCheckCommand(
  config: AgentConfig,
  paths: AgentCheckPaths,
) {
  const below = (path: string, area: string, depth: number) => {
    const part = path.slice(config.agentRoot.length + 1).split("/");
    return (
      path.startsWith(`${config.agentRoot}/${area}/`) &&
      posix.normalize(path) === path &&
      part.length === depth &&
      part.every((name) => CHECK_PROJECT.test(name))
    );
  };
  validateSshConfig(config);
  if (!below(paths.container, "checks", 3) || !below(paths.alias, "s", 2))
    fail("invalid_launch", "Invalid executor check path component");
  const command = await agentProcessCommand(config, [
    "sh",
    "-c",
    CLEANUP_SCRIPT,
    "sh",
    config.agentRoot,
    paths.container,
    paths.alias,
  ]);
  return { ...command, expect: "cleaned\n" };
}
