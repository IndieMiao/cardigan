import { relative } from "node:path";
import { type RunnerTask, TestRunner } from "vitest";
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

export default class CheckFlakeRunner extends TestRunner {
  override async onBeforeRunTask(task: RunnerTask) {
    await super.onBeforeRunTask(task);
    configureCaseRetry(task, this.injectValue("retryCases"));
  }
}

export function configureCaseRetry(
  task: RunnerTask,
  eligible: readonly CheckFlakeId[],
) {
  if (task.type !== "test" || task.retry || task.repeats || task.fails) return;
  const file = relative(process.cwd(), task.file.filepath);
  const id = eligible.find(
    (id) =>
      checkFlakeCases[id].file === file &&
      checkFlakeCases[id].name === task.fullTestName,
  );
  if (!id) return;
  task.retry = {
    count: 1,
    condition: () => {
      const errors = task.result?.errors;
      if (errors?.length !== 1 || !matchesFailure(id, errors[0])) return false;
      Object.assign(task.meta, { checkFlake: id });
      return true;
    },
  };
}
