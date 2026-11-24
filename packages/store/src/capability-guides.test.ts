import { type Actor, USAGE_NOTE_MAX_LENGTH } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  CapabilityGuideError,
  deleteCapabilityGuide,
  listCapabilityGuides,
  readCapabilityGuides,
  setCapabilityGuide,
} from "./capability-guides.js";
import {
  beginMachineObservation,
  completeMachineObservation,
  readMachineObservations,
} from "./machine-capabilities.js";
import { withTempStore } from "./test-support.js";

const now = "2026-11-25T00:00:00.000Z";
const human = { kind: "human", project_id: "a" } as const;
const system = { kind: "system", project_id: "a" } as const;
const agent = {
  kind: "assignment",
  project_id: "a",
  assignment_id: "A-1",
  role_id: "pm",
  role_version: 1,
  allowed_tools: ["get_card"],
  capabilities: [],
} as unknown as Actor;

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof CapabilityGuideError) return error.code;
    throw error;
  }
  return null;
};

test("humans and the host write three kinds of entry; reads merge per machine", () =>
  withTempStore((store) => {
    store.createProject({ id: "a" });
    store.createProject({ id: "b" });
    setCapabilityGuide(
      store,
      human,
      "a",
      { scope: "capability", key: "android.emulator" },
      "用 `emulator -list-avds` 查看",
      now,
    );
    setCapabilityGuide(
      store,
      system,
      "a",
      { scope: "machine", key: "android.emulator", machine_id: "mac-mini" },
      "ANDROID_AVD_HOME=~/.android/avd",
      now,
    );
    setCapabilityGuide(
      store,
      human,
      "a",
      { scope: "project", key: "test-accounts" },
      "受管文件 /srv/sensen/journey-test-accounts.yaml",
      now,
    );
    // Same entry again replaces it instead of adding a row.
    const replaced = setCapabilityGuide(
      store,
      human,
      "a",
      { scope: "capability", key: "android.emulator" },
      "  新说明\r\n第二行 ",
      "2026-11-25T01:00:00.000Z",
    );
    expect(replaced).toEqual({
      scope: "capability",
      key: "android.emulator",
      machine_id: null,
      usage_note: "新说明\n第二行",
      updated_at: "2026-11-25T01:00:00.000Z",
      updated_by: "human",
    });
    expect(listCapabilityGuides(store, "a")).toHaveLength(3);
    expect(listCapabilityGuides(store, "b")).toEqual([]);
    expect(
      readCapabilityGuides(store, "a", { machine_id: "mac-mini" }),
    ).toEqual({
      machine_id: "mac-mini",
      capabilities: [
        {
          key: "android.emulator",
          usage_note: "新说明\n第二行",
          machine_note: "ANDROID_AVD_HOME=~/.android/avd",
        },
      ],
      project_notes: [
        {
          key: "test-accounts",
          usage_note: "受管文件 /srv/sensen/journey-test-accounts.yaml",
        },
      ],
    });
    expect(
      readCapabilityGuides(store, "a", { machine_id: "local" }).capabilities,
    ).toEqual([
      {
        key: "android.emulator",
        usage_note: "新说明\n第二行",
        machine_note: null,
      },
    ]);
    expect(
      deleteCapabilityGuide(store, human, "a", {
        scope: "machine",
        key: "android.emulator",
        machine_id: "mac-mini",
      }),
    ).toBe(true);
    expect(
      deleteCapabilityGuide(store, human, "a", {
        scope: "machine",
        key: "android.emulator",
        machine_id: "mac-mini",
      }),
    ).toBe(false);
    expect(listCapabilityGuides(store, "a")).toHaveLength(2);
  }));

test("Agent actors, other projects, credential-like notes and bad targets never reach the table", () =>
  withTempStore((store) => {
    store.createProject({ id: "a" });
    const target = { scope: "capability", key: "godot" };
    expect(
      refusal(() => setCapabilityGuide(store, agent, "a", target, "x", now)),
    ).toBe("unauthorized");
    expect(
      refusal(() => deleteCapabilityGuide(store, agent, "a", target)),
    ).toBe("unauthorized");
    expect(
      refusal(() =>
        setCapabilityGuide(
          store,
          { kind: "human", project_id: "b" },
          "a",
          target,
          "x",
          now,
        ),
      ),
    ).toBe("unauthorized");
    expect(
      refusal(() =>
        setCapabilityGuide(
          store,
          { kind: "human", project_id: "missing" },
          "missing",
          target,
          "x",
          now,
        ),
      ),
    ).toBe("not_found");
    expect(
      refusal(() =>
        setCapabilityGuide(
          store,
          human,
          "a",
          target,
          "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          now,
        ),
      ),
    ).toBe("validation_failed");
    expect(
      refusal(() =>
        setCapabilityGuide(
          store,
          human,
          "a",
          target,
          "x".repeat(USAGE_NOTE_MAX_LENGTH + 1),
          now,
        ),
      ),
    ).toBe("validation_failed");
    expect(
      refusal(() =>
        setCapabilityGuide(
          store,
          human,
          "a",
          { scope: "machine", key: "godot" },
          "x",
          now,
        ),
      ),
    ).toBe("validation_failed");
    expect(listCapabilityGuides(store, "a")).toEqual([]);
  }));

test("probes and capability reads are independent of usage notes", () =>
  withTempStore((store) => {
    store.createProject({ id: "a" });
    store.uow.run((tx) =>
      tx.machines.put("a", {
        id: "local",
        label: "local",
        os: "linux",
        arch: "x64",
        tags: [],
        max_assignments: 1,
        status: "online",
      } as never),
    );
    setCapabilityGuide(
      store,
      human,
      "a",
      { scope: "machine", key: "node", machine_id: "local" },
      "node 在 PATH 上",
      now,
    );
    beginMachineObservation(store, system, "a", "local", "probe", now);
    completeMachineObservation(
      store,
      system,
      "a",
      "local",
      "probe",
      { status: "passed", checked_at: now, blockers: [], launch_enabled: true },
      [
        {
          key: "node",
          version: "24.0.0",
          verified_at: now,
          evidence_ref: "fixture",
        },
      ],
    );
    expect(
      readMachineObservations(store, "a", "local", now).capabilities,
    ).toEqual([
      {
        key: "node",
        version: "24.0.0",
        verified_at: now,
        evidence_ref: "fixture",
        available: true,
      },
    ]);
    // A new probe clears capability proof but keeps the human's notes.
    beginMachineObservation(store, system, "a", "local", "probe-2", now);
    expect(
      readMachineObservations(store, "a", "local", now).capabilities,
    ).toEqual([]);
    expect(listCapabilityGuides(store, "a")).toHaveLength(1);
  }));
