import { spawn } from "node:child_process";
import {
  CHECK_TARGET_IDLE,
  checkTargetIdle,
} from "../packages/host/src/check-handoff.js";

/** Test-only process census: real /proc reads, but only PIDs owned by this fixture.
 * The production controller never supplies this transport seam and scans the full account.
 * Shared test hosts can contain unrelated non-dumpable same-UID processes; they must
 * continue to block production proof rather than weakening the production scanner.
 */
export function fixtureCheckProbe(pids: () => readonly number[] = () => []) {
  return (execution: Parameters<typeof checkTargetIdle>[0], slots: number) =>
    checkTargetIdle(execution, slots, (file, args, options) => {
      const script = CHECK_TARGET_IDLE.replace(
        "files.readdir('/proc')",
        `Promise.resolve(${JSON.stringify(pids().map(String))})`,
      );
      return spawn(
        file,
        args.map((arg) => (arg === CHECK_TARGET_IDLE ? script : arg)),
        options,
      );
    });
}
