import { AFFECTED_PACKAGE_DIR } from "./change-scope.js";
import type { CheckRequest } from "./check-executor.js";

/** Only these trusted workflow steps may be omitted or narrowed. */
export function githubCheckScope(request: Pick<CheckRequest, "checks">): {
  scope: "full" | "docs_only" | "affected";
  affected_paths: string;
  skip_checks: string;
} {
  const full = { scope: "full" as const, affected_paths: "", skip_checks: "" };
  const skipped: string[] = [];
  let paths: readonly string[] = [];
  for (const check of request.checks) {
    if (check.skipReason !== undefined) {
      if (
        check.skipReason !== "docs_only" ||
        !["test", "e2e"].includes(check.name)
      )
        return full;
      skipped.push(check.name);
    }
    if (check.affectedPaths !== undefined) {
      if (
        check.name !== "test" ||
        !Array.isArray(check.affectedPaths) ||
        check.affectedPaths.length > 64 ||
        !check.affectedPaths.every(
          (p) => typeof p === "string" && AFFECTED_PACKAGE_DIR.test(p),
        )
      )
        return full;
      paths = [...new Set(check.affectedPaths)].sort();
    }
  }
  if (skipped.length) {
    if (paths.length || new Set(skipped).size !== skipped.length) return full;
    return {
      scope: "docs_only",
      affected_paths: "",
      skip_checks: ["test", "e2e"]
        .filter((name) => skipped.includes(name))
        .join(","),
    };
  }
  const affected = paths.join(" ");
  return affected && affected.length <= 4096
    ? { scope: "affected", affected_paths: affected, skip_checks: "" }
    : full;
}

/** Legacy workflows receive no new inputs and retain full execution semantics. */
export function githubScopedRequest(
  request: CheckRequest,
  enabled: boolean,
): CheckRequest {
  if (enabled && githubCheckScope(request).scope !== "full") return request;
  return {
    ...request,
    checks: request.checks.map(
      ({ skipReason: _skip, affectedPaths: _paths, ...check }) => check,
    ),
  };
}
