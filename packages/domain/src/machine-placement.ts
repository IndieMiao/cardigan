/** Configured physical-machine resource slots; absence of a key means unlimited. */
export type MachineResources = ReadonlyMap<
  string,
  { readonly limit: number; readonly occupied: number }
>;

export function remainingResourceRatio(
  keys: readonly string[],
  resources?: MachineResources,
): number {
  let ratio = 1;
  for (const key of keys) {
    const slot = resources?.get(key);
    if (slot)
      ratio = Math.min(ratio, (slot.limit - slot.occupied) / slot.limit);
  }
  return ratio;
}

/** Transaction-local host evidence. Contains neither worker configuration nor other projects' identities. */
export interface MachinePlacement {
  /** Current project opt-in and platform match; a past health check is not a binding. */
  readonly remote_binding: "disabled" | "platform_mismatch" | "allowed";
  readonly health: {
    readonly status: string;
    readonly available: boolean;
  } | null;
  readonly capabilities: readonly {
    readonly key: string;
    readonly version: string | null;
    readonly available: boolean;
  }[];
  readonly resources?: MachineResources;
  readonly limit: number;
  readonly occupied: number;
}
export type ReadMachinePlacement = (
  project: string,
  now: string,
) => ReadonlyMap<string, MachinePlacement>;
