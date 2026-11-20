import type {
  Assignment,
  Employee,
  ProjectId,
  TimelineEntryId,
} from "@cardigan/domain";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  assignment,
  fixture,
  id,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { call, webHarness } from "../../test-support/web.js";
import { requestRoute } from "./http.js";

const project = "p-test" as ProjectId;
const path = "/api/projects/p-test/cards/C-1/mentions";
let h: Awaited<ReturnType<typeof webHarness>>;
beforeEach(async () => {
  h = await webHarness({ password: "mention-test-password" });
  h.store.createProject({ id: project });
});
afterEach(async () => {
  await h.close();
});

const employee = (n: number, overrides: Partial<Employee> = {}): Employee => ({
  id: id("employee", n),
  name: `员工${n}`,
  title: `职位${n}`,
  bio: "",
  avatar: null,
  role_id: "coder",
  launch_profile_ref: null,
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** E-1/E-2 work on C-1, E-3 is the standing PM, E-4 only wrote on C-1,
 * E-5 works only on C-2 and E-6 has left. */
function seed() {
  const state = fixture();
  const employees = [
    employee(1, { avatar: "library:guan-yu" }),
    employee(2),
    employee(3),
    employee(4),
    employee(5),
    employee(6, { status: "inactive" }),
  ];
  const owner = new Map([
    ["A-1", 1],
    ["A-2", 2],
    ["A-4", 3],
  ]);
  const assignments: Assignment[] = [
    ...state.assignments.map((a) => {
      const n = owner.get(a.id);
      return n ? { ...a, employee_id: id("employee", n) } : a;
    }),
    {
      ...assignment(5),
      work_item_id: id("work_item", 5),
      employee_id: id("employee", 4),
    },
    {
      ...assignment(6),
      work_item_id: id("work_item", 6),
      employee_id: id("employee", 5),
    },
    {
      ...assignment(7),
      work_item_id: id("work_item", 7),
      employee_id: id("employee", 6),
    },
  ];
  const item = state.work_items[0];
  if (!item) throw new Error("Missing work item fixture");
  h.store.uow.run((tx) => {
    for (const e of employees) tx.employees.put(e);
    for (const card of state.cards) tx.cards.put(project, card);
    for (const w of state.work_items) tx.work_items.put(project, w);
    tx.work_items.put(project, {
      ...item,
      id: id("work_item", 6),
      card_id: id("card", 2),
      assignment_id: id("assignment", 6),
    });
    for (const a of assignments) tx.assignments.put(project, a);
    for (const [n, author] of [
      [1, "assignment:A-5"],
      [2, "assignment:A-7"],
      [3, "human"],
    ] as const)
      tx.timeline.put(project, {
        id: `C-1#${n}` as TimelineEntryId,
        short_id: `C-1#${n}` as TimelineEntryId,
        card_id: id("card", 1),
        event_seq: n,
        type: "comment",
        author,
        refs: [],
        retracted: false,
        body: "看过了",
        mentions: [],
        created_at: "2026-01-01T00:00:00.000Z",
      });
  });
}

test("C-514 mention candidates list active employees by public profile and mark the card's own people", async () => {
  seed();
  const cookie = await h.login("mention-test-password");
  const response = await call(h.port, path, { cookie });
  expect(response.status).toBe(200);
  expect(response.json).toEqual({
    employees: [
      {
        id: "E-1",
        name: "员工1",
        title: "职位1",
        avatar: "/avatars/v1/guan-yu/head-64.webp",
        related: true,
      },
      { id: "E-2", name: "员工2", title: "职位2", avatar: null, related: true },
      // Standing PM (Office/Ops) and authors seen anywhere on the card.
      { id: "E-3", name: "员工3", title: "职位3", avatar: null, related: true },
      { id: "E-4", name: "员工4", title: "职位4", avatar: null, related: true },
      // Works on another card only; E-6 has left and is not offered.
      {
        id: "E-5",
        name: "员工5",
        title: "职位5",
        avatar: null,
        related: false,
      },
    ],
  });
  // A released standing PM no longer belongs to the card.
  h.store.uow.run((tx) => {
    const pm = tx.assignments.get(project, id("assignment", 4));
    if (!pm) throw new Error("Missing standing PM");
    tx.assignments.put(project, { ...pm, status: "released" });
  });
  const released = await call(h.port, path, { cookie });
  expect(
    (released.json as { employees: { id: string; related: boolean }[] })
      .employees,
  ).toContainEqual(expect.objectContaining({ id: "E-3", related: false }));
});

test("C-514 mention candidates need a session, a known card and GET; the log route hides identifiers", async () => {
  seed();
  expect((await call(h.port, path)).status).toBe(401);
  const cookie = await h.login("mention-test-password");
  expect(
    (
      await call(h.port, "/api/projects/p-test/cards/C-404/mentions", {
        cookie,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call(h.port, path, {
        method: "POST",
        cookie,
        body: "{}",
        headers: {
          origin: `http://${h.hostHeader}`,
          "content-type": "application/json",
        },
      })
    ).status,
  ).toBe(405);
  expect(requestRoute(path)).toBe(
    "/api/projects/:project_id/cards/:id/mentions",
  );
});
