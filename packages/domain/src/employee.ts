import type { Clock } from "./clock.js";
import type { Actor, Event, Timestamp } from "./entities.js";
import type { EmployeeId, EventId, RoleId } from "./ids.js";
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
  readonly actor: { readonly kind: "human" | "system" };
};

/** Preserve display case while normalizing surrounding and full-width spaces. */
export function employeeDisplayName(name: string): string {
  return name.replace(/\u3000/gu, " ").trim();
}

/** Name uniqueness and lookup use Unicode lowercase, independent of locale. */
export function employeeNameKey(name: string): string {
  return employeeDisplayName(name).toLowerCase();
}

/** Shared by human edits and launch compilation of persisted employee text. */
export function employeeTextError(
  value: unknown,
  label: string,
  limit?: number,
  required = false,
): string | undefined {
  if (typeof value !== "string") return `${label}必须是文本`;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
    return `${label}不能含控制字符或换行`;
  if (required && value.trim().length === 0) return `${label}不能为空`;
  if (limit !== undefined && Array.from(value.trim()).length > limit)
    return `${label}最多 ${limit} 字`;
  return undefined;
}

export interface EmployeeActivity {
  readonly employee_id: EmployeeId;
  readonly last_assigned_at: Timestamp | null;
  readonly unfinished_runs: number;
}

export interface EmployeeRepository {
  get(id: EmployeeId): Employee | undefined;
  list(): readonly Employee[];
  put(employee: Employee): void;
  /** Across all projects, read in the same transaction as assign. */
  assignmentActivity?(): readonly EmployeeActivity[];
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
