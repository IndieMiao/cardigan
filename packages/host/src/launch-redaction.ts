import { LAUNCH_EVIDENCE_LIMITS } from "@cardigan/domain";
import type { WorkerLaunchEvidence as WorkerLaunch } from "@cardigan/mcp-server";

const PATH_WORDS =
  "(?:token|secret|credential|password|passwd|\\.ssh|id_rsa|id_ed25519|id_ecdsa|\\.pem|\\.key|\\.netrc|git-credentials|auth)";
/** Same rules as the worker collector (deploy/inspect-worker.py `redact`). */
const REDACTIONS: readonly [RegExp, string | ((s: string) => string)][] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
    "[REDACTED]",
  ],
  [
    /\b(?:authorization|cookie)\b\s*[:=]?\s*(?:(?:bearer|basic|token)\s+)?\S+|\bbearer\s+\S+/giu,
    "[REDACTED]",
  ],
  [
    /\b([a-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|credential)s?)(["']?\s*[:=]\s*)\S+/giu,
    "$1$2[REDACTED]",
  ],
  [
    /\b(?:gh[opsur]_|github_pat_|sk-|xox[abprs]-|AKIA)[A-Za-z0-9_.-]{8,}/gu,
    "[REDACTED]",
  ],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/gu, "[REDACTED]"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@\S*/giu, "[URL]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/giu, "$1"],
  [
    new RegExp(
      `(?:~|\\$HOME|\\.{1,2})?/[^\\s'"\`]*${PATH_WORDS}[^\\s'"\`]*`,
      "giu",
    ),
    "[PATH]",
  ],
  // Opaque strings: letters and digits mixed, then long base64 runs.
  [
    /[A-Za-z0-9_+=-]{24,}/gu,
    (s) => (/\d/u.test(s) && /[A-Za-z]/u.test(s) ? "[REDACTED]" : s),
  ],
  [/[A-Za-z0-9+/]{40,}={0,2}/gu, "[REDACTED]"],
];

/**
 * C-806: credentials first (tokens, authorization values, key material,
 * URL credentials and query strings, paths naming credentials, opaque
 * strings), then control characters, then the length limit.
 */
export function redactLaunchText(text: string, limit: number): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS)
    out =
      typeof replacement === "string"
        ? out.replace(pattern, replacement)
        : out.replace(pattern, replacement);
  out = out
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "")
    .trimEnd();
  return out.length <= limit ? out : `${out.slice(0, limit - 1)}…`;
}

const bytes = (lines: readonly string[]) =>
  new TextEncoder().encode(lines.join("\n")).length;

/** Re-redact worker text on the host and enforce the domain limits. */
export function redactWorkerLaunch(launch: WorkerLaunch): WorkerLaunch {
  const L = LAUNCH_EVIDENCE_LIMITS;
  const terminal = launch.terminal && {
    ...launch.terminal,
    tail: (() => {
      const tail = launch.terminal.tail
        .map((line) => redactLaunchText(line, L.tail_chars))
        .filter((line) => line.trim())
        .slice(-L.tail_lines);
      while (tail.length && bytes(tail) > L.tail_bytes) tail.shift();
      return tail;
    })(),
  };
  return {
    ...launch,
    terminal,
    mcp:
      launch.mcp?.map((s) =>
        s.error === undefined
          ? s
          : { ...s, error: redactLaunchText(s.error, L.error_chars) },
      ) ?? null,
  };
}
