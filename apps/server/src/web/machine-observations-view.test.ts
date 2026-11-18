import {
  beginMachineObservation,
  completeMachineObservation,
  MACHINE_OBSERVATION_TTL_MS,
  Store,
} from "@cardigan/store";
import { expect, test } from "vitest";
import { declaredCapabilities, readExecution } from "./execution-state.js";

const now = "2026-11-18T00:00:00.000Z";
const actor = { kind: "system", project_id: "a" } as const;
const url = new URL("http://localhost/api/projects/a/execution");

test("MC-5 execution machines carry display-only capabilities and health, expiring per read", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "a" });
    store.createProject({ id: "b" });
    const before = readExecution(store, "a", url, now);
    expect(before.machines.map((m) => [m.id, m.health])).toEqual([
      ["local", null],
    ]);
    beginMachineObservation(store, actor, "a", "local", "probe", now);
    completeMachineObservation(
      store,
      actor,
      "a",
      "local",
      "probe",
      { status: "passed", checked_at: now, blockers: [], launch_enabled: true },
      [
        {
          key: "godot",
          version: "4.7.1",
          verified_at: now,
          evidence_ref: "machine-observation:probe#godot",
        },
      ],
    );
    const fresh = readExecution(store, "a", url, now).machines[0];
    expect(fresh).toMatchObject({
      id: "local",
      tags: expect.any(Array),
      capabilities: [
        {
          key: "godot",
          version: "4.7.1",
          verified_at: now,
          available: true,
          state: "verified",
        },
      ],
      health: {
        status: "passed",
        checked_at: now,
        blockers: [],
        available: true,
      },
    });
    // Host evidence references and launch flags never reach the browser.
    expect(JSON.stringify(fresh)).not.toMatch(/evidence_ref|launch_enabled/);
    const later = new Date(
      Date.parse(now) + MACHINE_OBSERVATION_TTL_MS + 1,
    ).toISOString();
    const stale = readExecution(store, "a", url, later).machines[0];
    expect(stale?.capabilities?.[0]).toMatchObject({
      available: false,
      state: "expired",
    });
    expect(stale?.health?.available).toBe(false);
    // Observations are per project.
    expect(readExecution(store, "b", url, now).machines[0]).toMatchObject({
      capabilities: [],
      health: null,
    });
  } finally {
    store.close();
  }
});

test("MC-5 one machine shows verified, expired and declared-but-never-verified capabilities", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "a" });
    const old = new Date(
      Date.parse(now) - MACHINE_OBSERVATION_TTL_MS - 1,
    ).toISOString();
    beginMachineObservation(store, actor, "a", "local", "probe", now);
    completeMachineObservation(
      store,
      actor,
      "a",
      "local",
      "probe",
      { status: "passed", checked_at: now, blockers: [], launch_enabled: true },
      [
        {
          key: "node",
          version: "24.1.0",
          verified_at: now,
          evidence_ref: "machine-observation:probe#node",
        },
        {
          key: "python",
          version: "3.12.1",
          verified_at: old,
          evidence_ref: "machine-observation:probe#python",
        },
      ],
    );
    const os = readExecution(store, "a", url, now).machines[0]?.os ?? "";
    const catalog = [
      { key: "node", os: [os] },
      { key: "python", os: [os] },
      { key: "blender", os: [os] },
      // Not applicable to this machine's OS: never listed.
      { key: "xcode", os: ["other-os"] },
    ];
    const machine = readExecution(
      store,
      "a",
      url,
      now,
      undefined,
      undefined,
      declaredCapabilities(() => catalog),
    ).machines[0];
    expect(machine?.capabilities).toEqual([
      {
        key: "node",
        version: "24.1.0",
        verified_at: now,
        available: true,
        state: "verified",
      },
      {
        key: "python",
        version: "3.12.1",
        verified_at: old,
        available: false,
        state: "expired",
      },
      // No invented version or verification time.
      {
        key: "blender",
        version: null,
        verified_at: null,
        available: false,
        state: "unverified",
      },
    ]);
  } finally {
    store.close();
  }
});

test("MC-5 an unreadable or absent catalog declares nothing instead of failing the read", () => {
  expect(declaredCapabilities(undefined)).toBeUndefined();
  expect(
    declaredCapabilities(() => {
      throw new Error("Machine capability configuration invalid");
    }),
  ).toBeUndefined();
});
