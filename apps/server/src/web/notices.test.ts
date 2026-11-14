import type { CommandState, Event } from "@cardigan/domain";
import { routeEvent } from "@cardigan/router";
import { expect, test } from "vitest";
import { independentReviewLimitFixture } from "../../../../packages/domain/src/commands/independent-review-limit/test-fixtures.js";
import {
  actor,
  assignment,
  fixture,
  id,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { call, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import { needsYou, noticePage, webAuthorView } from "./read.js";

test("independent review grants route to Ops and their audited standing authorization appears in notices", async () => {
  const t = independentReviewLimitFixture();
  await t.limited();
  const event = t.f.state.events.at(-1);
  if (!event) throw new Error("Missing decision event");
  expect(
    routeEvent({ event, snapshot: t.f.state }).notifications.map(
      (n) => n.recipient.kind,
    ),
  ).toEqual(["pm_ops"]);
  t.f.commit(t.resolve());
  const notices = noticePage(t.f.state).notices;
  expect(notices).toHaveLength(1);
  expect(JSON.stringify(notices)).toContain("按常驻授权代批独立复核增加一轮");
  expect(JSON.stringify(notices)).toContain("加轮不等于复核通过或确认合并");
  expect(
    needsYou(t.f.state, "2026-01-02T00:00:00.000Z").counts.notices_unread,
  ).toBe(1);
});

function noticeState(readCount: number, unreadCount: number): CommandState {
  const events: Event[] = Array.from(
    { length: readCount + unreadCount },
    (_, index) => ({
      id: String(index + 1).padStart(26, "0") as Event["id"],
      seq: index + 1,
      type: "decision_resolved",
      actor: actor(1, "pm"),
      payload: {
        decision_id: `q(${index + 1})`,
        via: "delegated",
        option: "go",
      },
      // Ties across streams must be broken by event ID, not sequence.
      created_at: "2026-01-01T00:00:00.000Z",
    }),
  );
  events.push({
    id: "read-event" as Event["id"],
    seq: events.length + 1,
    type: "notices_read",
    actor: { kind: "human", project_id: "fixture-project" },
    payload: { notice_ids: events.slice(unreadCount).map((e) => e.id) },
    created_at: "2026-01-02T00:00:00.000Z",
  });
  return { ...fixture(), events };
}

test("Needs You returns all unread first and pages read history by stable cursor beyond the old cap", () => {
  const state = noticeState(23, 55);
  const before = JSON.stringify(state);
  const initial = needsYou(state, "2026-01-02T00:00:00.000Z");
  expect(initial.notices).toHaveLength(65);
  expect(initial.notices.slice(0, 55).every((n) => !n.read)).toBe(true);
  expect(initial.notices.slice(55).every((n) => n.read)).toBe(true);
  expect(initial.counts.notices_unread).toBe(55);
  const cursor = initial.notices_next_cursor;
  expect(cursor).toBe(initial.notices.at(-1)?.id);
  const second = noticePage(state, cursor ?? undefined);
  expect(second.notices).toHaveLength(10);
  // A newly inserted notice and an older unread notice marked read do not
  // shift the next page, even with equal timestamps.
  const inserted = state.events[0];
  if (!inserted) throw new Error("Missing fixture");
  const changed = {
    ...state,
    events: [
      ...state.events,
      {
        ...inserted,
        id: "99999999999999999999999999" as Event["id"],
        payload: { ...(inserted.payload as object), decision_id: "Q-999" },
      },
      {
        ...inserted,
        id: "another-read-event" as Event["id"],
        type: "notices_read",
        payload: { notice_ids: [state.events[54]?.id] },
      },
    ],
  };
  expect(noticePage(changed, cursor ?? undefined)).toMatchObject({
    notices: second.notices,
    unread_count: 55,
  });
  expect(
    noticePage(changed, second.next_cursor ?? undefined).notices,
  ).toHaveLength(4);
  const last = noticePage(state, second.next_cursor ?? undefined);
  expect(last.notices).toHaveLength(3);
  expect(last.next_cursor).toBeNull();
  const read = [
    ...initial.notices.slice(55),
    ...second.notices,
    ...last.notices,
  ];
  expect(new Set(read.map((n) => n.id)).size).toBe(23);
  expect(read.map((n) => n.id)).toEqual(
    read
      .map((n) => n.id)
      .sort()
      .reverse(),
  );
  expect(JSON.stringify(state)).toBe(before);
  expect(noticePage(noticeState(0, 0))).toEqual({
    notices: [],
    next_cursor: null,
    unread_count: 0,
  });
  expect(noticePage(noticeState(10, 0)).next_cursor).toBeNull();
});

test("notice pages require login, validate project and cursor, and preserve unread counts", async () => {
  const harness = await webHarness({ password: "notice-test-password" });
  try {
    seedWebProject(harness.store, harness.dataDir);
    harness.store.uow.run((tx) => {
      for (const event of noticeState(11, 2).events)
        tx.events.append(project_id, {
          ...event,
          seq: tx.ids.nextEventSequence(project_id),
          actor: { ...event.actor, project_id },
        });
    });
    const path = `/api/projects/${project_id}/notices`;
    expect((await call(harness.port, path)).status).toBe(401);
    const cookie = await harness.login("notice-test-password");
    const initial = await call(harness.port, path, { cookie });
    expect(initial.status).toBe(200);
    const page = initial.json as ReturnType<typeof noticePage>;
    expect(page.notices).toHaveLength(12);
    const next = await call(
      harness.port,
      `${path}?before=${page.next_cursor}`,
      { cookie },
    );
    expect(next.status).toBe(200);
    expect(next.json).toMatchObject({
      notices: [expect.objectContaining({ read: true })],
      next_cursor: null,
      unread_count: 2,
    });
    expect(
      (await call(harness.port, `${path}?before=missing`, { cookie })).status,
    ).toBe(400);
    expect(
      (await call(harness.port, `${path}?before=`, { cookie })).status,
    ).toBe(400);
    expect(
      (await call(harness.port, "/api/projects/missing/notices", { cookie }))
        .status,
    ).toBe(404);
  } finally {
    await harness.close();
  }
});

test("anonymous standing PM names come from stored mode while employees and ordinary roles retain their names", () => {
  const base = assignment(1, "pm");
  const { work_item_id: _workItem, ...standing } = base;
  for (const [mode, name] of [
    ["ops", "PM 后台（PM Ops）"],
    ["office", "PM 前台（PM Office）"],
  ] as const) {
    const state: CommandState = {
      ...fixture(),
      assignments: [
        {
          ...standing,
          scope: "standing",
          standing_mode: mode,
          status: "released",
        },
      ],
    };
    expect(webAuthorView(state, "assignment:A-1").author_display).toBe(name);
    expect(
      webAuthorView({ ...state, assignments: [base] }, "assignment:A-1")
        .author_display,
    ).toBe("未命名的 pm");
    expect(
      webAuthorView(
        {
          ...state,
          employees: [
            {
              id: id("employee", 1),
              name: "张良",
              title: "平台负责人",
              bio: "",
              avatar: null,
              role_id: "pm",
              launch_profile_ref: null,
              status: "active",
              created_at: "2026-01-01",
              updated_at: "2026-01-01",
            },
          ],
          assignments: state.assignments.map((a) => ({
            ...a,
            employee_id: id("employee", 1),
          })),
        },
        "assignment:A-1",
      ).author_display,
    ).toBe("张良");
  }
  expect(webAuthorView(fixture(), "assignment:A-2").author_display).toBe(
    "未命名的 reviewer",
  );
  expect(webAuthorView(fixture(), "assignment:A-999").author_display).toBe(
    "未命名的 未知角色",
  );
});
