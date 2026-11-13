import { expect, test } from "vitest";
import type { EmployeeRepository } from "../employee.js";
import type { Event } from "../entities.js";
import type { MemberRepository } from "../member.js";
import type { EventRepository, Repositories } from "../ports.js";
import type { CommandDraft, CommandEntities, CommandState } from "./core.js";

/**
 * C-231: the per-snapshot indexes (`eventById`, `hasRunTarget`,
 * `hostOpsPending`, `CommandDraft.get`, the host capacity queue) are keyed by
 * array identity, so they rely on command state collections never being
 * mutated in place. This file is checked by `pnpm --filter @cardigan/domain
 * test:types`: it stops compiling if a collection or a repository read becomes
 * mutable, or if an in-place write starts type-checking.
 */

// Keys whose (non-optional) value is a mutable array. Must stay empty.
type MutableArrayKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends unknown[] ? K : never;
}[keyof T];
type ReadonlyArrayKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends readonly unknown[] ? K : never;
}[keyof T];
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

type ListResult<R> = R extends { list(...args: never[]): infer L } ? L : never;
type RepositoryLists = {
  [K in Exclude<keyof Repositories, "events">]: ListResult<Repositories[K]>;
};

export type ReadonlyContract = [
  // No CommandState collection is a mutable array...
  Expect<Equal<MutableArrayKeys<CommandState>, never>>,
  // ...and every collection the draft indexes is a (readonly) array.
  Expect<
    Equal<
      Exclude<keyof CommandEntities, ReadonlyArrayKeys<CommandState>>,
      never
    >
  >,
  Expect<
    Equal<
      Exclude<"events" | "timeline" | "roles", ReadonlyArrayKeys<CommandState>>,
      never
    >
  >,
  // Store/backends hand out the same arrays they cache: reads stay readonly.
  Expect<Equal<MutableArrayKeys<RepositoryLists>, never>>,
  Expect<
    Equal<ReturnType<EventRepository["listAfter"]> extends unknown[] ? 1 : 0, 0>
  >,
  Expect<
    Equal<ReturnType<EmployeeRepository["list"]> extends unknown[] ? 1 : 0, 0>
  >,
  Expect<
    Equal<ReturnType<MemberRepository["list"]> extends unknown[] ? 1 : 0, 0>
  >,
];

/** Never called: each line must fail to compile. */
function inPlaceWritesDoNotCompile(
  state: CommandState,
  draft: CommandDraft,
  repositories: Repositories,
  event: Event,
  run: CommandEntities["runs"],
  item: CommandEntities["work_items"],
  assignment: CommandEntities["assignments"],
  cursor: CommandEntities["cursors"],
  other: {
    readonly item: CommandEntities["work_items"];
    readonly event: Event;
  },
) {
  // @ts-expect-error events are readonly
  state.events.push(event);
  // @ts-expect-error deliveries are readonly
  state.deliveries.splice(0, 1);
  // @ts-expect-error work_items are readonly
  state.work_items.sort();
  // @ts-expect-error runs are readonly
  state.runs.reverse();
  // @ts-expect-error assignments are readonly
  state.assignments[0] = assignment;
  // @ts-expect-error cards are readonly
  state.cards.length = 0;
  // @ts-expect-error card_templates are readonly
  state.card_templates?.pop();
  // @ts-expect-error the draft's base state is the same snapshot
  draft.state.cursors.push(cursor);
  // @ts-expect-error a repository read returns the cached array
  repositories.runs.list(state.project_id).push(run);
  // @ts-expect-error event streams are cached too
  repositories.events.listAfter(state.project_id, undefined, 0).push(event);
  // @ts-expect-error entities are immutable as well (indexes read their keys)
  item.card_id = other.item.card_id;
  // @ts-expect-error event ids are what `eventById` indexes
  event.id = other.event.id;
}

test("command state collections are readonly at compile time", () => {
  // The guarantees above are checked by tsc (test:types); keep the function referenced.
  expect(typeof inPlaceWritesDoNotCompile).toBe("function");
});
