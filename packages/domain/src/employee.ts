import type { Actor, Event, Timestamp } from "./entities.js";
import type { EmployeeId, EventId, RoleId } from "./ids.js";
import type { Clock } from "./ports.js";
import type { EmployeeStatus } from "./states.js";

/** A global identity, independent of project-local roles and assignments. */
export interface Employee {
  readonly id: EmployeeId;
  readonly name: string;
  readonly title: string;
  readonly bio: string;
  readonly avatar: string | null;
  readonly role_id: RoleId;
  readonly launch_profile_ref: string | null;
  readonly status: EmployeeStatus;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export type EmployeeActor = Actor | { readonly kind: "human" };
export type GlobalEvent = Omit<Event, "card_id" | "actor"> & {
  readonly actor: { readonly kind: "human" };
};

/** Full-width and ASCII spaces compare equally; surrounding whitespace is ignored. */
export function employeeNameKey(name: string): string {
  return name.replace(/\u3000/gu, " ").trim();
}

export interface EmployeeRepository {
  get(id: EmployeeId): Employee | undefined;
  list(): readonly Employee[];
  put(employee: Employee): void;
}
export interface GlobalEventRepository {
  append(event: GlobalEvent): void;
  listAfter(since_seq: number): readonly GlobalEvent[];
}
export interface GlobalRepositories {
  readonly employees: EmployeeRepository;
  readonly global_events: GlobalEventRepository;
}
export interface GlobalIdAllocator {
  nextEmployeeId(): EmployeeId;
  nextEventId(): EventId;
  nextEventSequence(): number;
}
export interface EmployeeCommandPorts {
  readonly clock: Clock;
  readonly ids: GlobalIdAllocator;
  /** Host-loaded names from launch.yaml; never employee-controlled configuration. */
  readonly launch_profiles?: readonly string[];
}
export interface EmployeeEffect {
  readonly data: Employee;
  readonly employees: readonly Employee[];
  readonly events: readonly GlobalEvent[];
}
