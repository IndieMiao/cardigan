// The private project binding configures tools, not the account, launch policy,
// credential routing or subprocess loaders. Never include input in diagnostics.
const credential =
  /TOKEN|SECRET|KEY|PASS(?:WORD|WD|PHRASE)|(?:^|_)(?:PASS|PWD|PRIVATE|CERT|ACCESS_ID)(?:_|$)|CREDENTIAL|AUTH|COOKIE|BEARER/u;
const reserved = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "UID",
  "EUID",
  "GID",
  "GROUPS",
  "PPID",
  "SHELL",
  "PWD",
  "OLDPWD",
  "CDPATH",
  "TMP",
  "TEMP",
  "TMPDIR",
  "IFS",
  "ENV",
  "FPATH",
  "ZDOTDIR",
  "SHELLOPTS",
  "SHLVL",
  "PS0",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "PROMPT_COMMAND",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "MANPAGER",
  "BROWSER",
  "LESSOPEN",
  "LESSCLOSE",
  "GCONV_PATH",
  "LOCPATH",
  "GLIBC_TUNABLES",
  "BASHOPTS",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "JAVA_OPTIONS",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "ANDROID_SERIAL",
  "ADB_SERVER_SOCKET",
  "PLAYWRIGHT_BROWSERS_PATH",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
]);
const reservedPattern =
  /^(?:CARDIGAN|HC|HERDR|MCP|SSH|GIT|XDG|LD|DYLD|OPENSSL|LC|BASH|NODE|NPM|PNPM|CODEX|CLAUDE|ANTHROPIC|OPENAI|PI)_|^PYTHON|_PROXY$/u;

/** Canonical, bounded literal data shared by launch and capability probes. */
export function parseWorkerEnvironment(
  input: unknown = {},
): Record<string, string> {
  const invalid = (): never => {
    throw new Error("Invalid worker environment");
  };
  if (
    input === null ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    return invalid();
  const keys = Object.keys(input);
  if (keys.length > 32) return invalid();
  const result: Record<string, string> = {};
  let total = 0;
  for (const key of keys.sort()) {
    const value = (input as Record<string, unknown>)[key];
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(key) ||
      credential.test(key) ||
      reserved.has(key) ||
      reservedPattern.test(key) ||
      typeof value !== "string" ||
      /\p{Cc}/u.test(value)
    )
      return invalid();
    const bytes = Buffer.byteLength(value);
    total += bytes;
    if (bytes > 1024 || total > 8192) return invalid();
    result[key] = value;
  }
  return result;
}
