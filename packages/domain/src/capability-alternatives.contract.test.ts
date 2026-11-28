import { expect, test } from "vitest";
import {
  type AlternativeOptionState,
  ANDROID_ANY,
  alternativeCapabilities,
  capabilityAlternatives,
  chooseCapabilityAlternatives,
  isAlternativeCapability,
  resolveCapabilityAlternatives,
  unresolvedAlternatives,
  withAllAlternatives,
} from "./capability-alternatives.js";
import {
  BUILTIN_CAPABILITY_NOTES,
  mergeCapabilityGuides,
  validateUsageNote,
} from "./capability-guide.js";
import { parseCapabilityRequirement } from "./machine-requirements.js";

const EMULATOR = "android.emulator",
  DEVICE = "android.device";

test("android.any is an ordinary capability key whose options are the device, then the emulator (C-850)", () => {
  expect(parseCapabilityRequirement(ANDROID_ANY)).toEqual({
    ok: true,
    value: { key: ANDROID_ANY },
  });
  expect(capabilityAlternatives(ANDROID_ANY)).toEqual([DEVICE, EMULATOR]);
  expect(isAlternativeCapability(ANDROID_ANY)).toBe(true);
  for (const key of [EMULATOR, DEVICE, "godot", "toString", "__proto__"])
    expect(isAlternativeCapability(key)).toBe(false);
});

test("a machine provides android.any once either option is verified", () => {
  expect(alternativeCapabilities([EMULATOR])).toEqual([ANDROID_ANY]);
  expect(alternativeCapabilities([DEVICE, "android.sdk"])).toEqual([
    ANDROID_ANY,
  ]);
  expect(alternativeCapabilities(["android.sdk", "godot"])).toEqual([]);
  expect(alternativeCapabilities([])).toEqual([]);
});

test("what an android.any Run might claim covers both options; explicit options resolve nothing", () => {
  expect(withAllAlternatives([ANDROID_ANY, "godot"])).toEqual([
    ANDROID_ANY,
    "godot",
    DEVICE,
    EMULATOR,
  ]);
  expect(withAllAlternatives([EMULATOR])).toEqual([EMULATOR]);
  expect(unresolvedAlternatives([ANDROID_ANY, "godot"])).toEqual([ANDROID_ANY]);
  expect(unresolvedAlternatives([ANDROID_ANY, DEVICE])).toEqual([]);
  expect(unresolvedAlternatives([EMULATOR, "godot"])).toEqual([]);
});

const states =
  (map: Record<string, AlternativeOptionState>) =>
  (_candidate: readonly string[], option: string) =>
    map[option] ?? "unsupported";

test("resolution takes the first free option, else the first supported one to wait for", () => {
  const keys = [ANDROID_ANY, "godot"];
  // Both free: the device (C-850), so the emulator stays free.
  expect(
    resolveCapabilityAlternatives(
      keys,
      states({ [EMULATOR]: "free", [DEVICE]: "free" }),
    ),
  ).toEqual([...keys, DEVICE]);
  // Device busy, emulator free: the emulator, without waiting for a device.
  expect(
    resolveCapabilityAlternatives(
      keys,
      states({ [EMULATOR]: "free", [DEVICE]: "supported" }),
    ),
  ).toEqual([...keys, EMULATOR]);
  // Emulator only on this machine.
  expect(
    resolveCapabilityAlternatives(keys, states({ [EMULATOR]: "free" })),
  ).toEqual([...keys, EMULATOR]);
  // Emulator busy, device free: the device.
  expect(
    resolveCapabilityAlternatives(
      keys,
      states({ [EMULATOR]: "supported", [DEVICE]: "free" }),
    ),
  ).toEqual([...keys, DEVICE]);
  // Both busy: wait for the first the machine has.
  expect(
    resolveCapabilityAlternatives(
      keys,
      states({ [EMULATOR]: "supported", [DEVICE]: "supported" }),
    ),
  ).toEqual([...keys, DEVICE]);
  expect(
    resolveCapabilityAlternatives(keys, states({ [EMULATOR]: "supported" })),
  ).toEqual([...keys, EMULATOR]);
  // Neither: the first option, which then waits like any missing resource.
  expect(resolveCapabilityAlternatives(keys, states({}))).toEqual([
    ...keys,
    DEVICE,
  ]);
});

test("each pick is recorded with every option's state and a reason (C-850)", () => {
  const keys = [ANDROID_ANY, "godot"];
  expect(
    chooseCapabilityAlternatives(
      keys,
      states({ [EMULATOR]: "free", [DEVICE]: "free" }),
    ),
  ).toEqual({
    keys: [...keys, DEVICE],
    choices: [
      {
        key: ANDROID_ANY,
        option: DEVICE,
        states: [{ option: DEVICE, state: "free" }],
        reason: "真机空闲，优先用真机",
      },
    ],
  });
  expect(
    chooseCapabilityAlternatives(
      keys,
      states({ [EMULATOR]: "free", [DEVICE]: "supported" }),
    ).choices,
  ).toEqual([
    {
      key: ANDROID_ANY,
      option: EMULATOR,
      states: [
        { option: DEVICE, state: "supported" },
        { option: EMULATOR, state: "free" },
      ],
      reason: "真机没有空闲，用空闲的模拟器",
    },
  ]);
  expect(
    chooseCapabilityAlternatives(keys, states({ [EMULATOR]: "free" }))
      .choices[0]?.reason,
  ).toBe("真机本机不具备，用空闲的模拟器");
  expect(
    chooseCapabilityAlternatives(
      keys,
      states({ [EMULATOR]: "supported", [DEVICE]: "supported" }),
    ).choices[0],
  ).toMatchObject({
    option: DEVICE,
    reason: "都没有空闲，先排队等真机，哪个先空出来用哪个",
  });
  expect(
    chooseCapabilityAlternatives(keys, states({})).choices[0],
  ).toMatchObject({ option: DEVICE, reason: "本机都不具备，按首选记为真机" });
  // Nothing to choose: no record.
  for (const explicit of [[EMULATOR], [ANDROID_ANY, EMULATOR], ["godot"]])
    expect(
      chooseCapabilityAlternatives(explicit, states({ [DEVICE]: "free" })),
    ).toEqual({ keys: explicit, choices: [] });
});

test("resolution asks with the candidate keys, leaves explicit options and other keys alone, and is deterministic", () => {
  const asked: string[][] = [];
  const state = (candidate: readonly string[], option: string) => {
    asked.push([...candidate]);
    return option === EMULATOR ? "free" : "supported";
  };
  const once = resolveCapabilityAlternatives([ANDROID_ANY], state);
  expect(asked).toEqual([
    [ANDROID_ANY, DEVICE],
    [ANDROID_ANY, EMULATOR],
  ]);
  expect(resolveCapabilityAlternatives([ANDROID_ANY], state)).toEqual(once);
  asked.length = 0;
  for (const keys of [
    [EMULATOR],
    [ANDROID_ANY, EMULATOR],
    [ANDROID_ANY, "android.device:WGC6R21609003324", DEVICE],
    ["godot"],
    [],
  ])
    expect(resolveCapabilityAlternatives(keys, state)).toEqual(keys);
  expect(asked).toEqual([]);
});

test("built-in notes explain real device versus emulator; a project's own note replaces them; android.emulator has none", () => {
  for (const key of [ANDROID_ANY, DEVICE]) {
    const note = BUILTIN_CAPABILITY_NOTES[key] as string;
    expect(validateUsageNote(note)).toEqual({ ok: true, value: note });
    for (const fact of [
      "快照",
      "冷启动",
      "分辨率",
      "arm64-v8a",
      "HarmonyOS 4.2",
      "API 31",
      "1600x2560",
      "400dpi",
    ])
      expect(note).toContain(fact);
  }
  // The condensed prompt line (first 300 characters) already says how to
  // tell which one was handed out and when a device cannot stand in.
  const head = [...(BUILTIN_CAPABILITY_NOTES[ANDROID_ANY] as string)]
    .slice(0, 300)
    .join("");
  for (const fact of [
    "ANDROID_SERIAL",
    "emulator-",
    "快照",
    "android.emulator",
  ])
    expect(head).toContain(fact);
  expect(Object.hasOwn(BUILTIN_CAPABILITY_NOTES, EMULATOR)).toBe(false);

  const merged = mergeCapabilityGuides([], {
    machine_id: "mac-mini",
    capabilities: [ANDROID_ANY, EMULATOR],
  });
  expect(merged.capabilities).toEqual([
    {
      key: ANDROID_ANY,
      usage_note: BUILTIN_CAPABILITY_NOTES[ANDROID_ANY],
      machine_note: null,
    },
    { key: EMULATOR, usage_note: null, machine_note: null },
  ]);
  const own = mergeCapabilityGuides(
    [
      {
        scope: "capability",
        key: ANDROID_ANY,
        machine_id: null,
        usage_note: "项目自己的说明",
        updated_at: "2026-11-27T00:00:00.000Z",
        updated_by: "human",
      },
    ],
    { capabilities: [ANDROID_ANY] },
  );
  expect(own.capabilities[0]?.usage_note).toBe("项目自己的说明");
  // The index lists only what the project registered.
  expect(mergeCapabilityGuides([]).capabilities).toEqual([]);
});
