import { expect, test, vi } from "vitest";
import {
  activateMember,
  authorView,
  createMember,
  deactivateMember,
  employeeTextError,
  type Member,
  type MemberCommandPorts,
  parseId,
  transition,
  updateMember,
} from "../index.js";
import {
  actor,
  id,
  now,
  ports as projectPorts,
  value,
} from "./test-fixtures.js";

const human = { kind: "human" } as const;
const input = { name: " 所有者 ", title: " 所有者 ", role: "owner" } as const;
function ports(): MemberCommandPorts {
  const base = projectPorts();
  let n = 0;
  return {
    clock: base.clock,
    ids: {
      nextMemberId: vi.fn(() => id("member", ++n)),
      nextEventId: base.ids.nextEventId,
      nextEventSequence: vi.fn(() => base.ids.nextEventSequence("unused")),
    },
  };
}
const rejects = (result: unknown, code = "invariant_violation") =>
  expect(result).toMatchObject({ ok: false, error: { code } });

test("global owner lifecycle preserves exactly one active owner, identity and audit", () => {
  const p = ports();
  const first = value(createMember([], human, input, p));
  expect(first.data).toEqual({
    id: "M-1",
    name: "所有者",
    title: "所有者",
    role: "owner",
    status: "active",
    avatar: null,
    created_at: now,
    updated_at: now,
  });
  expect(first.events[0]).toMatchObject({
    type: "member_created",
    actor: human,
    payload: { member: first.data },
  });
  expect(first.data).not.toHaveProperty("project_id");
  rejects(createMember([first.data], human, input, p));
  rejects(deactivateMember([first.data], human, first.data.id, p));
  expect(p.ids.nextMemberId).toHaveBeenCalledTimes(1);
  expect(p.ids.nextEventSequence).toHaveBeenCalledTimes(1);
  const updated = value(
    updateMember(
      [first.data],
      human,
      first.data.id,
      { name: "　邵杰　", avatar: "library:liu-bei" },
      p,
    ),
  );
  expect(updated.data).toEqual({
    ...first.data,
    name: "邵杰",
    avatar: "library:liu-bei",
  });
  expect(updated.events[0]).toMatchObject({
    type: "member_updated",
    actor: human,
    payload: { member: updated.data },
  });
  expect(
    value(activateMember([updated.data], human, first.data.id, p)).events,
  ).toEqual([]);
  const inactive: Member = {
    ...first.data,
    id: id("member", 2),
    status: "inactive",
  };
  rejects(activateMember([updated.data, inactive], human, inactive.id, p));
  expect(
    value(deactivateMember([updated.data, inactive], human, inactive.id, p))
      .events,
  ).toEqual([]);
  // The recovery command can restore the invariant in an uninitialized legacy snapshot.
  expect(
    value(activateMember([inactive], human, inactive.id, p)).data.status,
  ).toBe("active");
  expect(transition("member", "active", "delete").ok).toBe(false);
  expect(parseId("member", "M-01").ok).toBe(false);
  expect(first.data.name).toBe("所有者");
});

test("all member mutations reject assignment and system actors without allocating or emitting", () => {
  const member = value(createMember([], human, input, ports())).data;
  for (const caller of [
    actor(),
    actor(2, "pm"),
    { kind: "system", project_id: "p" } as const,
  ]) {
    const p = ports();
    for (const result of [
      createMember([], caller, input, p),
      updateMember([member], caller, member.id, { name: "Changed" }, p),
      deactivateMember([member], caller, member.id, p),
      activateMember([member], caller, member.id, p),
    ])
      rejects(result, "forbidden_tool");
    expect(p.ids.nextMemberId).not.toHaveBeenCalled();
    expect(p.ids.nextEventSequence).not.toHaveBeenCalled();
  }
});

test("reserved roles and immutable fields cannot bypass the owner invariant", () => {
  const p = ports();
  for (const role of ["approver", "observer"] as const) {
    const result = createMember([], human, { ...input, role }, p);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "validation_failed",
        message: expect.stringContaining("暂不支持，等以后版本"),
      },
    });
  }
  const member = value(createMember([], human, input, p)).data;
  for (const patch of [
    { role: "observer" },
    { status: "inactive" },
    { id: "M-2" },
    { created_at: "changed" },
  ]) {
    rejects(
      updateMember(
        [member],
        human,
        member.id,
        { name: "Changed", ...patch },
        p,
      ),
      "validation_failed",
    );
  }
});

test("member fields share the employee text validation contract", () => {
  for (const name of [
    "",
    " ",
    "a\n",
    "a\u200b",
    "a\u2028",
    "字".repeat(41),
    "名字",
    "😀".repeat(40),
  ]) {
    const result = createMember([], human, { ...input, name }, ports());
    const error = employeeTextError(name, "名字", 40, true);
    if (error)
      expect(result).toMatchObject({ ok: false, error: { message: error } });
    else expect(result.ok).toBe(true);
  }
});

test("old and new human authors resolve the current owner without rewriting stored authors", () => {
  const owner = value(createMember([], human, input, ports())).data;
  const state = { assignments: [], members: [owner] };
  expect(authorView(state, "human")).toMatchObject({
    employee: null,
    author_display: "所有者",
    member: { id: "M-1", name: "所有者" },
  });
  const renamed = {
    ...owner,
    name: "邵杰",
    avatar: `upload:${"a".repeat(64)}`,
  };
  expect(authorView({ ...state, members: [renamed] }, "human")).toMatchObject({
    author_display: "邵杰",
    member: { name: "邵杰", title: "所有者", avatar: renamed.avatar },
  });
  expect(
    authorView(
      { ...state, members: [{ ...owner, status: "inactive" }] },
      "human",
    ),
  ).toMatchObject({ member: null, author_display: "所有者" });
  expect(authorView(state, "system").author_display).toBe("系统");
});
