import {
  beginMachineObservation,
  completeMachineObservation,
  MACHINE_OBSERVATION_TTL_MS,
  Store,
} from "@cardigan/store";
import { expect, test } from "vitest";
import { readExecution } from "./execution-state.js";

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
        { key: "godot", version: "4.7.1", verified_at: now, available: true },
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
    expect(stale?.capabilities?.[0]?.available).toBe(false);
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
