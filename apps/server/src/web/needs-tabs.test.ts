import type { CommandState, Event } from "@cardigan/domain";
import { expect, test } from "vitest";
import { mergeFixture } from "../../../../packages/domain/src/commands/merge/test-fixtures.js";
import {
  id,
  now,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { call, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import { type needsYou, needsYouCounts, noticePage } from "./read.js";

test("counts and selected tab endpoints retain authentication, project isolation and the full endpoint", async () => {
  const f = await webHarness({ password: "synthetic-password" });
  try {
    seedWebProject(f.store, f.dataDir);
    const base = `/api/projects/${project_id}/needs-you`;
    expect((await call(f.port, `${base}/counts`)).status).toBe(401);
    expect((await call(f.port, `${base}?section=actions`)).status).toBe(401);
    const cookie = await f.login("synthetic-password");
    const full = (await call(f.port, base, { cookie })).json as ReturnType<
      typeof needsYou
    >;
    const summary = await call(f.port, `${base}/counts`, { cookie });
    expect(summary.status).toBe(200);
    const counts = summary.json as ReturnType<typeof needsYouCounts>;
    expect(Object.keys(summary.json as object).sort()).toEqual([
      "project_id",
      "tabs",
      "total_pending",
    ]);
    expect(counts.tabs.decisions.count).toBe(full.decisions.length);
    expect(counts.tabs.actions.count).toBe(
      full.human_actions.length +
        full.incidents.length +
        full.attention.length +
        full.system_rule_attention.length,
    );
    const actions = (await call(f.port, `${base}?section=actions`, { cookie }))
      .json as ReturnType<typeof needsYou>;
    const withoutAge = <T extends { readonly waited_ms: number | null }>(
      rows: readonly T[],
    ) => rows.map(({ waited_ms: _age, ...row }) => row);
    expect(withoutAge(actions.human_actions)).toEqual(
      withoutAge(full.human_actions),
    );
    expect(actions.decisions).toEqual([]);
    expect(actions.notices).toEqual([]);
    const decisions = (
      await call(f.port, `${base}?section=decisions`, { cookie })
    ).json as ReturnType<typeof needsYou>;
    expect(withoutAge(decisions.decisions)).toEqual(withoutAge(full.decisions));
    expect(decisions.human_actions).toEqual([]);
    expect(
      (await call(f.port, `${base}?section=unknown`, { cookie })).status,
    ).toBe(400);
    expect(
      (await call(f.port, "/api/projects/missing/needs-you/counts", { cookie }))
        .status,
    ).toBe(404);
  } finally {
    await f.close();
  }
});

test("notice sources distinguish auto_merge, actual timeout, PM and system maintenance without rewriting events", async () => {
  const f = mergeFixture();
  await f.accept();
  const q = f.state.decisions.find((q) => q.trigger === "merge_confirmation");
  if (!q) throw new Error("Missing merge fixture");
  const system = { kind: "system" as const, project_id: f.state.project_id };
  const event = (
    n: number,
    type: string,
    payload: Event["payload"],
    actor: Event["actor"] = system,
  ): Event => ({
    id: String(n).padStart(26, "0") as Event["id"],
    seq: n,
    type,
    actor,
    created_at: now,
    payload,
  });
  const resolved = (source: string, via = "delegated") => ({
    decision_id: q.id,
    option: "merge",
    via,
    proxy_authority: JSON.stringify({ source }),
  });
  const events = [
    event(
      1,
      "decision_resolved",
      resolved("project_preferences.auto_merge", "system_rule"),
    ),
    event(2, "decision_resolved", {
      ...resolved("project_preferences.auto_merge_after_minutes"),
      decision_id: id("decision", 902),
    }),
    event(3, "host_role_upgraded", { notice: "默认角色已自动升级" }),
    event(4, "standing_role_rotated", { notice: "常驻会话已自动轮换" }),
    event(
      5,
      "decision_resolved",
      { ...resolved("PM"), decision_id: id("decision", 905) },
      f.actor(f.pm),
    ),
  ];
  const state: CommandState = {
    ...f.state,
    events,
    decisions: [
      q,
      { ...q, id: id("decision", 902) },
      { ...q, id: id("decision", 905) },
    ],
  };
  const before = JSON.stringify(state);
  const list = noticePage(state).notices;
  expect(list.map((n) => [n.id, n.source])).toEqual([
    [events[4]?.id, "pm"],
    [events[3]?.id, "system"],
    [events[2]?.id, "system"],
    [events[1]?.id, "timed_merge"],
    [events[0]?.id, "auto_merge"],
  ]);
  expect(
    list
      .filter((n) => n.source === "system")
      .every((n) => n.author_display === "系统"),
  ).toBe(true);
  expect(needsYouCounts(state, now).tabs.notices).toEqual({
    count: 5,
    attention: 5,
  });
  expect(JSON.stringify(state)).toBe(before);
  for (const [authority, via, expected] of [
    ["{broken", "delegated", "system"],
    [null, "delegated", "system"],
    [
      JSON.stringify({
        source: "project_preferences.auto_merge_after_minutes",
      }),
      "system_rule",
      "system_merge",
    ],
  ] as const) {
    const unknown = {
      ...state,
      events: [
        event(10, "decision_resolved", {
          decision_id: q.id,
          option: "merge",
          via,
          proxy_authority: authority,
        }),
      ],
    };
    expect(noticePage(unknown).notices[0]?.source).toBe(expected);
  }
});
