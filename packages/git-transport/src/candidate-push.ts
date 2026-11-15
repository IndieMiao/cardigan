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
