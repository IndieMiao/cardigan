import { relative } from "node:path";
import { configDefaults } from "vitest/config";
import type { Reporter } from "vitest/node";

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
