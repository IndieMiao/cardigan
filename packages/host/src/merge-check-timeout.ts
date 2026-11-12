/**
 * C-116: whether a failed check command's output shows only vitest timeouts.
 *
 * Conservative by design: any failure block whose error is not a
 * "Test/Hook timed out" line, any failed suite, unhandled error or type error,
 * truncated output, or output without a recognizable failure block is not
 * timeout-only. A false negative only means PM handles the failure as before.
 */
const FAIL = /^\s*FAIL\s/u;
const TIMEOUT = /^(?:Error:\s+)?(?:Test|Hook) timed out in \d+ms\b/u;
const OTHER = [
  /⎯\s*(?:Failed Suites|Unhandled Errors?|Unhandled Rejections?|Type Errors?)\b/u,
  /^\s*(?:Errors|Type Errors)\s+\d+\s+errors?\b/u,
];
export const TRUNCATED_OUTPUT = "[中间输出已截断]";

export function vitestTimeoutsOnly(output: string): boolean {
  if (output.includes(TRUNCATED_OUTPUT)) return false;
  const lines = output.split(/\r?\n/u);
  let failures = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (OTHER.some((pattern) => pattern.test(line))) return false;
    if (!FAIL.test(line)) continue;
    // Identical errors are grouped under consecutive FAIL headers.
    let next = i + 1;
    while (
      next < lines.length &&
      (FAIL.test(lines[next] ?? "") || !lines[next]?.trim())
    )
      next++;
    if (!TIMEOUT.test(lines[next]?.trim() ?? "")) return false;
    failures++;
    i = next;
  }
  return failures > 0;
}

/**
 * Every non-passing command either hit its step timeout or failed only with
 * vitest timeouts; at least one command did not pass.
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
        c.status === "timed_out" ||
        (c.status === "failed" && vitestTimeoutsOnly(output(c.name))),
    )
  );
}
