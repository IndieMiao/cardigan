import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { m4Fixture, m4Scenario } from "./m4-fixtures.js";
import { previewMachine, resourceExpiry } from "./run-resource-cleanup.js";

test("process groups, detached descendants, session exit and replaced/occupied scratch in private fixtures", async () => {
  const result = await promisify(execFile)(
    "python3",
    ["-IB", "test-support/run-resources.py"],
    { timeout: 55000 },
  );
  expect(result.stdout).toContain("isolated run resources passed");
}, 60000);

test("on-demand listener releases before any project code executes and retains Vite after admission", async () => {
  const result = await promisify(execFile)(
    "python3",
    ["-IB", "test-support/run-resources.py", "on-demand-vite"],
    { timeout: 35000 },
  );
  expect(result.stdout).toContain("on-demand listener lifecycle passed");
}, 40000);

test("draining workers are previewed without starting work or scheduling a deletion", async () => {
  const f = m4Fixture();
  try {
    m4Scenario(f);
    const machine = f.store.uow.read((tx) =>
      tx.machines.get(f.project_id, "local"),
    );
    if (!machine) throw new Error("fixture missing");
    f.store.uow.run((tx) =>
      tx.machines.put(f.project_id, { ...machine, status: "draining" }),
    );
    const preview = vi.fn(async () => ({
      expired: 1,
      unknown: 2,
      partial: true,
    }));
    const audit = vi.fn();
    await previewMachine(
      f.store,
      {
        resolve: () => ({
          execution: { mode: "local", dataDir: f.dataDir },
          session: "fixture",
          machine,
        }),
      },
      f.project_id,
      machine.id,
      audit,
      preview,
    );
    expect(preview).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.stringContaining("expired=1 unknown=2 partial=true"),
    );
    expect(resourceExpiry()).toBe(86400);
    expect(resourceExpiry("600")).toBe(600);
    expect(() => resourceExpiry("0")).toThrow();
  } finally {
    f.close();
  }
});
