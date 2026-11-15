import {
  currentPreMergeVersions,
  recordMergeCheck,
  setProjectPreferences,
  updateCard,
} from "@cardigan/domain";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import type { MergeGit } from "./git.js";
import { MergeShadowObserver } from "./merge-shadow.js";

let f: ReturnType<typeof m3Fixture>;
beforeEach(() => {
  f = m3Fixture();
});
afterEach(() => f.close());
async function ready() {
  const office = f.office();
  f.store.uow.run((tx) => {
    tx.assignments.put(f.id, { ...office, standing_mode: "ops" });
    const existing = getRoleVersion(tx, f.id, "pm");
    if (!existing) throw new Error("role missing");
    // Fixture-only role registration, with the existing delegated-decision tool.
    writeRole(
      tx,
      f.id,
      {
        ...existing,
        version: 2,
        allowed_tools: [
          ...existing.allowed_tools,
          "resolve_delegated_decision",
        ],
      },
      { mode: "update" },
    );
    tx.assignments.put(f.id, {
      ...office,
      role_version: 2,
      standing_mode: "ops",
    });
  });
  f.start(f.coder);
  const product = (await f.delivery()).data;
  f.start(f.reviewer);
  f.review(product.id);
  f.finish(f.coder);
  f.start(f.coder);
  const completion = (await f.delivery("card_completion")).data;
  f.start(f.pm);
  f.review(completion.id, false, f.pm);
  f.apply((s, a, p) =>
    setProjectPreferences(
      s,
      a,
      {
        system_merge_shadow: true,
        system_merge_shadow_policy: {
          role_rule_paths: ["roles/**"],
          release_paths: ["release/**"],
        },
      },
      p,
    ),
  );
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    attempt_id: "shadow",
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  for (const status of ["queued", "running", "passed"] as const)
    f.apply(
      (s, a, p) =>
        recordMergeCheck(
          { ...s, project_settings: { merge_gate_enabled: true } },
          a,
          {
            ...identity,
            status,
            summary: "pass",
            log_ref: "shadow.log",
            checks: [
              {
                name: "unit",
                status: "passed" as const,
                exit_code: 0,
                duration_ms: 1,
              },
            ],
          },
          p,
        ),
      { kind: "system", project_id: f.id },
    );
  f.apply((s, a, p) =>
    updateCard(
      s,
      a,
      {
        card_id: f.card.id,
        merge_classification: {
          checked_versions: currentPreMergeVersions(
            f.card,
            s.work_items,
            s.deliveries,
          ),
          read_through_seq: Math.max(
            ...s.events
              .filter((e) => e.card_id === f.card.id)
              .map((e) => e.seq),
          ),
          risk_tags: [],
          risk_reviewed: true,
          is_ui: false,
          numeric_rules_approved: true,
          numeric_decision_ids: [],
          not_external_release: true,
          no_role_changes: true,
          timeline_reviewed: true,
        },
      },
      p,
    ),
  );
  const git = {
    projectOf: () => ({
      id: f.id,
      repo_path: "synthetic/repo",
      base_branch: "main",
    }),
    baseline: vi.fn(async () => "f".repeat(40)),
    changedPaths: vi.fn(async () => ["src/main.ts"]),
  } as unknown as MergeGit & { changedPaths: ReturnType<typeof vi.fn> };
  return { git, completion, product };
}
const shadows = () =>
  f.state().events.filter((e) => e.type === "system_merge_shadow_recorded");

test("C-238 real temporary store: restart deduplicates audit, router creates no merge/Run/notification, and preference off does no IO", async () => {
  const { git } = await ready();
  const before = f.state();
  const observer = new MergeShadowObserver(f.store, git, f.clock);
  await observer.tick(f.id);
  await observer.tick(f.id);
  expect(shadows()).toHaveLength(1);
  expect(shadows()[0]?.payload).toMatchObject({ would_confirm: true });
  expect(f.state().cards).toEqual(before.cards);
  expect(f.state().decisions).toEqual(before.decisions);
  routeProjectEvents(f.store, f.id, { clock: f.clock });
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .filter((n) => n.event_id === shadows()[0]?.id),
  ).toEqual([]);
  const restarted = Store.open({ dataDir: required(f.dataDir) });
  try {
    await new MergeShadowObserver(restarted, git, f.clock).tick(f.id);
  } finally {
    restarted.close();
  }
  expect(shadows()).toHaveLength(1);
  expect(f.state().runs).toEqual(before.runs);
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { system_merge_shadow: false }, p),
  );
  const calls = git.changedPaths.mock.calls.length;
  await observer.tick(f.id);
  expect(git.changedPaths).toHaveBeenCalledTimes(calls);
});

test.each(["comment", "delivery", "review", "disabled", "handoff"])(
  "C-238 fresh write transaction rejects %s arriving during Git IO",
  async (change) => {
    const { git, product } = await ready();
    git.changedPaths.mockImplementation(async () => {
      if (change === "comment") f.comment();
      if (change === "disabled")
        f.apply((s, a, p) =>
          setProjectPreferences(s, a, { system_merge_shadow: false }, p),
        );
      f.store.uow.run((tx) => {
        if (change === "delivery")
          tx.deliveries.put(f.id, {
            ...product,
            id: tx.ids.next(f.id, "delivery"),
          });
        if (change === "review") {
          const item = required(tx.work_items.get(f.id, f.verify.id));
          tx.work_items.put(f.id, { ...item, status: "failed" });
        }
        if (change === "handoff")
          for (const q of tx.decisions.list(f.id))
            if (q.trigger === "merge_confirmation")
              tx.decisions.put(f.id, {
                ...q,
                decider: "human",
                human_required_reason: "人工处理",
              });
      });
      return ["src/main.ts"];
    });
    await new MergeShadowObserver(f.store, git, f.clock).tick(f.id);
    if (change === "disabled") expect(shadows()).toHaveLength(0);
    else expect(shadows()[0]?.payload).toMatchObject({ would_confirm: false });
    expect(
      f.state().decisions.some((q) => q.resolution?.option === "merge"),
    ).toBe(false);
  },
);

test("C-238 failed Git evidence is uncertain and private errors are not recorded", async () => {
  const { git } = await ready();
  git.changedPaths.mockRejectedValue(new Error("private diagnostic"));
  await new MergeShadowObserver(f.store, git, f.clock).tick(f.id);
  expect(shadows()[0]?.payload).toMatchObject({ would_confirm: false });
  expect(JSON.stringify(shadows())).not.toContain("private diagnostic");
  expect(
    (
      required(shadows()[0]).payload as {
        conditions: { number: number; status: string }[];
      }
    ).conditions
      .filter((c) => [5, 6].includes(c.number))
      .every((c) => c.status === "uncertain"),
  ).toBe(true);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture value");
  return value;
}

test("C-238 failed audit transaction rolls back the record and replay can persist it once", async () => {
  const { git } = await ready();
  const before = f.state();
  f.store.database.exec(`CREATE TEMP TRIGGER fail_shadow_audit BEFORE INSERT ON timeline
    BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END;`);
  try {
    await expect(
      new MergeShadowObserver(f.store, git, f.clock).tick(f.id),
    ).rejects.toThrow("synthetic rollback");
  } finally {
    f.store.database.exec("DROP TRIGGER fail_shadow_audit");
  }
  expect(shadows()).toEqual([]);
  expect(f.state().cards).toEqual(before.cards);
  expect(f.state().decisions).toEqual(before.decisions);
  await new MergeShadowObserver(f.store, git, f.clock).tick(f.id);
  expect(shadows()).toHaveLength(1);
});

test("C-238 an advancing baseline during evidence sampling remains uncertain", async () => {
  const { git } = await ready();
  let calls = 0;
  git.baseline = async () => (++calls === 1 ? "f" : "e").repeat(40);
  await new MergeShadowObserver(f.store, git, f.clock).tick(f.id);
  expect(shadows()[0]?.payload).toMatchObject({
    would_confirm: false,
    base_sha: null,
  });
});
