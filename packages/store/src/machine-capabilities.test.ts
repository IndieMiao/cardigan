import type { Actor } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  beginMachineObservation,
  completeMachineObservation,
  MACHINE_OBSERVATION_TTL_MS,
  type MachineHealth,
  readMachineObservations,
  readMachineObservationsInTransaction,
} from "./machine-capabilities.js";
import { withTempStore } from "./test-support.js";

const now = "2026-11-18T00:00:00.000Z";
const actor = { kind: "system", project_id: "a" } as const;
const health: MachineHealth = {
  status: "passed",
  checked_at: now,
  blockers: [],
  launch_enabled: true,
};
const capabilities = [
  {
    key: "node",
    version: "24.0.0",
    verified_at: now,
    evidence_ref: "fixture-evidence",
  },
];

test("capabilities and health expire after 24 hours and reject future proof", () =>
  withTempStore((store) => {
    store.createProject({ id: "a" });
    beginMachineObservation(store, actor, "a", "local", "probe", now);
    completeMachineObservation(
      store,
      actor,
      "a",
      "local",
      "probe",
      health,
      capabilities,
    );
    for (const [age, available] of [
      [0, true],
      [MACHINE_OBSERVATION_TTL_MS, true],
      [MACHINE_OBSERVATION_TTL_MS + 1, false],
      [-1, false],
    ] as const) {
      const result = readMachineObservations(
        store,
        "a",
        "local",
        new Date(Date.parse(now) + age).toISOString(),
      );
      expect(result.capabilities[0]?.available).toBe(available);
      expect(result.health?.available).toBe(available);
      expect(result.capabilities[0]?.version).toBe("24.0.0");
    }
  }));

test("failure revokes capabilities, preserves machine metadata, and isolates projects", () =>
  withTempStore((store) => {
    for (const project of ["a", "b"]) {
      store.createProject({ id: project });
      const system = { ...actor, project_id: project };
      beginMachineObservation(store, system, project, "local", "old", now);
      completeMachineObservation(
        store,
        system,
        project,
        "local",
        "old",
        health,
        capabilities,
      );
    }
    const before = store.uow.read((tx) => tx.machines.get("a", "local"));
    beginMachineObservation(store, actor, "a", "local", "new", now);
    expect(
      readMachineObservations(store, "a", "local", now).health?.available,
    ).toBe(false);
    completeMachineObservation(
      store,
      actor,
      "a",
      "local",
      "new",
      {
        ...health,
        status: "failed",
        blockers: ["unreachable"],
        launch_enabled: false,
      },
      [],
    );
    expect(
      readMachineObservations(store, "a", "local", now).capabilities,
    ).toEqual([]);
    expect(
      readMachineObservations(store, "b", "local", now).capabilities,
    ).toHaveLength(1);
    expect(store.uow.read((tx) => tx.machines.get("a", "local"))).toEqual(
      before,
    );
  }));

test("late probes cannot overwrite newer results", () =>
  withTempStore((store) => {
    store.createProject({ id: "a" });
    beginMachineObservation(store, actor, "a", "local", "older", now);
    beginMachineObservation(store, actor, "a", "local", "newer", now);
    expect(
      completeMachineObservation(
        store,
        actor,
        "a",
        "local",
        "newer",
        health,
        [],
      ),
    ).toBe(true);
    expect(
      completeMachineObservation(
        store,
        actor,
        "a",
        "local",
        "older",
        health,
        capabilities,
      ),
    ).toBe(false);
    expect(
      readMachineObservations(store, "a", "local", now).capabilities,
    ).toEqual([]);
  }));

test("a completed observation cannot be rebound or expose its private fingerprint", () =>
  withTempStore((store) => {
    store.createProject({ id: "a" });
    beginMachineObservation(store, actor, "a", "local", "probe", now);
    const finish = (fingerprint: string) =>
      completeMachineObservation(
        store,
        actor,
        "a",
        "local",
        "probe",
        health,
        capabilities,
        fingerprint,
      );
    expect(finish("original-target")).toBe(true);
    expect(finish("replacement-target")).toBe(false);
    const matches = (fingerprint: string) =>
      store.uow.read(
        () =>
          readMachineObservationsInTransaction(
            store,
            "a",
            "local",
            now,
            fingerprint,
          ).observation_target_matches,
      );
    expect(matches("original-target")).toBe(true);
    expect(matches("replacement-target")).toBe(false);
    const view = readMachineObservations(store, "a", "local", now);
    expect(view).not.toHaveProperty("observation_target_matches");
    expect(view.health).not.toHaveProperty("target_fingerprint");
  }));

test("only the matching system actor can write, even if an Assignment has every tool", () =>
  withTempStore((store) => {
    store.createProject({ id: "a" });
    const actors: Actor[] = [
      { kind: "human", project_id: "a" },
      { kind: "system", project_id: "b" },
      {
        kind: "assignment",
        project_id: "a",
        assignment_id: "A-1",
        role_id: "pm",
        role_version: 1,
        allowed_tools: ["assign", "update_work_item"],
        capabilities: ["produce", "verify"],
      },
    ];
    for (const other of actors) {
      expect(() =>
        beginMachineObservation(store, other, "a", "local", "forged", now),
      ).toThrow("system actor");
      expect(() =>
        completeMachineObservation(
          store,
          other,
          "a",
          "local",
          "forged",
          health,
          capabilities,
        ),
      ).toThrow("system actor");
    }
    expect(readMachineObservations(store, "a", "local", now)).toEqual({
      capabilities: [],
      health: null,
    });
  }));
