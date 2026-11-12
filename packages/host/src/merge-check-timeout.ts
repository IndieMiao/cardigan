/**
 * C-116: whether a failed or timed-out check command shows only timeouts.
 *
 * Allowlist, conservative by design: every line that looks like a failure
 * signal must be a recognized part of vitest's timeout reporting, and every
 * vitest FAIL block must carry a "Test/Hook timed out" error. Anything else —
 * an assertion, a TypeScript or lint diagnostic, an unhandled error, logged
 * error text, truncated output — means the command is not timeout-only. A
 * false negative only means PM handles the failure as before.
 */
const FAIL = /^\s*FAIL\s/u;
const TIMEOUT = /^(?:Error:\s+)?(?:Test|Hook) timed out in \d+ms\b/u;
/** Lines that could report a failure of any kind. */
const SIGNAL =
  /error|fail|panic|exception|assert|abort|fatal|denied|cannot|unable|[×✗✖]/iu;
/** Failure-looking lines that vitest prints around timeouts. */
const ALLOWED = [
  // Test names in FAIL headers are arbitrary text; the FAIL block itself
  // still has to prove a timeout. × items and → reasons are handled in scan.
  FAIL,
  /^\s*⎯+\s*Failed (?:Tests|Suites) \d+\s*⎯+\s*$/u,
  /^\s*[❯✓↓]\s+\S+\s+\(\d+ tests?(?:\s*\|\s*\d+ (?:failed|passed|skipped|todo))*\)/u,
  /^\s*Test Files\s+\d+ failed\b/u,
  /^\s*Tests\s+\d+ (?:failed|passed|skipped|todo)\b/u,
  // Code frames and stack locations quote source text.
  /^\s*\d*\s*\|/u,
  /^\s*❯\s+\S+:\d+:\d+\s*$/u,
  // The package-manager wrapper around a failed vitest run.
  /^\s*ELIFECYCLE\s+(?:Test|Command) failed\b/u,
  /^\s*If this is a long-running (?:test|hook), pass a timeout value\b/u,
];
export const TRUNCATED_OUTPUT = "[中间输出已截断]";

interface Scan {
  /** Every failure-looking line is explained by vitest timeout reporting. */
  readonly clean: boolean;
  /** Number of FAIL blocks, all of them timeouts when `clean`. */
  readonly timeouts: number;
}
const FAILED_ITEM = /^\s*[×✗✖]\s/u;
const REASON = /^\s*→\s/u;
const TIMEOUT_REASON = /^\s*→\s+(?:Test|Hook) timed out in \d+ms\b/u;
const SUMMARY = /^\s*⎯+\s*Failed (?:Tests|Suites) \d+\s*⎯+\s*$/u;
function scan(output: string): Scan {
  const unclean = { clean: false, timeouts: 0 };
  if (output.includes(TRUNCATED_OUTPUT)) return unclean;
  const lines = output.split(/\r?\n/u);
  let timeouts = 0;
  /** FAIL headers in the final report, each proven to be a timeout. */
  let reported = 0;
  /** × items whose own reason line does not show a timeout. */
  let unexplained = 0;
  let summary = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FAIL.test(line)) {
      // Identical errors are grouped under consecutive FAIL headers.
      let next = i + 1;
      reported++;
      while (
        next < lines.length &&
        (FAIL.test(lines[next] ?? "") || !lines[next]?.trim())
      ) {
        if (FAIL.test(lines[next] ?? "")) reported++;
        next++;
      }
      if (!TIMEOUT.test(lines[next]?.trim() ?? "")) return unclean;
      timeouts++;
      i = next;
      continue;
    }
    // V-436: a failed test seen in the progress output is only explained by
    // its own timeout reason, or later by a timeout block in the report.
    if (FAILED_ITEM.test(line)) {
      let next = i + 1;
      while (next < lines.length && !lines[next]?.trim()) next++;
      if (TIMEOUT_REASON.test(lines[next] ?? "")) i = next;
      else unexplained++;
      continue;
    }
    // Any other stated reason (for example "→ expected 1 to be 2") is a failure.
    if (REASON.test(line)) return unclean;
    if (SUMMARY.test(line)) summary = true;
    if (SIGNAL.test(line) && !ALLOWED.some((pattern) => pattern.test(line)))
      return unclean;
  }
  // A run cut off before its report leaves failures nobody explained.
  if (unexplained > 0 && (!summary || unexplained > reported)) return unclean;
  return { clean: true, timeouts };
}

/** A failed command whose output reports only vitest test or hook timeouts. */
export function vitestTimeoutsOnly(output: string): boolean {
  const result = scan(output);
  return result.clean && result.timeouts > 0;
}
/** A command stopped by its step timeout without reporting another failure. */
export function stepTimeoutOnly(output: string): boolean {
  return scan(output).clean;
}

/**
 * Every non-passing command either hit its step timeout or failed only with
 * vitest timeouts, and none of them reported any other failure; at least one
 * command did not pass.
 */
export function checkTimedOutOnly(
  status: string,
  checks: readonly { readonly name: string; readonly status: string }[],
  output: (name: string) => string,
): boolean {
  return (
    (status === "failed" || status === "timed_out") &&
    checks.some((c) => c.status === "failed" || c.status === "timed_out") &&
    checks.every(
      (c) =>
        c.status === "passed" ||
        c.status === "not_run" ||
        c.status === "skipped" ||
        (c.status === "timed_out" && stepTimeoutOnly(output(c.name))) ||
        (c.status === "failed" && vitestTimeoutsOnly(output(c.name))),
    )
  );
}
