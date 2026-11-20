import type { Actor, Event } from "./entities.js";
import type { EmployeeId, EventId, MemberId } from "./ids.js";

/** Human management of global identities does not require a project selection. */
export type GlobalActor =
  | Actor
  | { readonly kind: "human"; readonly member_id?: MemberId };
export type GlobalEvent = Omit<Event, "card_id" | "actor"> & {
  readonly actor: { readonly kind: "human" | "system" };
};
export interface GlobalIdAllocator {
  nextEmployeeId(): EmployeeId;
  nextMemberId(): MemberId;
  nextEventId(): EventId;
  nextEventSequence(): number;
}
