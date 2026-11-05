/** Ignore ambient Git routing/configuration; only explicit local-file transport is enabled. */
export const gitSafetyArguments = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=always",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "transfer.fsckObjects=true",
] as const;
export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}
