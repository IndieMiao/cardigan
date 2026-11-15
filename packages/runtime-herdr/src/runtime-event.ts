import type { RuntimeObservation } from "@cardigan/domain";

export interface RuntimeEvent {
  /** Host subscription incarnation; seq itself remains the core's sequence. */
  readonly source_generation?: number;
  readonly seq: number;
  readonly type: string;
  readonly terminal_ref?: string;
  readonly data?: unknown;
  readonly observations: readonly {
    terminal_ref: string;
    status: RuntimeObservation;
  }[];
}
