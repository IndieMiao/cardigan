import { expect, test, vi } from "vitest";
import {
  activateEmployee,
  createEmployee,
  deactivateEmployee,
  type Employee,
  type EmployeeActor,
  type EmployeeCommandPorts,
  type EmployeeId,
  formatId,
  parseAvatarReference,
  parseId,
  transition,
  type UpdateEmployeeInput,
  updateEmployee,
} from "../index.js";
import { actor, now, ports as projectPorts, value } from "./test-fixtures.js";

const human = { kind: "human" } as const;
const input = { name: "诸葛亮", title: "产品经理", role_id: "pm" };
function ports(): EmployeeCommandPorts {
  const base = projectPorts();
  let n = 0;
  return {
    clock: base.clock,
    launch_profiles: ["fixture-profile"],
    ids: {
      nextEmployeeId: vi.fn(() => value(formatId("employee", ++n))),
      nextEventId: base.ids.nextEventId,
      nextEventSequence: vi.fn(() => base.ids.nextEventSequence("unused")),
    },
  };
}
const created = (p = ports(), fields = input) =>
  value(createEmployee([], human, fields, p)).data;
const rejects = (result: unknown, code = "validation_failed") =>
  expect(result).toMatchObject({ ok: false, error: { code } });

test.each(["active", "inactive"] as const)(
  "library characters remain exclusive for %s employees",
  (status) => {
    const p = ports();
    const first = value(
      createEmployee([], human, { ...input, avatar: "library:guan-yu" }, p),
    ).data;
    const occupied = { ...first, status };
    const before = JSON.stringify(occupied);
    const secondInput = { ...input, name: "另一位员工", avatar: first.avatar };
    const rejected = createEmployee([occupied], human, secondInput, p);
    rejects(rejected);
    expect(rejected).toMatchObject({
      error: { message: expect.stringContaining(first.id) },
    });
    expect(p.ids.nextEmployeeId).toHaveBeenCalledTimes(1);
    expect(p.ids.nextEventSequence).toHaveBeenCalledTimes(1);
    const second = value(
      createEmployee([occupied], human, { ...secondInput, avatar: null }, p),
    ).data;
    rejects(
      updateEmployee(
        [occupied, second],
        human,
        second.id,
        { avatar: first.avatar },
        p,
      ),
    );
    expect(
      value(updateEmployee([occupied], human, first.id, { title: "新职位" }, p))
        .data.avatar,
    ).toBe(first.avatar);
    expect(JSON.stringify(occupied)).toBe(before);
  },
);

test("uploaded avatars can be shared without reserving a library character", () => {
  const p = ports();
  const avatar = `upload:${"a".repeat(64)}`;
  const first = value(createEmployee([], human, { ...input, avatar }, p)).data;
  expect(
    createEmployee([first], human, { ...input, name: "另一位员工", avatar }, p)
      .ok,
  ).toBe(true);
});

test("avatar changes retain employee identity and human-only auditing", () => {
  const p = ports();
  const first = value(
    createEmployee([], human, { ...input, avatar: "library:guan-yu" }, p),
  );
  const before = JSON.stringify(first);
  const avatar = `upload:${"a".repeat(64)}`;
  rejects(
    updateEmployee([first.data], actor(), first.data.id, { avatar }, p),
    "forbidden_tool",
  );
  const changed = value(
    updateEmployee([first.data], human, first.data.id, { avatar }, p),
  );
  expect(changed.data).toEqual({ ...first.data, avatar });
  expect(changed.events[0]).toMatchObject({
    actor: human,
    payload: { employee: { avatar } },
  });
  expect(parseAvatarReference(changed.data.avatar)?.kind).toBe("upload");
  expect(JSON.stringify(first)).toBe(before);
});

test("global employee lifecycle preserves identity, role, creation time and audit snapshots", () => {
  const p = ports();
  const first = value(
    createEmployee(
      [],
      human,
      {
        ...input,
        name: "　诸葛 亮　",
        bio: "",
        avatar: "avatar:one",
        launch_profile_ref: "fixture-profile",
      },
      p,
    ),
  );
  const employee = first.data;
  expect(employee).toEqual({
    projects: [],
    id: "E-1",
    name: "诸葛 亮",
    title: "产品经理",
    bio: "",
    avatar: "avatar:one",
    role_id: "pm",
    launch_profile_ref: "fixture-profile",
    status: "active",
    created_at: now,
    updated_at: now,
  });
  expect(first.events[0]).toMatchObject({
    seq: 1,
    type: "employee_created",
    actor: human,
    payload: { employee },
  });
  expect(employee).not.toHaveProperty("project_id");
  const later = { ...p, clock: { now: () => "2026-01-02T00:00:00.000Z" } };
  const updated = value(
    updateEmployee(
      [employee],
      human,
      employee.id,
      { title: "开发", bio: "新简介", avatar: null, launch_profile_ref: null },
      later,
    ),
  );
  expect(updated.data).toMatchObject({
    id: employee.id,
    role_id: employee.role_id,
    created_at: now,
    updated_at: later.clock.now(),
    title: "开发",
    bio: "新简介",
    avatar: null,
    launch_profile_ref: null,
  });
  const inactive = value(
    deactivateEmployee([updated.data], human, employee.id, later),
  );
  expect(inactive.data.status).toBe("inactive");
  expect(
    value(deactivateEmployee([inactive.data], human, employee.id, later))
      .events,
  ).toEqual([]);
  const active = value(
    activateEmployee([inactive.data], human, employee.id, later),
  );
  expect(active.data.status).toBe("active");
  expect(
    value(activateEmployee([active.data], human, employee.id, later)).employees,
  ).toEqual([]);
  expect(first.events[0]?.payload).toEqual({ employee });
  expect(transition("employee", "active", "delete").ok).toBe(false);
});

test("active names are globally unique after trimming and full-width space normalization", () => {
  const p = ports();
  const first = created(p, { ...input, name: "诸葛　亮" });
  rejects(
    createEmployee(
      [first],
      { kind: "human", project_id: "another-project" },
      { ...input, name: " 诸葛 亮　" },
      p,
    ),
  );
  const inactive = value(deactivateEmployee([first], human, first.id, p)).data;
  const replacement = value(
    createEmployee([inactive], human, { ...input, name: first.name }, p),
  ).data;
  expect(replacement.id).toBe("E-2");
  rejects(activateEmployee([inactive, replacement], human, inactive.id, p));
  const renamed = value(
    updateEmployee(
      [inactive, replacement],
      human,
      inactive.id,
      { name: "孔明" },
      p,
    ),
  ).data;
  const active = value(
    activateEmployee([renamed, replacement], human, renamed.id, p),
  ).data;
  expect(active.status).toBe("active");
  rejects(
    updateEmployee(
      [active, replacement],
      human,
      replacement.id,
      { name: renamed.name },
      p,
    ),
  );
});

test.each([
  actor(1),
  actor(4, "pm"),
  { kind: "system", project_id: "p" } satisfies EmployeeActor,
])("only humans may mutate employees: %j", (unauthorized) => {
  const p = ports();
  const employee = created(p);
  for (const result of [
    createEmployee([], unauthorized, input, p),
    updateEmployee([employee], unauthorized, employee.id, { title: "其他" }, p),
    deactivateEmployee([employee], unauthorized, employee.id, p),
    activateEmployee(
      [{ ...employee, status: "inactive" }],
      unauthorized,
      employee.id,
      p,
    ),
  ])
    rejects(result, "forbidden_tool");
});

test.each([
  { name: "" },
  { name: "　 " },
  { name: "亮".repeat(41) },
  { title: " " },
  { title: "工".repeat(41) },
  { bio: "文".repeat(201) },
  { name: "\n亮" },
  { title: "开\t发" },
  { bio: "a\u0000b" },
  { bio: "a\u0085b" },
  { bio: "a\u202eb" },
  { name: "a\u2028b" },
  { title: "a\u2029b" },
  { avatar: "a\u001bb" },
  { role_id: "bad role" },
  { launch_profile_ref: "missing" },
])("rejects invalid fields without allocating IDs or events: %j", (patch) => {
  const p = ports();
  rejects(createEmployee([], human, { ...input, ...patch }, p));
  expect(p.ids.nextEmployeeId).not.toHaveBeenCalled();
  expect(p.ids.nextEventSequence).not.toHaveBeenCalled();
  if (!("role_id" in patch)) {
    const employee = created(p);
    rejects(updateEmployee([employee], human, employee.id, patch, p));
  }
});

test("length limits count Unicode characters and allow empty optional fields", () => {
  const p = ports();
  expect(
    createEmployee(
      [],
      human,
      {
        ...input,
        name: "😀".repeat(40),
        title: "职".repeat(40),
        bio: "简".repeat(200),
      },
      p,
    ).ok,
  ).toBe(true);
  expect(created().launch_profile_ref).toBeNull();
});

test("updates cannot change role, identity, status or audit fields; missing and malformed IDs fail", () => {
  const p = ports();
  const employee = created(p);
  for (const patch of [
    {},
    { role_id: "coder" },
    { id: "E-2" },
    { status: "inactive" },
    { created_at: "yesterday" },
  ])
    rejects(
      updateEmployee(
        [employee],
        human,
        employee.id,
        patch as UpdateEmployeeInput,
        p,
      ),
    );
  for (const command of [activateEmployee, deactivateEmployee]) {
    rejects(command([], human, employee.id, p), "not_found");
    rejects(command([], human, "E-01" as EmployeeId, p));
  }
  rejects(
    updateEmployee([], human, employee.id, { title: "职位" }, p),
    "not_found",
  );
  for (const id of ["E-0", "E--1", "E-1.5", "E-01", "E-9007199254740992"])
    expect(parseId("employee", id).ok).toBe(false);
});

test("unrelated edits and deactivation do not depend on an old launch profile still existing", () => {
  const p = ports();
  const employee: Employee = {
    ...created(p),
    launch_profile_ref: "removed-profile",
  };
  expect(
    updateEmployee([employee], human, employee.id, { bio: "修改简介" }, p).ok,
  ).toBe(true);
  expect(deactivateEmployee([employee], human, employee.id, p).ok).toBe(true);
  rejects(
    updateEmployee(
      [employee],
      human,
      employee.id,
      { launch_profile_ref: "removed-profile" },
      p,
    ),
  );
});

test.each([
  ["Alice", "alice"],
  ["Élodie", "éLODIE"],
  [" Alice　Smith ", "alice Smith"],
])(
  "case-insensitive names reject create/update/activate while preserving display case: %s",
  (name, duplicate) => {
    const p = ports();
    const first = created(p, { ...input, name });
    expect(first.name).toBe(name.replace(/\u3000/gu, " ").trim());
    rejects(createEmployee([first], human, { ...input, name: duplicate }, p));
    const other = created(p, { ...input, name: "Bob" });
    rejects(
      updateEmployee([first, other], human, other.id, { name: duplicate }, p),
    );
    const inactive = { ...other, name: duplicate, status: "inactive" as const };
    rejects(activateEmployee([first, inactive], human, inactive.id, p));
  },
);
