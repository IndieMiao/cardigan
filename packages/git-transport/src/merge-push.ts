import { gitSafetyArguments } from "./hardening.js";

export type PushFailure = "rejected" | "network" | "auth" | "other";
export type PushResult =
  | { readonly status: "pushed" }
  | {
      readonly status: "failed";
      readonly reason: PushFailure;
      /** The numeric process exit status, when available; never raw diagnostics. */
      readonly exit_code?: number;
    };
export interface PushRequest {
  readonly sha: string;
  readonly remote: string;
  readonly branch: string;
  readonly keyFile?: string;
  readonly knownHostsFile?: string;
  readonly signal?: AbortSignal;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** A separate whitelist from workspace Git: the push cannot inherit a host credential agent. */
export function mergePushCommand(repository: string, input: PushRequest) {
  const file = input.remote.startsWith("file://");
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.sha) ||
    !input.branch ||
    /[\s~^:?*[\\]/u.test(input.branch) ||
    [...input.branch].some(
      (c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) === 127,
    ) ||
    input.branch.startsWith("-") ||
    input.branch.includes("..") ||
    input.branch.includes("@{") ||
    input.branch.endsWith(".") ||
    input.branch
      .split("/")
      .some((p) => !p || p.startsWith(".") || p.endsWith(".lock"))
  )
    throw new Error("Invalid push commit or branch");
  if (
    [...input.remote].some(
      (c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) === 127,
    ) ||
    (!file &&
      !/^ssh:\/\/|^(?:[\w.-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*:[^/:]/u.test(
        input.remote,
      ))
  )
    throw new Error("Invalid push transport");
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  if (!file) {
    if (!input.keyFile || !input.knownHostsFile)
      throw new Error("Missing push credentials");
    env.GIT_SSH_COMMAND = [
      "ssh",
      "-F",
      "/dev/null",
      "-i",
      input.keyFile,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "IdentityAgent=none",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile="${input.knownHostsFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "KbdInteractiveAuthentication=no",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "AddKeysToAgent=no",
    ]
      .map(quote)
      .join(" ");
    env.GIT_SSH_VARIANT = "ssh";
  }
  return {
    args: [
      ...gitSafetyArguments,
      "-c",
      `protocol.${file ? "file" : "ssh"}.allow=always`,
      "-c",
      "push.followTags=false",
      "-c",
      "push.gpgSign=false",
      "-C",
      repository,
      "push",
      "--porcelain",
      "--",
      input.remote,
      `${input.sha}:refs/heads/${input.branch}`,
    ],
    env,
  };
}
/** Diagnostics are inspected in memory only. No raw stderr leaves the transport. */
export function classifyPushFailure(
  output: string,
  timedOut = false,
): PushFailure {
  if (
    timedOut ||
    /Could not resolve|Connection (?:timed out|refused|reset|closed)|Network is unreachable|No route to host|remote end hung up|unexpected disconnect|Operation timed out/iu.test(
      output,
    )
  )
    return "network";
  if (
    /Permission denied|Authentication failed|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Could not read from remote repository|Load key|Bad owner or permissions|no such identity/iu.test(
      output,
    )
  )
    return "auth";
  if (
    /non-fast-forward|fetch first|\[rejected\]|\[remote rejected\]/iu.test(
      output,
    )
  )
    return "rejected";
  return "other";
}
