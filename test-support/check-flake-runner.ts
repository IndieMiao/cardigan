import { relative } from "node:path";
import { type RunnerTask, TestRunner } from "vitest";
import {
  type CheckFlakeId,
  checkFlakeCases,
} from "../packages/host/src/check-flake-cases.js";

import { matchesFailure } from "./check-flake-evidence.js";

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
      return errors?.length === 1 && matchesFailure(id, errors[0]);
    },
  };
}
