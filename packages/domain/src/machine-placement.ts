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
  readonly limit: number;
  readonly occupied: number;
}
export type ReadMachinePlacement = (
  project: string,
  now: string,
) => ReadonlyMap<string, MachinePlacement>;
