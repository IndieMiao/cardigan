import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runtime, RuntimeObservation, RuntimeRef } from "@cardigan/domain";
import { value } from "../src/test-support.js";

export const DOORBELL = "[bell] card=C-1 wi=W-1";
export const OBSERVED = "fixture:working-observed";

/** Hold working until the observer acknowledges it, irrespective of latency. */
export function doorbellAgent(directory: string) {
  const script = join(directory, "agent.sh");
  const receipt = join(directory, "received.txt");
  writeFileSync(
    script,
    `#!/bin/sh
printf '\\033]7501;state=idle\\007'
while IFS= read -r line; do
  printf '%s' "$line" > "$1" || exit 1
  printf '\\033]7501;state=working\\007'
  IFS= read -r ack || exit 1
  [ "$ack" = '${OBSERVED}' ] || exit 2
  printf '\\033]7501;state=idle\\007'
done
`,
  );
  return { command: "sh", args: [script, receipt], receipt };
}

/** The caller owns provisioning; this contract always releases that ref. */
export async function checkDoorbell(
  runtime: Pick<Runtime, "status" | "wake" | "release">,
  ref: RuntimeRef,
  received: () => string,
): Promise<void> {
  const failures: unknown[] = [];
  async function waitForAgent(
    expected: RuntimeObservation["agent"],
    phase: string,
  ) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const status = value(await runtime.status(ref));
      assert.equal(status.process, "alive", `${phase}: terminal exited`);
      if (status.agent === expected) return;
      if (Date.now() >= deadline)
        throw new Error(`${phase}: timed out; last=${JSON.stringify(status)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    await waitForAgent("idle", "before doorbell");
    assert.equal(
      value(await runtime.wake(ref, DOORBELL, { if_idle: true })).sent,
      true,
      "doorbell was not sent",
    );
    await waitForAgent("working", "after doorbell");
    assert.equal(received(), DOORBELL, "agent received a different doorbell");
    assert.equal(
      value(await runtime.wake(ref, OBSERVED)).sent,
      true,
      "observation acknowledgement was not sent",
    );
    await waitForAgent("idle", "after acknowledgement");
  } catch (error) {
    failures.push(error);
  }
  try {
    value(await runtime.release(ref, { force: true }));
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 1)
    throw new AggregateError(failures, "doorbell and cleanup failed");
  if (failures.length) throw failures[0];
}
