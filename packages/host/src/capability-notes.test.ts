import { Store, setCapabilityGuide } from "@cardigan/store";
import { expect, test } from "vitest";
import { launchCapabilityNotes } from "./capability-notes.js";

const now = "2026-11-25T00:00:00.000Z";
const human = { kind: "human", project_id: "a" } as const;

/**
 * C-726: the launch reads usage notes only for the work item's required
 * capabilities, merged for the Run's machine; no requirement means no input
 * at all, so the compiled Core Prompt is unchanged.
 */
test("C-726 launch notes follow requirements.capabilities, the Run's machine and the project", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "a" });
    store.createProject({ id: "b" });
    const set = (project: string, target: object, note: string) =>
      setCapabilityGuide(
        store,
        { ...human, project_id: project },
        project,
        target,
        note,
        now,
      );
    set("a", { scope: "capability", key: "android.emulator" }, "主说明");
    set(
      "a",
      { scope: "machine", key: "android.emulator", machine_id: "ci" },
      "ci 补充",
    );
    set(
      "a",
      { scope: "machine", key: "android.emulator", machine_id: "mac" },
      "mac 补充",
    );
    set("a", { scope: "capability", key: "blender" }, "未被要求");
    set("a", { scope: "project", key: "accounts" }, "项目级说明");
    set("b", { scope: "capability", key: "godot" }, "其它项目");

    expect(launchCapabilityNotes(store, "a", "ci", undefined)).toBeUndefined();
    expect(launchCapabilityNotes(store, "a", "ci", {})).toBeUndefined();
    expect(
      launchCapabilityNotes(store, "a", "ci", { capabilities: [] }),
    ).toBeUndefined();
    expect(
      launchCapabilityNotes(store, "a", "ci", {
        capabilities: ["android.emulator>=34", "godot"],
      }),
    ).toEqual([
      {
        key: "android.emulator",
        usage_note: "主说明",
        machine_note: "ci 补充",
      },
      { key: "godot", usage_note: null, machine_note: null },
    ]);
    expect(
      launchCapabilityNotes(store, "b", "mac", { capabilities: ["godot"] }),
    ).toEqual([{ key: "godot", usage_note: "其它项目", machine_note: null }]);
    // A read failure never fails the launch; it only drops the notes.
    store.database.exec("DROP TABLE capability_guides");
    expect(
      launchCapabilityNotes(store, "a", "ci", { capabilities: ["godot"] }),
    ).toBeUndefined();
  } finally {
    store.close();
  }
});
