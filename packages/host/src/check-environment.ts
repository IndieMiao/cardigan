export const MIN_REDACTED_ENV_BYTES = 8;

const controlledVariables = new Set([
  "PATH",
  "PWD",
  "HOME",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "CARDIGAN_AFFECTED_PATHS",
  "__proto__",
]);

/** Shared by configuration validation and execution; never copy the host environment. */
export function checkEnvironment(
  input: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const entries = Object.entries(input);
  for (const [key, value] of entries)
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      controlledVariables.has(key) ||
      /^(HC_|CARDIGAN_)/u.test(key) ||
      typeof value !== "string" ||
      value.includes("\0")
    )
      throw new Error("Invalid or reserved check environment variable");
  return Object.fromEntries(entries);
}
