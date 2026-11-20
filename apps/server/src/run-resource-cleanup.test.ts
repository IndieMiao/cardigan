import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResourceRegistration } from "@cardigan/host";
import { afterEach, expect, test, vi } from "vitest";
import { m4Fixture, m4Scenario } from "./m4-fixtures.js";
import {
  reconcileRunResources,
  resourceExpiry,
} from "./run-resource-cleanup.js";

afterEach(() => vi.unstubAllEnvs());
test("process groups, detached descendants, session exit and replaced/occupied scratch in private fixtures", async () => {
  const result = await promisify(execFile)(
    "python3",
    ["-IB", "test-support/run-resources.py"],
    { timeout: 30000 },
  );
  expect(result.stdout).toContain("isolated run resources passed");
}, 35000);

test.each(["completed", "failed", "cancelled"] as const)(
  "notifies only the ended %s Run; other runs, absent proof and expired legacy stay untouched",
  async (outcome) => {
    const f = m4Fixture();
    try {
      const { coder } = m4Scenario(f);
      const session = f.startRun(coder);
      f.endRun(coder, outcome === "failed" ? "failed" : "completed");
      if (outcome === "cancelled")
        f.store.uow.run((tx) =>
          tx.runs.put(f.project_id, {
            ...session,
            status: outcome,
            finished_at: f.clock.now(),
          }),
        );
      const next = f.startRun(coder);
      const make = (id: string): ResourceRegistration => ({
        key: `${coder.id}.${session.id}.${id}`,
        inode: ["1", "2"],
        expired: false,
        closed: false,
        owned: true,
      });
      const finished = make(session.id);
      const rows = [
        finished,
        make(next.id),
        { ...finished, owned: false },
        { ...finished, expired: true },
        make("R-999"),
      ];
      const worker = vi.fn(
        async (
          _e: unknown,
          _t: string,
          _a: number,
          items?: ResourceRegistration[],
        ) => (items ? [] : rows),
      );
      const machine = f.store.uow.read((tx) =>
        tx.machines.get(f.project_id, "local"),
      );
      if (!machine) throw new Error("missing fixture machine");
      f.store.uow.run((tx) =>
        tx.machines.put(f.project_id, { ...machine, status: "online" }),
      );
      const resolve = () => ({
        execution: { mode: "local" as const, dataDir: f.dataDir },
        session: "fixture",
        machine,
      });
      const audit = vi.fn();
      vi.stubEnv("CARDIGAN_RUN_RESOURCE_EXPIRED_EXECUTE", "");
      await reconcileRunResources(
        f.store,
        { resolve },
        f.project_id,
        audit,
        worker,
        () => Date.parse(f.clock.now()),
      );
      expect(worker.mock.calls[1]?.[3]).toEqual([finished, finished]);
      expect(audit).toHaveBeenCalledWith(
        expect.stringContaining("skipped_unknown"),
      );
      expect(audit).toHaveBeenCalledWith(
        expect.stringContaining("close_notified"),
      );
      const later = () => Date.parse(f.clock.now()) + 86400_001;
      worker.mockClear();
      await reconcileRunResources(
        f.store,
        { resolve },
        f.project_id,
        audit,
        worker,
        later,
      );
      expect(worker).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith(
        expect.stringContaining("expired_preview"),
      );
      worker.mockClear();
      vi.stubEnv("CARDIGAN_RUN_RESOURCE_EXPIRED_EXECUTE", "1");
      await reconcileRunResources(
        f.store,
        { resolve },
        f.project_id,
        audit,
        worker,
        later,
      );
      expect(worker.mock.calls[1]?.[3]).toEqual([
        { ...finished, expired: true },
      ]);
      worker.mockClear();
      await reconcileRunResources(
        f.store,
        {
          resolve() {
            throw new Error("target unavailable");
          },
        },
        f.project_id,
        audit,
        worker,
      );
      expect(worker).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(
        expect.stringContaining("observation_failed"),
      );
    } finally {
      f.close();
    }
  },
);
test("expiry defaults to 24 hours; invalid values cannot enable early cleanup", () => {
  expect(resourceExpiry()).toBe(86400);
  expect(resourceExpiry("600")).toBe(600);
  expect(() => resourceExpiry("0")).toThrow();
});
