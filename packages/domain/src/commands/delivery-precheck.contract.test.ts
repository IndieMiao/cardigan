import { expect, test } from "vitest";
import {
  assign,
  autoAssignVerifier,
  type CommandState,
  currentDeliveryPrechecks,
  type DeliveryPrecheck,
  dispatchRun,
  hasPassedMergeCheck,
  hasRunTarget,
  latestDeliveryPrecheck,
  prepareDelivery,
  queueRun,
  recordDeliveryPrecheck,
  requestDeliveryPrecheck,
  retryDeliveryPrecheck,
  saveMachine,
  setProjectPreferences,
  submitDelivery,
  submitReview,
  verificationPrecheckPending,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  machine,
  now,
  ports,
  role,
  subject,
  value,
} from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
const verifier = id("work_item", 2);
function setup(risk = true) {
  const f = fixture();
  let s: CommandState = {
    ...f,
    cards: f.cards.map((c) => ({
      ...c,
      ...(risk ? { risk_tags: ["security" as const] } : {}),
    })),
    roles: [...f.roles, role("independent_reviewer")],
    assignments: f.assignments.map((a) =>
      a.id === id("assignment", 2)
        ? { ...a, role_id: "independent_reviewer" }
        : a,
    ),
    work_items: f.work_items.map((w) =>
      w.id === verifier ? { ...w, role_id: "independent_reviewer" } : w,
    ),
  };
  const io = ports();
  const deliver = async () => {
    const p = {
      work_item_id: id("work_item", 1),
      kind: "code" as const,
      summary: "Change",
      subject,
      requested_verifiers: [verifier],
    };
    const proof = value(
      await prepareDelivery(s, actor(), p, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    );
    const e = value(submitDelivery(s, actor(), p, proof, io));
    s = apply(s, e);
    return e.data;
  };
  const get = () =>
    latestDeliveryPrecheck(
      s.events,
      s.deliveries.find((d) => d.status !== "superseded")!,
    );
  const update = (patch: Partial<DeliveryPrecheck>) => {
    const e = value(
      recordDeliveryPrecheck(s, system, { ...get()!, ...patch }, io),
    );
    s = apply(s, e);
    return e;
  };
  const begin = () => {
    update({
      attempt_id: "attempt-1",
      candidate_sha: subject.value,
      tree_sha: "b".repeat(40),
      base_sha: "c".repeat(40),
    });
    update({ status: "running" });
  };
  return {
    state: () => s,
    set: (state: CommandState) => {
      s = state;
    },
    io,
    deliver,
    get,
    update,
    begin,
  };
}
test("risk deliveries queue exactly one precheck; ordinary deliveries do not", async () => {
  const f = setup();
  await f.deliver();
  expect(f.get()).toMatchObject({ status: "queued", subject });
  expect(
    f.state().events.filter((e) => e.type === "delivery_precheck_requested"),
  ).toHaveLength(1);
  const regular = setup(false);
  await regular.deliver();
  expect(regular.get()).toBeUndefined();
});
test("manual PM requests are project scoped, idempotent, and do not permit arbitrary execution", async () => {
  const f = setup(false),
    d = await f.deliver();
  for (const caller of [
    actor(),
    actor(2, "independent_reviewer"),
    { ...actor(4, "pm"), project_id: "foreign" },
  ])
    expect(
      requestDeliveryPrecheck(f.state(), caller, { delivery_id: d.id }, f.io)
        .ok,
    ).toBe(false);
  const e = value(
    requestDeliveryPrecheck(
      f.state(),
      actor(4, "pm"),
      { delivery_id: d.id },
      f.io,
    ),
  );
  f.set(apply(f.state(), e));
  expect(
    value(
      requestDeliveryPrecheck(
        f.state(),
        actor(4, "pm"),
        { delivery_id: d.id },
        f.io,
      ),
    ).events,
  ).toEqual([]);
  expect(
    recordDeliveryPrecheck(
      f.state(),
      actor(4, "pm"),
      { ...f.get()!, status: "passed", checks: [] },
      f.io,
    ).ok,
  ).toBe(false);
});
test.each([false, true])(
  "precheck blocks manual and automatic assignment (auto=%s), existing runs and reviews",
  async (enabled) => {
    const f = setup();
    const d = await f.deliver();
    const s = {
      ...f.state(),
      project_preferences: [
        {
          id: human.project_id,
          auto_merge_after_minutes: null,
          system_auto_assign_verifiers: enabled,
        },
      ],
    };
    expect(
      assign(
        s,
        actor(4, "pm"),
        { work_item_id: verifier, role_id: "independent_reviewer" },
        f.io,
      ).ok,
    ).toBe(false);
    expect(
      value(autoAssignVerifier(s, system, { work_item_id: verifier }, f.io))
        .changes,
    ).toEqual([]);
    expect(hasRunTarget(s.assignments[1]!, s)).toBe(false);
    expect(
      queueRun(
        s,
        system,
        {
          assignment_id: id("assignment", 2),
          model: "test",
          agent_cli_version: "test",
        },
        f.io,
      ).ok,
    ).toBe(false);
    expect(
      submitReview(
        s,
        actor(2, "independent_reviewer"),
        {
          delivery_id: d.id,
          target_sha: subject.value,
          kind: "code",
          issues: [],
        },
        f.io,
      ).ok,
    ).toBe(false);
    expect(s.reviews).toHaveLength(0);
  },
);
test("passed evidence releases independent review, never the final merge gate", async () => {
  const f = setup();
  const d = await f.deliver();
  f.begin();
  f.update({
    status: "passed",
    checks: [{ name: "test", status: "passed", exit_code: 0 }],
    log_ref: "attempt-1.log",
  });
  expect(hasRunTarget(f.state().assignments[1]!, f.state())).toBe(true);
  expect(
    hasPassedMergeCheck(f.state().events, id("card", 1), d.id, "b".repeat(40)),
  ).toBe(false);
  expect(
    submitReview(
      f.state(),
      actor(2, "independent_reviewer"),
      {
        delivery_id: d.id,
        target_sha: subject.value,
        kind: "code",
        issues: [],
      },
      f.io,
    ).ok,
  ).toBe(true);
});
test("real failures return the author without inventing a review or consuming its budget", async () => {
  const f = setup();
  await f.deliver();
  f.begin();
  f.update({
    status: "failed",
    checks: [{ name: "test", status: "failed", exit_code: 1 }],
    summary: "FAIL fixture.test.ts > invariant",
  });
  expect(
    f.state().work_items.find((w) => w.id === id("work_item", 1))?.status,
  ).toBe("changes_requested");
  expect(f.state().deliveries[0]?.status).toBe("rejected");
  expect(f.state().reviews).toEqual([]);
  expect(hasRunTarget(f.state().assignments[1]!, f.state())).toBe(false);
});
test("timeout automatically retries once per delivery; environment failures never return the author", async () => {
  const f = setup();
  await f.deliver();
  f.begin();
  f.update({
    status: "timed_out",
    checks: [{ name: "test", status: "timed_out" }],
    timeout_only: true,
  });
  expect(f.get()?.status).toBe("queued");
  expect(f.get()?.attempt_id).toBeUndefined();
  f.update({
    attempt_id: "attempt-2",
    candidate_sha: subject.value,
    tree_sha: "b".repeat(40),
    base_sha: "c".repeat(40),
  });
  f.update({ status: "running" });
  f.update({
    status: "timed_out",
    checks: [{ name: "test", status: "timed_out" }],
    timeout_only: true,
  });
  expect(f.get()?.status).toBe("timed_out");
  expect(f.state().deliveries[0]?.status).toBe("submitted");
  expect(
    retryDeliveryPrecheck(
      f.state(),
      system,
      { delivery_id: f.get()!.delivery_id },
      f.io,
    ).ok,
  ).toBe(false);
});
test("new delivery invalidates passed evidence; late results and forged subject/tree are rejected", async () => {
  const f = setup();
  const old = await f.deliver();
  f.begin();
  const prior = f.get()!;
  f.update({
    status: "passed",
    checks: [{ name: "test", status: "passed", exit_code: 0 }],
  });
  await f.deliver();
  expect(f.get()?.status).toBe("queued");
  expect(
    recordDeliveryPrecheck(
      f.state(),
      system,
      {
        ...prior,
        status: "passed",
        checks: [{ name: "test", status: "passed", exit_code: 0 }],
      },
      f.io,
    ).ok,
  ).toBe(false);
  expect(currentDeliveryPrechecks(f.state(), id("card", 1))).not.toContainEqual(
    expect.objectContaining({ delivery_id: old.id }),
  );
  expect(
    recordDeliveryPrecheck(
      f.state(),
      system,
      {
        ...f.get()!,
        attempt_id: "bad",
        candidate_sha: "d".repeat(40),
        tree_sha: "b".repeat(40),
        base_sha: "c".repeat(40),
      },
      f.io,
    ).ok,
  ).toBe(false);
});
test("ordinary review defaults to immediate; only human can change the preference; completion review is separate", async () => {
  const f = setup();
  await f.deliver();
  const w = {
    ...f.state().work_items.find((w) => w.id === verifier)!,
    role_id: "reviewer",
  };
  expect(verificationPrecheckPending(f.state(), w)).toBe(false);
  expect(
    setProjectPreferences(
      f.state(),
      actor(4, "pm"),
      { code_review_waits_for_precheck: true },
      f.io,
    ).ok,
  ).toBe(false);
  const e = value(
    setProjectPreferences(
      f.state(),
      human,
      { code_review_waits_for_precheck: true },
      f.io,
    ),
  );
  const s = apply(f.state(), e);
  expect(verificationPrecheckPending(s, w)).toBe(true);
  expect(
    verificationPrecheckPending(
      s,
      s.work_items.find((w) => w.id === id("work_item", 3))!,
    ),
  ).toBe(false);
  expect(e.events[0]?.type).toBe("project_preferences_updated");
});

test("first assignment and a previously queued run both wait; the saved queue can dispatch after a pass", async () => {
  const f = setup();
  await f.deliver();
  const original = f.state();
  const unassigned = {
    ...original,
    assignments: original.assignments.filter(
      (a) => a.id !== id("assignment", 2),
    ),
    work_items: original.work_items.map((w) => {
      if (w.id !== verifier) return w;
      const { assignment_id: _owner, ...rest } = w;
      return rest;
    }),
  };
  expect(
    assign(
      unassigned,
      human,
      { work_item_id: verifier, role_id: "independent_reviewer" },
      f.io,
    ).ok,
  ).toBe(false);
  f.set({
    ...original,
    runs: original.runs.map((r) =>
      r.assignment_id === id("assignment", 2)
        ? { ...r, status: "queued" as const }
        : r,
    ),
  });
  const p = {
    run_id: id("run", 2),
    runtime_ref: {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: "fixture",
      agent_name: "fixture",
    },
  };
  expect(dispatchRun(f.state(), system, p, f.io).ok).toBe(false);
  f.begin();
  f.update({
    status: "passed",
    checks: [{ name: "test", status: "passed", exit_code: 0 }],
  });
  expect(dispatchRun(f.state(), system, p, f.io).ok).toBe(true);
});
test("a pending check blocks completion even when the ordinary reviewers already passed", async () => {
  const f = setup(false);
  const d = await f.deliver();
  const reviewed = value(
    submitReview(
      f.state(),
      actor(2, "independent_reviewer"),
      {
        delivery_id: d.id,
        target_sha: subject.value,
        kind: "code",
        issues: [],
      },
      f.io,
    ),
  );
  f.set(apply(f.state(), reviewed));
  f.set(
    apply(
      f.state(),
      value(
        requestDeliveryPrecheck(f.state(), human, { delivery_id: d.id }, f.io),
      ),
    ),
  );
  const completion = {
    work_item_id: d.work_item_id,
    kind: "card_completion" as const,
    summary: "Done",
    subject,
    requested_verifiers: [id("work_item", 3)],
    plain_summary: { changed: "完成开发", impact: "待验收", risk: "无" },
  };
  expect(
    (
      await prepareDelivery(f.state(), actor(), completion, {
        verify: async () => ({ ok: true, value: [] }),
      })
    ).ok,
  ).toBe(false);
  f.begin();
  f.update({
    status: "failed",
    checks: [{ name: "test", status: "failed", exit_code: 1 }],
  });
  expect(f.state().deliveries.find((v) => v.id === d.id)?.status).toBe(
    "rejected",
  );
  expect(
    f.state().work_items.find((w) => w.id === d.work_item_id)?.status,
  ).toBe("changes_requested");
  expect(currentDeliveryPrechecks(f.state(), id("card", 1))[0]?.status).toBe(
    "failed",
  );
});
test.each([false, true])(
  "precheck waiting defers exhausted budgets with delegation enabled=%s until the check passes",
  async (delegation) => {
    const f = setup();
    f.set({
      ...f.state(),
      assignments: f
        .state()
        .assignments.map((a) =>
          a.scope === "standing" ? { ...a, standing_mode: "ops" as const } : a,
        ),
      project_preferences: [
        {
          id: human.project_id,
          auto_merge_after_minutes: null,
          independent_review_limit_delegation: delegation,
          independent_review_limit_delegation_max: 3,
        },
      ],
      reviews: [1, 2, 3].map((n) => ({
        id: id("review", n),
        work_item_id: verifier,
        delivery_id: id("delivery", n),
        run_id: id("run", 2),
        target_sha: subject.value,
        kind: "code" as const,
        issues: [],
        verdict: "pass" as const,
        blocking: false,
        recheck_required: false,
        attachments: [],
      })),
    });
    await f.deliver();
    expect(f.state().decisions).toEqual([]);
    f.begin();
    f.update({
      status: "passed",
      checks: [{ name: "test", status: "passed", exit_code: 0 }],
    });
    expect(f.state().decisions).toContainEqual(
      expect.objectContaining({
        trigger: "review_limit",
        decider: delegation ? "role:pm" : "human",
      }),
    );
    expect(f.state().reviews).toHaveLength(3);
  },
);

test("system auto assignment defers a first independent reviewer without a fallback notice, then assigns after passing", async () => {
  const f = setup();
  await f.deliver();
  const s = f.state();
  f.set({
    ...s,
    assignments: s.assignments.filter((a) => a.id !== id("assignment", 2)),
    runs: s.runs.filter((r) => r.assignment_id !== id("assignment", 2)),
    work_items: s.work_items.map((w) => {
      if (w.id !== verifier) return w;
      const { assignment_id: _owner, ...rest } = w;
      return rest;
    }),
    employees: [
      {
        id: id("employee", 7),
        name: "Fixture reviewer",
        title: "Reviewer",
        bio: "",
        avatar: null,
        role_id: "independent_reviewer",
        launch_profile_ref: null,
        status: "active",
        created_at: "2030-01-01",
        updated_at: "2030-01-01",
      },
    ],
    project_preferences: [
      {
        id: human.project_id,
        auto_merge_after_minutes: null,
        system_auto_assign_verifiers: true,
      },
    ],
  });
  const pending = value(
    autoAssignVerifier(f.state(), system, { work_item_id: verifier }, f.io),
  );
  expect(pending.events).toEqual([]);
  expect(pending.changes).toEqual([]);
  f.begin();
  f.update({
    status: "passed",
    checks: [{ name: "test", status: "passed", exit_code: 0 }],
  });
  const assigned = value(
    autoAssignVerifier(f.state(), system, { work_item_id: verifier }, f.io),
  );
  expect(assigned.data).toMatchObject({
    work_item_id: verifier,
    employee_id: id("employee", 7),
  });
});

test.each([
  [false, true],
  [true, true],
  [false, false],
  [true, false],
])(
  "closing the code-review wait preference durably releases ready targets (passed=%s, assigned=%s)",
  async (passed, assigned) => {
    const f = setup(false);
    f.set({
      ...f.state(),
      assignments: f
        .state()
        .assignments.map((a) =>
          a.id === id("assignment", 2) ? { ...a, role_id: "reviewer" } : a,
        ),
      work_items: f
        .state()
        .work_items.map((w) =>
          w.id === verifier ? { ...w, role_id: "reviewer" } : w,
        ),
    });
    const d = await f.deliver();
    f.set(
      apply(
        f.state(),
        value(
          requestDeliveryPrecheck(
            f.state(),
            human,
            { delivery_id: d.id },
            f.io,
          ),
        ),
      ),
    );
    f.set(
      apply(
        f.state(),
        value(
          setProjectPreferences(
            f.state(),
            human,
            { code_review_waits_for_precheck: true },
            f.io,
          ),
        ),
      ),
    );
    if (passed) {
      f.begin();
      f.update({
        status: "passed",
        checks: [{ name: "test", status: "passed", exit_code: 0 }],
      });
    }
    if (!assigned)
      f.set({
        ...f.state(),
        assignments: f
          .state()
          .assignments.filter((a) => a.id !== id("assignment", 2)),
        work_items: f.state().work_items.map((w) => {
          if (w.id !== verifier) return w;
          const { assignment_id: _owner, ...rest } = w;
          return rest;
        }),
      });
    const off = value(
      setProjectPreferences(
        f.state(),
        human,
        { code_review_waits_for_precheck: false },
        f.io,
      ),
    );
    const ready = off.events.filter(
      (e) => e.type === "delivery_precheck_wait_released",
    );
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      card_id: id("card", 1),
      payload: { delivery_id: d.id, work_item_id: verifier },
    });
    f.set(apply(f.state(), off));
    expect(
      value(
        setProjectPreferences(
          f.state(),
          human,
          { code_review_waits_for_precheck: false },
          f.io,
        ),
      ).events,
    ).toEqual([]);
    expect(f.state().reviews).toEqual([]);
  },
);

test("disabling the code-review preference does not release independent review or rejected targets", async () => {
  const f = setup();
  await f.deliver();
  f.set(
    apply(
      f.state(),
      value(
        setProjectPreferences(
          f.state(),
          human,
          { code_review_waits_for_precheck: true },
          f.io,
        ),
      ),
    ),
  );
  const off = value(
    setProjectPreferences(
      f.state(),
      human,
      { code_review_waits_for_precheck: false },
      f.io,
    ),
  );
  expect(
    off.events.some((e) => e.type === "delivery_precheck_wait_released"),
  ).toBe(false);
  expect(
    verificationPrecheckPending(
      apply(f.state(), off),
      f.state().work_items.find((w) => w.id === verifier)!,
    ),
  ).toBe(true);
});

test("releasing code-review waits rechecks exhausted budgets using the new preference", async () => {
  const f = setup();
  await f.deliver();
  f.set({
    ...f.state(),
    work_items: f
      .state()
      .work_items.map((w) =>
        w.id === verifier ? { ...w, role_id: "reviewer" } : w,
      ),
    reviews: [1, 2, 3].map((n) => ({
      id: id("review", n),
      work_item_id: verifier,
      delivery_id: id("delivery", n),
      run_id: id("run", 2),
      target_sha: subject.value,
      kind: "code" as const,
      issues: [],
      verdict: "pass" as const,
      blocking: false,
      recheck_required: false,
      attachments: [],
    })),
  });
  f.set(
    apply(
      f.state(),
      value(
        setProjectPreferences(
          f.state(),
          human,
          { code_review_waits_for_precheck: true },
          f.io,
        ),
      ),
    ),
  );
  const off = value(
    setProjectPreferences(
      f.state(),
      human,
      { code_review_waits_for_precheck: false },
      f.io,
    ),
  );
  const s = apply(f.state(), off);
  expect(s.decisions).toContainEqual(
    expect.objectContaining({ trigger: "review_limit" }),
  );
  expect(s.work_items.find((w) => w.id === verifier)?.status).toBe(
    "waiting_decision",
  );
  expect(
    off.events.some((e) => e.type === "delivery_precheck_wait_released"),
  ).toBe(false);
});

test.each(["manual", "automatic"] as const)(
  "precheck admission composes with registered machine selection (%s)",
  async (mode) => {
    const f = setup();
    const remote = {
      ...machine(),
      id: "review-worker",
      label: "Review worker",
      herdr_machine: "review-worker",
      tags: ["review"],
    };
    f.set({
      ...f.state(),
      assignments: f
        .state()
        .assignments.filter((a) => a.id !== id("assignment", 2)),
      runs: f
        .state()
        .runs.filter((r) => r.assignment_id !== id("assignment", 2)),
      work_items: f.state().work_items.map((w) => {
        if (w.id !== verifier) return w;
        const { assignment_id: _owner, ...rest } = w;
        return rest;
      }),
      roles: f
        .state()
        .roles.map((r) =>
          r.role_id === "independent_reviewer"
            ? { ...r, required_machine_tags: ["review"] }
            : r,
        ),
      employees: [
        {
          id: id("employee", 7),
          name: "Fixture reviewer",
          title: "Reviewer",
          bio: "",
          avatar: null,
          role_id: "independent_reviewer",
          launch_profile_ref: null,
          status: "active",
          created_at: now,
          updated_at: now,
        },
      ],
      project_preferences: [
        {
          id: human.project_id,
          auto_merge_after_minutes: null,
          system_auto_assign_verifiers: true,
        },
      ],
    });
    f.set(
      apply(
        f.state(),
        value(
          saveMachine(
            f.state(),
            human,
            { machine: remote, operation: "register" },
            f.io,
          ),
        ),
      ),
    );
    await f.deliver();
    const request = {
      work_item_id: verifier,
      role_id: "independent_reviewer",
      machine_id: remote.id,
    };
    const before = JSON.stringify(f.state());
    expect(assign(f.state(), human, request, f.io)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    const pending = value(
      autoAssignVerifier(f.state(), system, { work_item_id: verifier }, f.io),
    );
    expect(pending.changes).toEqual([]);
    expect(pending.events).toEqual([]);
    expect(pending.token_requests).toEqual([]);
    expect(JSON.stringify(f.state())).toBe(before);
    f.begin();
    f.update({
      status: "passed",
      checks: [{ name: "test", status: "passed", exit_code: 0 }],
    });
    expect(
      assign(
        f.state(),
        human,
        { ...request, machine_id: "unregistered-worker" },
        f.io,
      ).ok,
    ).toBe(false);
    expect(
      assign(f.state(), human, { ...request, machine_id: "local" }, f.io).ok,
    ).toBe(false);
    for (const status of ["offline", "draining"] as const) {
      const unavailable = {
        ...f.state(),
        machines:
          f
            .state()
            .machines?.map((m) =>
              m.id === remote.id ? { ...m, status } : m,
            ) ?? [],
      };
      expect(assign(unavailable, human, request, f.io).ok).toBe(false);
      const deferred = value(
        autoAssignVerifier(
          unavailable,
          system,
          { work_item_id: verifier },
          f.io,
        ),
      );
      expect(deferred.data).toBeNull();
      expect(deferred.token_requests).toEqual([]);
    }
    const selected = value(
      mode === "manual"
        ? assign(f.state(), human, request, f.io)
        : autoAssignVerifier(
            f.state(),
            system,
            { work_item_id: verifier },
            f.io,
          ),
    );
    if (!selected.data)
      throw new Error("Expected a reviewer assignment after precheck");
    const owner = selected.data;
    expect(owner.machine_id).toBe(remote.id);
    f.set(apply(f.state(), selected));
    expect(value(assign(f.state(), human, request, f.io)).data.id).toBe(
      owner.id,
    );
    expect(
      assign(f.state(), human, { ...request, machine_id: "local" }, f.io),
    ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
    // Registration and pinning do not authorize launching remote Runs through local runtime.
    expect(
      queueRun(
        f.state(),
        system,
        {
          assignment_id: owner.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        f.io,
      ),
    ).toMatchObject({
      ok: false,
      error: { message: "M2 supports local assignments only" },
    });
  },
);
