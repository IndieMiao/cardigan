import { BUILTIN_CAPABILITY_NOTES } from "@cardigan/domain";
import { CAPABILITY_GUIDE_TOOL, capabilityNotesPrompt } from "@cardigan/roles";
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

test("C-815 android.any and android.device launch with the built-in real-device note unless the project wrote its own; android.emulator gets none", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "a" });
    const notes = launchCapabilityNotes(store, "a", "mac-mini", {
      capabilities: ["android.any", "android.emulator"],
    });
    expect(notes?.map((n) => [n.key, n.usage_note])).toEqual([
      ["android.any", BUILTIN_CAPABILITY_NOTES["android.any"]],
      ["android.emulator", null],
    ]);
    const prompt = capabilityNotesPrompt(notes, [CAPABILITY_GUIDE_TOOL]);
    expect(prompt).toContain("- android.any：");
    expect(prompt).toContain("ANDROID_SERIAL");
    expect(prompt).not.toContain("- android.emulator：");
    // Emulator-only work items: no note, no block, the prompt is unchanged.
    expect(
      capabilityNotesPrompt(
        launchCapabilityNotes(store, "a", "mac-mini", {
          capabilities: ["android.emulator"],
        }),
        [CAPABILITY_GUIDE_TOOL],
      ),
    ).toBe("");
    setCapabilityGuide(
      store,
      human,
      "a",
      { scope: "capability", key: "android.device" },
      "本项目的真机说明",
      now,
    );
    expect(
      launchCapabilityNotes(store, "a", "mac-mini", {
        capabilities: ["android.device"],
      }),
    ).toEqual([
      {
        key: "android.device",
        usage_note: "本项目的真机说明",
        machine_note: null,
      },
    ]);
  } finally {
    store.close();
  }
});
