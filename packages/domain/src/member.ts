import type { Clock } from "./clock.js";
import type { Timestamp } from "./entities.js";
import type { GlobalActor, GlobalEvent, GlobalIdAllocator } from "./global.js";
import type { MemberId } from "./ids.js";
import type { MemberStatus } from "./states.js";

/** Global human identity. V11 supports only the single active owner. */
export interface Member {
  readonly id: MemberId;
  readonly name: string;
  readonly title: string;
  readonly avatar: string | null;
  readonly role: "owner" | "approver" | "observer";
  readonly status: MemberStatus;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export type MemberActor = GlobalActor;
export type MemberView = Pick<Member, "id" | "name" | "title" | "avatar">;
export function activeOwner(
  members: readonly Member[] = [],
): Member | undefined {
  return members.find(
    (member) => member.role === "owner" && member.status === "active",
  );
}
export interface MemberRepository {
  get(id: MemberId): Member | undefined;
  list(): readonly Member[];
  put(member: Member): void;
}
export interface MemberCommandPorts {
  readonly clock: Clock;
  readonly ids: Pick<
    GlobalIdAllocator,
    "nextMemberId" | "nextEventId" | "nextEventSequence"
  >;
}
export interface MemberEffect {
  readonly data: Member;
  readonly members: readonly Member[];
  readonly events: readonly GlobalEvent[];
}
