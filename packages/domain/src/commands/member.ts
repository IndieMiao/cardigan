import { employeeDisplayName, employeeTextError } from "../employee.js";
import type { Result } from "../errors.js";
import { type MemberId, parseId } from "../ids.js";
import type {
  Member,
  MemberActor,
  MemberCommandPorts,
  MemberEffect,
} from "../member.js";
import { transition } from "../transitions.js";
import { attempt, ensure, unwrap } from "./core.js";

export type CreateMemberInput = Pick<Member, "name" | "title" | "role"> & {
  readonly avatar?: string | null;
};
export type UpdateMemberInput = Partial<
  Pick<Member, "name" | "title" | "avatar">
>;

function human(actor: MemberActor): void {
  ensure(actor.kind === "human", "forbidden_tool", "只有人可以管理成员");
}
function validate(
  member: Omit<Member, "id"> & { readonly id?: MemberId },
  others: readonly Member[],
): void {
  for (const [value, label, limit] of [
    [member.name, "名字", 40],
    [member.title, "职位", 40],
    [member.avatar, "头像引用", undefined],
  ] as const) {
    if (label === "头像引用" && value === null) continue;
    const error = employeeTextError(value, label, limit, true);
    ensure(error === undefined, "validation_failed", error ?? "成员字段不合法");
  }
  ensure(
    member.role === "owner",
    "validation_failed",
    "此成员角色暂不支持，等以后版本",
  );
  const owners = [
    ...others.filter((other) => other.id !== member.id),
    member,
  ].filter((other) => other.role === "owner" && other.status === "active");
  ensure(
    owners.length === 1,
    "invariant_violation",
    "必须恰好有一个在职所有者，不能新增第二个或停用最后一个所有者",
  );
}
function effect(
  member: Member,
  type: string,
  ports: MemberCommandPorts,
): MemberEffect {
  return {
    data: member,
    members: [member],
    events: [
      {
        id: ports.ids.nextEventId(),
        seq: ports.ids.nextEventSequence(),
        type,
        actor: { kind: "human" },
        payload: { member: { ...member } },
        created_at: member.updated_at,
      },
    ],
  };
}
function find(members: readonly Member[], id: MemberId): Member {
  ensure(
    parseId("member", id).ok,
    "validation_failed",
    "成员编号必须为 M-n（正整数）",
  );
  const member = members.find((value) => value.id === id);
  ensure(member, "not_found", `成员 ${id} 不存在`);
  return member;
}
export function createMember(
  members: readonly Member[],
  actor: MemberActor,
  input: CreateMemberInput,
  ports: MemberCommandPorts,
): Result<MemberEffect> {
  return attempt(() => {
    human(actor);
    const now = ports.clock.now();
    const member: Omit<Member, "id"> = {
      name: input.name,
      title: input.title,
      role: input.role,
      avatar: input.avatar ?? null,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    validate(member, members);
    return effect(
      {
        ...member,
        id: ports.ids.nextMemberId(),
        name: employeeDisplayName(member.name),
        title: member.title.trim(),
      },
      "member_created",
      ports,
    );
  });
}
export function updateMember(
  members: readonly Member[],
  actor: MemberActor,
  id: MemberId,
  input: UpdateMemberInput,
  ports: MemberCommandPorts,
): Result<MemberEffect> {
  return attempt(() => {
    human(actor);
    const previous = find(members, id);
    const keys = Object.keys(input);
    ensure(keys.length > 0, "validation_failed", "至少指定一个成员修改字段");
    ensure(
      keys.every((key) => ["name", "title", "avatar"].includes(key)),
      "validation_failed",
      "不支持修改成员编号、角色、状态或审计字段",
    );
    const member = { ...previous, ...input, updated_at: ports.clock.now() };
    validate(member, members);
    return effect(
      {
        ...member,
        name: employeeDisplayName(member.name),
        title: member.title.trim(),
      },
      "member_updated",
      ports,
    );
  });
}
function changeStatus(
  members: readonly Member[],
  actor: MemberActor,
  id: MemberId,
  action: "activate" | "deactivate",
  ports: MemberCommandPorts,
): Result<MemberEffect> {
  return attempt(() => {
    human(actor);
    const previous = find(members, id);
    if (previous.status === (action === "activate" ? "active" : "inactive")) {
      validate(previous, members);
      return { data: previous, members: [], events: [] };
    }
    const member = {
      ...previous,
      status: unwrap(transition("member", previous.status, action)),
      updated_at: ports.clock.now(),
    };
    validate(member, members);
    return effect(
      member,
      action === "activate" ? "member_activated" : "member_deactivated",
      ports,
    );
  });
}
export function activateMember(
  members: readonly Member[],
  actor: MemberActor,
  id: MemberId,
  ports: MemberCommandPorts,
): Result<MemberEffect> {
  return changeStatus(members, actor, id, "activate", ports);
}
export function deactivateMember(
  members: readonly Member[],
  actor: MemberActor,
  id: MemberId,
  ports: MemberCommandPorts,
): Result<MemberEffect> {
  return changeStatus(members, actor, id, "deactivate", ports);
}
