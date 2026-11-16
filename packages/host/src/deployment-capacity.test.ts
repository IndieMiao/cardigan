import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  acquireDeploymentCapacity,
  DeploymentInProgress,
} from "./deployment-capacity.js";
import {
  acquireMergeCheckCapacity,
  executionOwner,
  mergeCheckCapacityAvailable,
} from "./merge-check-capacity.js";

test("deployment and checks exclude each other across Store connections", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cg-deployment-capacity-"));
  const first = Store.open({ dataDir }),
    second = Store.open({ dataDir });
  try {
    first.createProject({ id: "fixture", name: "Fixture" });
    const check = acquireMergeCheckCapacity(first, "fixture", "attempt");
    expect(acquireDeploymentCapacity(second)).toBeUndefined();
    check();
    const deployment = acquireDeploymentCapacity(second);
    expect(deployment).toBeTypeOf("function");
    expect(acquireDeploymentCapacity(first)).toBeUndefined();
    expect(mergeCheckCapacityAvailable(first, "local", 1)).toBe(false);
    expect(() =>
      acquireMergeCheckCapacity(first, "fixture", "another"),
    ).toThrow(DeploymentInProgress);
    deployment?.();
    acquireMergeCheckCapacity(first, "fixture", "another")();
    const owner = executionOwner(process.pid);
    if (!owner) throw new Error("Expected process identity");
    first.database
      .prepare("INSERT INTO host_deployment_capacity VALUES (1, ?, ?)")
      .run(owner.pid, `${owner.start.split(":")[0]}:0`);
    const restored = acquireDeploymentCapacity(second);
    expect(restored).toBeTypeOf("function");
    restored?.();
    const worker = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await new Promise<void>((resolve) => worker.once("spawn", resolve));
    const lease = acquireMergeCheckCapacity(first, "fixture", "transfer");
    try {
      const actual = executionOwner(worker.pid ?? 0);
      if (!actual) throw new Error("Expected worker identity");
      lease.transfer(actual);
      expect(
        first.database
          .prepare(
            "SELECT owner_pid, owner_start FROM merge_check_capacity WHERE attempt_id = 'transfer'",
          )
          .get(),
      ).toEqual({ owner_pid: actual.pid, owner_start: actual.start });
      expect(acquireDeploymentCapacity(second)).toBeUndefined();
      lease();
      const after = acquireDeploymentCapacity(second);
      expect(after).toBeTypeOf("function");
      after?.();
    } finally {
      lease();
      worker.stdin.end();
      await new Promise<void>((resolve) =>
        worker.once("exit", () => resolve()),
      );
    }
  } finally {
    first.close();
    second.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
