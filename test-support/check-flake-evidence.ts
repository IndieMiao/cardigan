import {
  type CheckFlakeId,
  checkFlakeCases,
} from "../packages/host/src/check-flake-cases.js";

// Match structured failure evidence, never diagnostic text printed by another
// test, DOM wait timeouts, an assertion's expected/actual, or a bare fetch error.
export function matchesFailure(id: CheckFlakeId, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const e = value as {
    name?: string;
    message?: string;
    cause?: unknown;
    expected?: unknown;
    actual?: unknown;
  };
  if ("expected" in e || "actual" in e || typeof e.message !== "string")
    return false;
  switch (checkFlakeCases[id].signature) {
    case "vitest-5000ms":
      return (
        e.name === "Error" &&
        /^Test timed out in 5000ms\.\nIf this is a long-running test,/u.test(
          e.message,
        )
      );
    case "corepack-pnpm-download":
      return (
        e.name === "Error" &&
        /^Command failed: pnpm (?:test|--filter fixture-child test)\n! Corepack is about to download https:\/\/[^\s]+\nDownloading the pnpm \d+\.\d+\.\d+ binary for [a-z0-9-]+\.\.\.\s*$/u.test(
          e.message,
        )
      );
    case "loopback-connect": {
      if (
        e.name !== "TypeError" ||
        e.message !== "fetch failed" ||
        !e.cause ||
        typeof e.cause !== "object"
      )
        return false;
      const cause = e.cause as { errors?: unknown[] };
      const causes = Array.isArray(cause.errors) ? cause.errors : [cause];
      return (
        causes.length > 0 &&
        causes.every((err) => {
          const c = err as {
            code?: string;
            address?: string;
            syscall?: string;
          } | null;
          return (
            c?.syscall === "connect" &&
            (c.address === "127.0.0.1" || c.address === "::1") &&
            (c.code === "ECONNREFUSED" || c.code === "ETIMEDOUT")
          );
        })
      );
    }
  }
}

type Attempt = {
  state: string;
  retryIndex: number;
  repeatIndex: number;
  errors?: readonly unknown[] | undefined;
};

/** Metadata and stdout from workers are not receipts. Inspect Vitest's actual
 * module, full name, result and indexed attempt history in the coordinator. */
export function caseReceipts(
  eligible: readonly CheckFlakeId[],
  tests: readonly {
    file: string;
    name: string;
    state: string;
    attempts: readonly Attempt[];
  }[],
) {
  const recovered: CheckFlakeId[] = [];
  let complete = true;
  for (const id of eligible) {
    const spec = checkFlakeCases[id];
    const rows = tests.filter(
      (row) => row.file === spec.file && row.name === spec.name,
    );
    const row = rows[0];
    if (rows.length !== 1 || !row || row.state !== "passed") {
      complete = false;
      continue;
    }
    const [first, second] = row.attempts;
    if (first?.retryIndex === 0 && first.repeatIndex === 0) {
      if (
        row.attempts.length === 1 &&
        first.state === "passed" &&
        !first.errors?.length
      )
        continue;
      if (
        row.attempts.length === 2 &&
        first.state === "failed" &&
        first.errors?.length === 1 &&
        matchesFailure(id, first.errors[0]) &&
        second?.state === "passed" &&
        second.retryIndex === 1 &&
        second.repeatIndex === 0 &&
        !second.errors?.length
      ) {
        recovered.push(id);
        continue;
      }
    }
    complete = false;
  }
  return { recovered, complete };
}
