import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { capacityMachine, capacityOwnerState } from "./capacity-owner.js";
import { executionOwner } from "./process-identity.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});
afterEach(() => vi.mocked(readFileSync).mockRestore());

test("observation failures stay unknown rather than releasing an active incarnation", () => {
  const owner = executionOwner(process.pid);
  if (!owner) throw new Error("Missing owner");
  const row = {
    owner_pid: owner.pid,
    owner_start: owner.start,
    owner_machine: capacityMachine(),
  };
  expect(capacityOwnerState(row)).toBe("alive");
  expect(capacityOwnerState({ ...row, owner_machine: "" })).toBe("unknown");
  expect(
    capacityOwnerState({
      ...row,
      owner_start: "------------------------------------:1",
    }),
  ).toBe("unknown");
  vi.mocked(readFileSync).mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  });
  expect(capacityOwnerState(row)).toBe("unknown");
});
