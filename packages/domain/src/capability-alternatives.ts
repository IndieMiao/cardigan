/**
 * C-815: a requirement that any one of several capabilities satisfies.
 *
 * `android.any` (安卓设备任一) is met by an Android emulator or an Android
 * device (C-813), whichever is free. The machine check rolls it up from its
 * options, so machine selection treats it like any other capability; at
 * admission the host picks one option and the Run claims both `android.any`
 * and that option. The option then drives everything else exactly as if the
 * work item had asked for it (quota slots, adb slot, device lease, launch
 * environment), so a work item asking for one concrete option is unchanged.
 *
 * No IO here (§20.2).
 */

/** 安卓设备任一. */
export const ANDROID_ANY = "android.any";

/**
 * Alternative key → its options, in preference order when several are free.
 * C-850: an idle real device first, so the emulator stays free for work that
 * can only use an emulator (snapshots, cold boots, phone resolutions); the
 * emulator when no device is idle.
 */
export const CAPABILITY_ALTERNATIVES: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  [ANDROID_ANY]: Object.freeze(["android.device", "android.emulator"]),
});

/** C-850: how an option is named in recorded choices. */
const OPTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "android.device": "真机",
  "android.emulator": "模拟器",
});

export function alternativeOptionLabel(option: string) {
  return Object.hasOwn(OPTION_LABELS, option)
    ? (OPTION_LABELS[option] as string)
    : option;
}

export function capabilityAlternatives(
  key: string,
): readonly string[] | undefined {
  return Object.hasOwn(CAPABILITY_ALTERNATIVES, key)
    ? CAPABILITY_ALTERNATIVES[key]
    : undefined;
}

export function isAlternativeCapability(key: string) {
  return capabilityAlternatives(key) !== undefined;
}

/**
 * The alternative keys a machine provides, given the capability keys it has
 * verified: each alternative with at least one verified option.
 */
export function alternativeCapabilities(verified: readonly string[]): string[] {
  const have = new Set(verified);
  return Object.entries(CAPABILITY_ALTERNATIVES)
    .filter(([, options]) => options.some((o) => have.has(o)))
    .map(([key]) => key)
    .sort();
}

/**
 * Keys plus every option of each alternative among them: what a Run of these
 * keys *might* claim (whether it may need an adb slot, a scarce resource...).
 */
export function withAllAlternatives(keys: readonly string[]): string[] {
  const result = [...keys];
  for (const key of keys)
    for (const option of capabilityAlternatives(key) ?? [])
      if (!result.includes(option)) result.push(option);
  return result;
}

/** Alternatives among `keys` that name none of their options yet. */
export function unresolvedAlternatives(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const options = capabilityAlternatives(key);
    return !!options && !options.some((o) => keys.includes(o));
  });
}

/**
 * How usable one option is for a Run right now: `free` (could start now),
 * `supported` (the machine has it; the Run would wait for it) or
 * `unsupported` (the machine does not have it).
 */
export type AlternativeOptionState = "free" | "supported" | "unsupported";

/**
 * C-850: the option picked for one alternative and why, as recorded on the
 * Run and its dispatch event: every option's state in preference order.
 */
export interface AlternativeChoice {
  readonly key: string;
  readonly option: string;
  readonly states: readonly {
    readonly option: string;
    readonly state: AlternativeOptionState;
  }[];
  readonly reason: string;
}

function choiceReason(
  option: string,
  states: AlternativeChoice["states"],
): string {
  const label = alternativeOptionLabel(option);
  const picked = states.find((s) => s.option === option)?.state;
  if (picked === "free") {
    const before = states.slice(
      0,
      states.findIndex((s) => s.option === option),
    );
    if (!before.length) return `${label}空闲，优先用${label}`;
    const why = before
      .map(
        (s) =>
          `${alternativeOptionLabel(s.option)}${s.state === "unsupported" ? "本机不具备" : "没有空闲"}`,
      )
      .join("，");
    return `${why}，用空闲的${label}`;
  }
  if (picked === "supported")
    return `都没有空闲，先排队等${label}，哪个先空出来用哪个`;
  return `本机都不具备，按首选记为${label}`;
}

/**
 * Pick one option for every unresolved alternative and add it to the keys:
 * the first free option in preference order, else the first the machine
 * supports (the Run queues for it and is re-resolved on its next admission
 * attempt, so whichever frees up first is taken), else the first option.
 * An alternative already narrowed by one of its options (`android.any` with
 * `android.emulator`) is left alone. Deterministic for the same states, so
 * the keys inspected before a claim match the keys claimed. `choices` names
 * each pick with every option's state (C-850).
 */
export function chooseCapabilityAlternatives(
  keys: readonly string[],
  state: (
    candidate: readonly string[],
    option: string,
  ) => AlternativeOptionState,
): { keys: string[]; choices: AlternativeChoice[] } {
  let result = [...keys];
  const choices: AlternativeChoice[] = [];
  for (const key of unresolvedAlternatives(keys)) {
    const options = capabilityAlternatives(key) ?? [];
    if (options.some((o) => result.includes(o))) continue;
    const states: { option: string; state: AlternativeOptionState }[] = [];
    let chosen: string | undefined;
    let fallback: string | undefined;
    for (const option of options) {
      const s = state([...result, option], option);
      states.push({ option, state: s });
      if (s === "free") {
        chosen = option;
        break;
      }
      if (s === "supported" && fallback === undefined) fallback = option;
    }
    const pick = chosen ?? fallback ?? options[0];
    if (pick === undefined) continue;
    result = [...result, pick];
    choices.push({
      key,
      option: pick,
      states,
      reason: choiceReason(pick, states),
    });
  }
  return { keys: result, choices };
}

/** `chooseCapabilityAlternatives` without the recorded choices. */
export function resolveCapabilityAlternatives(
  keys: readonly string[],
  state: (
    candidate: readonly string[],
    option: string,
  ) => AlternativeOptionState,
): string[] {
  return chooseCapabilityAlternatives(keys, state).keys;
}
