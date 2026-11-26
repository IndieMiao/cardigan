import { gitSafetyArguments } from "./hardening.js";

export interface CandidatePushRequest {
  readonly repo: string;
  readonly sha: string;
  /** Full ref, deliberately narrower than the existing main publication API. */
  readonly ref: string;
  readonly token: string;
  readonly signal?: AbortSignal;
}
/** No force flag, URL credentials, disk helper, ambient credentials or redirect. */
export function candidatePushCommand(
  repository: string,
  input: CandidatePushRequest,
) {
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u.test(input.repo) ||
    input.repo
      .split("/")
      .some((part) => part === "." || part === ".." || part.endsWith(".git")) ||
    !/^[a-f0-9]{40}$/u.test(input.sha) ||
    !/^refs\/heads\/ci\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u.test(
      input.ref,
    ) ||
    // Q-661: keep the same local boundary as the installation token exchange.
    !/^[A-Za-z0-9_.-]{1,2048}$/u.test(input.token)
  )
    throw new Error("Invalid candidate push");
  return {
    args: [
      ...gitSafetyArguments,
      "-c",
      "protocol.https.allow=always",
      "-c",
      "credential.helper=",
      "-c",
      "http.followRedirects=false",
      "-c",
      "push.followTags=false",
      "-c",
      "push.gpgSign=false",
      "-C",
      repository,
      "push",
      "--porcelain",
      "--",
      `https://github.com/${input.repo}.git`,
      `${input.sha}:${input.ref}`,
    ],
    // Git's environment config avoids putting the bearer value in argv, files,
    // callbacks or error messages. The transport never returns the raw error.
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`,
    },
  };
}

/**
 * C-758: why a candidate publication did not reach GitHub. `cancelled` is a
 * local abort, `timeout` the host transfer budget, `local` a failure before
 * Git transport started. Only `network` means GitHub could not be reached;
 * `auth`, `rejected` and `github_error` are answers from GitHub.
 */
export type CandidatePushFailure =
  | "cancelled"
  | "timeout"
  | "local"
  | "network"
  | "auth"
  | "rejected"
  | "github_error"
  | "other";
export type CandidatePushResult =
  | { readonly status: "pushed" }
  | {
      readonly status: "failed";
      readonly reason: CandidatePushFailure;
      /** The numeric process exit status, when available; never raw diagnostics. */
      readonly exit_code?: number;
    };
/** Git HTTPS output is inspected in memory only; no raw text leaves the transport. */
export function classifyCandidatePushFailure(
  output: string,
): "network" | "auth" | "rejected" | "github_error" | "other" {
  if (
    /Authentication failed|Invalid username or (?:password|token)|returned error: 40[13]\b|Permission to \S+ denied|Bad credentials/iu.test(
      output,
    )
  )
    return "auth";
  if (
    /non-fast-forward|fetch first|\[rejected\]|\[remote rejected\]|returned error: 4\d\d\b/iu.test(
      output,
    )
  )
    return "rejected";
  if (
    /returned error: 5\d\d\b|Internal Server Error|Service Unavailable|Bad Gateway|Gateway Time-?out/iu.test(
      output,
    )
  )
    return "github_error";
  if (
    /Could not resolve|Failed to connect|Connection (?:timed out|refused|reset|closed)|Network is unreachable|No route to host|remote end hung up|unexpected disconnect|early EOF|Operation timed out|SSL|TLS|RPC failed|Recv failure|Send failure|stream \d+ was not closed cleanly|Empty reply from server/iu.test(
      output,
    )
  )
    return "network";
  return "other";
}
