/** Shared by configuration validation and execution; never copy the host environment. */
export function checkEnvironment(
  input: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const entries = Object.entries(input);
  for (const [key, value] of entries)
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      /^(PATH|PWD|HOME|TMPDIR|HC_.*|CARDIGAN_.*|XDG_RUNTIME_DIR)$/u.test(key) ||
      typeof value !== "string" ||
      value.includes("\0")
    )
      throw new Error("Invalid or reserved check environment variable");
  return Object.fromEntries(entries);
}
