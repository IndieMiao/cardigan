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
 * Alternative key → its options, in preference order when several are free:
 * the emulator first (closest to what such work used before), the device
 * when every emulator slot is busy.
 */
export const CAPABILITY_ALTERNATIVES: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  [ANDROID_ANY]: Object.freeze(["android.emulator", "android.device"]),
});

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
 * Pick one option for every unresolved alternative and add it to the keys:
 * the first free option in preference order, else the first the machine
 * supports (the Run queues for it and is re-resolved on its next admission
 * attempt, so whichever frees up first is taken), else the first option.
 * An alternative already narrowed by one of its options (`android.any` with
 * `android.emulator`) is left alone. Deterministic for the same states, so
 * the keys inspected before a claim match the keys claimed.
 */
export function resolveCapabilityAlternatives(
  keys: readonly string[],
  state: (
    candidate: readonly string[],
    option: string,
  ) => AlternativeOptionState,
): string[] {
  let result = [...keys];
  for (const key of unresolvedAlternatives(keys)) {
    const options = capabilityAlternatives(key) ?? [];
    if (options.some((o) => result.includes(o))) continue;
    let chosen: string | undefined;
    let fallback: string | undefined;
    for (const option of options) {
      const s = state([...result, option], option);
      if (s === "free") {
        chosen = option;
        break;
      }
      if (s === "supported" && fallback === undefined) fallback = option;
    }
    const pick = chosen ?? fallback ?? options[0];
    if (pick !== undefined) result = [...result, pick];
  }
  return result;
}
