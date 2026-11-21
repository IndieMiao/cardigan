import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import { configDefaults } from "vitest/config";
import type { Reporter } from "vitest/node";
import {
  checkFlakeCases,
  checkFlakeIds,
} from "../packages/host/src/check-flake-cases.js";

/** Only a completed second execution can turn the first failure into a receipt. */
export function recoveredOnRetry(
  state: string,
  attempts: readonly { state: string }[],
) {
  if (state === "failed") return false; // Let Vitest propagate the failure.
  if (
    state !== "passed" ||
    attempts.length !== 2 ||
    attempts[0]?.state !== "failed" ||
    attempts[1]?.state !== "passed"
  )
    throw new Error("Incomplete environment retry; refusing to pass");
  return true;
}
const flakeReceipts: Reporter = {
  onTestRunEnd(modules) {
    for (const module of modules)
      for (const test of module.children.allTests()) {
        const key = (test.meta() as { checkFlake?: unknown }).checkFlake;
        if (!key) continue;
        const id = checkFlakeIds.find((id) => id === key);
        if (!id || !recoveredOnRetry(test.result().state, test.attempts()))
          continue;
        if (!process.env.GITHUB_OUTPUT)
          throw new Error("Missing environment retry receipt destination");
        const { file, name, signature } = checkFlakeCases[id];
        appendFileSync(process.env.GITHUB_OUTPUT, `${id}=true\n`);
        if (process.env.GITHUB_STEP_SUMMARY)
          appendFileSync(
            process.env.GITHUB_STEP_SUMMARY,
            `偶发：${file} · ${name}（${signature}）；同一候选重跑 1 次通过。\n`,
          );
      }
  },
};
// Add to (rather than replace) Vitest's normal output and GitHub annotations.
const slowTests: Reporter = {
  onTestRunEnd(modules) {
    const rows = modules.flatMap((module) =>
      Array.from(module.children.allTests()).flatMap((test) => {
        const duration = test.diagnostic()?.duration;
        return duration === undefined || test.result().state === "skipped"
          ? []
          : [
              {
                duration,
                name: `${relative(process.cwd(), module.moduleId)} > ${test.fullName}`,
              },
            ];
      }),
    );
    if (!rows.length) return;
    console.log("Slowest test cases (up to 20):");
    for (const { duration, name } of rows
      .sort((a, b) => b.duration - a.duration || a.name.localeCompare(b.name))
      .slice(0, 20)) {
      console.log(
        `  ${duration.toFixed(1)} ms  ${name.replace(/[\r\n]+/g, " ")}`,
      );
    }
  },
};
export const ciReporters =
  process.env.GITHUB_ACTIONS === "true"
    ? [...configDefaults.reporters, slowTests, flakeReceipts]
    : configDefaults.reporters;
