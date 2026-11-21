import { writeSync } from "node:fs";
import { relative } from "node:path";
import { configDefaults } from "vitest/config";
import type { Reporter } from "vitest/node";
import {
  type CheckFlakeId,
  checkFlakeCases,
} from "../packages/host/src/check-flake-cases.js";
import { caseReceipts } from "./check-flake-evidence.js";

export const isolatedReceipts = (
  eligible: readonly CheckFlakeId[],
): Reporter => ({
  onTestRunEnd(modules, errors, reason) {
    if (errors.length || reason !== "passed") return; // Vitest owns the failing exit.
    const expectedFiles = new Set<string>(
      eligible.map((id) => checkFlakeCases[id].file),
    );
    if (
      modules.some(
        (module) =>
          !expectedFiles.has(relative(process.cwd(), module.moduleId)),
      )
    )
      throw new Error("Unexpected test module in isolated run");
    const ids = caseReceipts(
      eligible,
      modules.flatMap((module) =>
        Array.from(module.children.allTests(), (test) => ({
          file: relative(process.cwd(), module.moduleId),
          name: test.fullName,
          state: test.result().state,
          attempts: test.attempts(),
        })),
      ),
    );
    // Private coordinator pipe, not stdout or a GitHub command file. A missing
    // report (even with exit 0) is never accepted as a successful partition.
    writeSync(3, `${JSON.stringify(ids)}\n`);
  },
});
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
    ? [...configDefaults.reporters, slowTests]
    : configDefaults.reporters;
