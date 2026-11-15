import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor, Event, ProjectId } from "@cardigan/domain";
import type {
  CheckRecoveryBinding,
  recoverCheckDirectory,
} from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  fixture,
  human,
  id,
  now,
} from "../../domain/src/commands/test-fixtures.js";
import { CheckRecovery } from "./check-recovery.js";
import { withCheckoutDeadline } from "./checkout-deadline.js";
import { CHECKOUT_LIMITS } from "./checkout-limits.js";
import type { MergeGateExecutor } from "./merge-gate-executors.js";
import type { CheckoutInput } from "./temporary-checkout.js";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

test("rejects registration if the executor changed while the check was starting", () => {
  const f = setup();
  f.check("running");
  f.changeExecutor();
  expect(f.register).toThrow("Unverified check recovery registration");
});

test("a late registration callback cannot bind an already timed-out checkout", async () => {
  vi.useFakeTimers();
  const registered = vi.fn();
  let captured: CheckoutInput | undefined;
  const result = withCheckoutDeadline(
    {
      execution: { mode: "local", dataDir: "/fixture" },
      project: "p",
      sha: "a".repeat(40),
      tree: "b".repeat(40),
      checks: [{ name: "fixture", run: "true" }],
      totalTimeoutMs: 1,
      onRegistered: registered,
    },
    (input) => {
      captured = input;
      return new Promise(() => {});
    },
  );
  await vi.advanceTimersByTimeAsync(1 + CHECKOUT_LIMITS.graceMs);
  await result;
  captured?.onRegistered?.(binding);
  expect(registered).not.toHaveBeenCalled();
});
const binding: CheckRecoveryBinding = {
  git_layout: "bare",
  registration_name: "worktree",
  container: { device: "1", inode: "11", uid: 1234 },
  worktree: { device: "1", inode: "12", uid: 1234 },
  repository: { device: "1", inode: "13", uid: 1234 },
  registration: { device: "1", inode: "14", uid: 1234 },
};
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing recovery fixture");
  return value;
}
function registrationId(f: ReturnType<typeof setup>) {
  return required(
    f.events().find((e) => e.type === "merge_check_checkout_registered"),
  ).id;
}
function setup(dbPath = ":memory:") {
  const store = Store.open({ dbPath });
  stores.push(store);
  const project = human.project_id,
    card = id("card", 1),
    sha = "a".repeat(40);
  store.createProject({ id: project });
  store.uow.run((tx) => {
    for (const c of fixture().cards) tx.cards.put(project, c);
  });
  let executor: MergeGateExecutor = {
    name: "fixture",
    host: "fixture.invalid",
    port: 22,
    user: "agent",
    hostKeyAlias: "fixture",
    identityFile: "/fixture/key",
    knownHostsFile: "/fixture/known-hosts",
    agentRoot: "/agent",
    maxConcurrent: 1,
  };
  const events = () =>
    store.uow.read((tx) => tx.events.listAfter(project, card, 0));
  const append = (
    type: string,
    payload: Event["payload"],
    actor: Actor = { kind: "system", project_id: project },
  ) =>
    store.uow.run((tx) =>
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, card),
        card_id: card,
        type,
        payload,
        actor,
        created_at: now,
      }),
    );
  const check = (status: string, actor?: Actor) =>
    append(
      status === "running"
        ? "merge_check_started"
        : status === "queued"
          ? "merge_check_queued"
          : "merge_check_finished",
      { attempt_id: "attempt", candidate_sha: sha, status },
      actor,
    );
  const recover = vi.fn<typeof recoverCheckDirectory>(
    async (_execution, request) => {
      request.confirmAbsence();
      return { status: "cleaned", reason: "complete", processes: [] };
    },
  );
  let at = Date.parse(now);
  const advance = (milliseconds = 60_000) => {
    at += milliseconds;
  };
  const options = {
    inspectionIntervalMs: 60_000,
    store,
    clock: { now: () => new Date(at).toISOString() },
    execution: { mode: "local" as const, dataDir: "/fixture" },
    executor: () => executor,
    recover,
  };
  const service = new CheckRecovery(options);
  const executedOn = executor;
  const register = () =>
    service.register(project, card, "attempt", sha, binding, executedOn);
  return {
    service,
    advance,
    register,
    check,
    events,
    append,
    recover,
    options,
    project,
    card,
    changeExecutor: () => {
      executor = { ...executor, host: "different.invalid" };
    },
  };
}

test("only an authenticated running check can bind directory instances once", () => {
  const f = setup();
  expect(f.register).toThrow();
  f.check("queued");
  expect(f.register).toThrow();
  f.check("running", human);
  expect(f.register).toThrow();
  f.check("running");
  f.register();
  expect(f.register).toThrow();
  expect(
    f.events().filter((e) => e.type === "merge_check_checkout_registered"),
  ).toHaveLength(1);
});

test("unknown directories and active attempts are never recovery candidates", async () => {
  const f = setup();
  f.check("failed");
  await f.service.sweep(f.project);
  f.check("running");
  f.register();
  await f.service.sweep(f.project);
  f.check("queued");
  await f.service.sweep(f.project);
  expect(f.recover).not.toHaveBeenCalled();
});

test("reobserves confirmed absence after a restart without repeating the notice", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed");
  f.recover.mockImplementation(async (_execution, request) => {
    // Audit publication is atomic with the changed result, after IO.
    request.confirmAbsence();

    return { status: "cleaned", reason: "complete", processes: [] };
  });
  await f.service.sweep(f.project);
  f.advance();
  await new CheckRecovery(f.options).sweep(f.project);
  expect(f.recover).toHaveBeenCalledTimes(2);
  expect(f.events().at(-1)?.payload).toMatchObject({
    status: "cleaned",
    attempt_id: "attempt",
  });
  expect(
    f.options.store.uow
      .read((tx) => tx.timeline.list(f.project))
      .filter((e) => e.body.includes("记录已核销")),
  ).toHaveLength(1);
});

test.each([false, true])(
  "a reappearing target overrides cleaned on the next patrol (reopen=%s)",
  async (reopen) => {
    const root = mkdtempSync(join(tmpdir(), "check-recovery-store-"));
    directories.push(root);
    const dbPath = join(root, "state.sqlite");
    const f = setup(dbPath);
    f.check("running");
    f.register();
    f.check("failed");
    await f.service.sweep(f.project);
    f.recover.mockResolvedValue({
      status: "manual_attention",
      reason: "unverified",
      processes: [],
    });
    let store = f.options.store;
    if (reopen) {
      stores.splice(stores.indexOf(store), 1);
      store.close();
      store = Store.open({ dbPath });
      stores.push(store);
    }
    const service = reopen
      ? new CheckRecovery({ ...f.options, store })
      : f.service;
    f.advance();
    await service.sweep(f.project);
    f.advance();
    await service.sweep(f.project);
    expect(f.recover).toHaveBeenCalledTimes(3);
    const events = store.uow.read((tx) =>
      tx.events.listAfter(f.project, f.card, 0),
    );
    expect(events.at(-1)?.payload).toMatchObject({
      status: "manual_attention",
    });
    const notices = store.uow
      .read((tx) => tx.timeline.list(f.project))
      .map((e) => e.body);
    expect(notices.filter((body) => body.includes("记录已核销"))).toHaveLength(
      1,
    );
    expect(notices.filter((body) => body.includes("待人工处理"))).toHaveLength(
      1,
    );
  },
);

test("does not execute a newly registered target using the sweep's earlier executor", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed");
  const current = f.options.executor();
  const replacement = new CheckRecovery({
    ...f.options,
    executor: vi
      .fn()
      .mockReturnValueOnce({ ...current, host: "earlier.invalid" })
      .mockReturnValue(current),
  });
  await replacement.sweep(f.project);
  expect(f.recover).not.toHaveBeenCalled();
});

test("a target change after absence confirmation cannot be persisted as cleaned", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed");
  f.recover.mockImplementationOnce(async (_execution, request) => {
    request.confirmAbsence();
    f.changeExecutor();
    return { status: "cleaned", reason: "complete", processes: [] };
  });
  await f.service.sweep(f.project);
  expect(f.events().at(-1)?.payload).toMatchObject({
    status: "manual_attention",
    reason: "unverified",
  });
});

test("occupied evidence is durable; a later retry can confirm completed manual cleanup", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("timed_out");
  f.recover.mockResolvedValueOnce({
    status: "manual_attention",
    reason: "occupied",
    processes: [{ pid: 12, state: "D", wchan: "exit_mm" }],
  });
  await f.service.sweep(f.project);
  expect(f.events().at(-1)?.payload).toMatchObject({
    status: "manual_attention",
    processes: [{ pid: 12, state: "D", wchan: "exit_mm" }],
  });
  f.service.recheck(human, f.project, registrationId(f));
  await f.service.sweep(f.project);
  expect(f.recover.mock.calls[1]?.[1]).not.toHaveProperty("resume");
  expect(f.events().at(-1)?.payload).toMatchObject({ status: "cleaned" });
});

test("lost transport after an absence observation requires a fresh observation", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("interrupted");
  f.recover.mockImplementationOnce(async (_execution, request) => {
    request.confirmAbsence();
    throw new Error("private remote diagnostic");
  });
  await f.service.sweep(f.project);
  f.advance();
  await new CheckRecovery(f.options).sweep(f.project);
  expect(f.recover.mock.calls[1]?.[1]).not.toHaveProperty("resume");
  expect(JSON.stringify(f.events())).not.toContain("private remote diagnostic");
});

test.each(["executor", "status"])(
  "rechecks %s in a fresh transaction before confirming absence",
  async (change) => {
    const f = setup();
    f.check("running");
    f.register();
    f.check("failed");
    f.recover.mockImplementationOnce(async (_execution, request) => {
      if (change === "executor") f.changeExecutor();
      else f.check("running");
      request.confirmAbsence();
      throw new Error("should not confirm absence");
    });
    await f.service.sweep(f.project);
    expect(
      f
        .events()
        .some((e) => e.type === "merge_check_recovery_absence_confirmed"),
    ).toBe(false);
    expect(f.events().at(-1)?.payload).toMatchObject({
      status: "manual_attention",
    });
  },
);

test("ignores a forged terminal event and never switches a persisted attempt to another executor", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed", human);
  await f.service.sweep(f.project);
  expect(f.recover).not.toHaveBeenCalled();
  f.check("failed");
  f.changeExecutor();
  await f.service.sweep(f.project);
  expect(f.recover).not.toHaveBeenCalled();
  await f.service.sweep("another-project" as ProjectId);
  expect(f.recover).not.toHaveBeenCalled();
});

test("a clear snapshot without exclusion remains manual, with no destructive journal or repeat notice", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed");
  f.recover.mockResolvedValue({
    status: "manual_attention",
    reason: "exclusion_unproven",
    processes: [],
  });
  await f.service.sweep(f.project);
  await f.service.sweep(f.project);
  expect(
    f.events().filter((e) => e.type === "merge_check_recovery_requested"),
  ).toHaveLength(1);
  expect(
    f
      .events()
      .some(
        (e) =>
          e.type === "merge_check_recovery_deleting" ||
          e.type === "merge_check_recovery_absence_confirmed",
      ),
  ).toBe(false);
  const notices = f.options.store.uow
    .read((tx) => tx.timeline.list(f.project))
    .filter((e) => e.body.includes("不能阻止扫描后的新占用"));
  expect(notices).toHaveLength(1);
});

test("100 dispatches plus a restart never repeat fast recovery; explicit recheck reactivates it", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed");
  f.recover.mockResolvedValue({
    status: "manual_attention",
    reason: "unverified",
    stage: "registration",
    evidence: "a".repeat(64),
    processes: [],
  });
  await f.service.sweep(f.project);
  f.recover.mockImplementation(async (_execution, input) => {
    expect(input.observeOnly).toBe(true);
    return {
      status: "manual_attention",
      reason: "unverified",
      stage: "presence",
      evidence: "a".repeat(64),
      processes: [],
    };
  });
  const service = new CheckRecovery(f.options);
  for (let tick = 0; tick < 100; tick++) {
    f.advance();
    await service.sweep(f.project);
  }
  const registration = registrationId(f);
  expect(
    f.events().filter((e) => e.type === "merge_check_recovery_requested"),
  ).toHaveLength(1);
  f.service.recheck(human, f.project, registration);
  f.recover.mockImplementationOnce(async (_execution, input) => {
    expect(input.observeOnly).toBeUndefined();
    return {
      status: "manual_attention",
      reason: "unverified",
      stage: "registration",
      evidence: "a".repeat(64),
      processes: [],
    };
  });
  await service.sweep(f.project);
  expect(
    f
      .events()
      .filter((e) => e.type === "merge_check_recovery_recheck_requested"),
  ).toHaveLength(1);
  expect(
    f.events().filter((e) => e.type === "merge_check_recovery_finished"),
  ).toHaveLength(1);
});

test("25 unchanged registrations over 60 simulated minutes and a database reopen add zero events, timeline entries and notifications", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-recovery-counts-"));
  directories.push(root);
  const dbPath = join(root, "fixture.sqlite");
  const f = setup(dbPath),
    executor = f.options.executor(),
    sha = "a".repeat(40);
  f.options.inspectionIntervalMs = 300_000;
  for (let n = 0; n < 25; n++) {
    const attempt_id = `attempt-${n}`;
    f.append("merge_check_started", {
      attempt_id,
      candidate_sha: sha,
      status: "running",
    });
    f.service.register(f.project, f.card, attempt_id, sha, binding, executor);
    f.append("merge_check_finished", {
      attempt_id,
      candidate_sha: sha,
      status: "failed",
    });
  }
  f.recover.mockImplementation(async (_execution, input) => ({
    status: "manual_attention",
    reason: "unverified",
    stage: input.observeOnly ? "presence" : "registration",
    evidence: "a".repeat(64),
    processes: [],
  }));
  let store = f.options.store,
    service = f.service;
  const counts = () => ({
    events: Number(
      store.database
        .prepare(
          "SELECT count(*) AS n FROM events WHERE type LIKE 'merge_check_recovery_%'",
        )
        .get()?.n,
    ),
    timeline: Number(
      store.database.prepare("SELECT count(*) AS n FROM timeline").get()?.n,
    ),
    notifications: Number(
      store.database.prepare("SELECT count(*) AS n FROM notifications").get()
        ?.n,
    ),
  });
  await service.sweep(f.project);
  const first = counts();
  expect(first).toEqual({ events: 50, timeline: 25, notifications: 0 });
  for (let minute = 0; minute < 60; minute++) {
    f.advance();
    if (minute === 30) {
      stores.splice(stores.indexOf(store), 1);
      store.close();
      store = Store.open({ dbPath });
      stores.push(store);
      service = new CheckRecovery({ ...f.options, store });
    }
    await service.sweep(f.project);
  }
  expect(counts()).toEqual(first);
  expect(
    f.recover.mock.calls.filter(([, input]) => !input.observeOnly),
  ).toHaveLength(25);
  expect(
    f.recover.mock.calls.filter(([, input]) => input.observeOnly),
  ).toHaveLength(300);
  f.advance(300_000);
  f.recover.mockImplementation(async (_execution, input) => ({
    status: "manual_attention",
    reason: "unverified",
    stage: input.observeOnly ? "presence" : "registration",
    evidence: "b".repeat(64),
    processes: [],
  }));
  await service.sweep(f.project);
  expect(counts()).toEqual(first); // evidence refresh alone is not a business transition
  f.advance(300_000);
  f.recover.mockImplementation(async (_execution, input) => ({
    status: "manual_attention",
    reason: input.observeOnly ? "unverified" : "occupied",
    stage: input.observeOnly ? "presence" : "processes",
    evidence: "c".repeat(64),
    processes: input.observeOnly
      ? []
      : [{ pid: 12, state: "D", wchan: "exit_mm" }],
  }));
  await service.sweep(f.project);
  expect(counts()).toEqual({ events: 100, timeline: 50, notifications: 0 });
  f.advance(300_000);
  await service.sweep(f.project);
  expect(counts()).toEqual({ events: 100, timeline: 50, notifications: 0 });
  console.info(
    "C-329 synthetic counts",
    JSON.stringify({
      registrations: 25,
      minutes: 60,
      inspectionIntervalMs: 300_000,
      fastCallsBeforeChange: 25,
      lightweightCallsBeforeChange: 300,
      reopens: 1,
      first,
      unchangedAdded: { events: 0, timeline: 0, notifications: 0 },
      changedAdded: { events: 50, timeline: 25, notifications: 0 },
    }),
  );
}, 15_000);

test("concurrent connections reserve one inspection; superseding recheck fences a late result", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-recovery-concurrent-"));
  directories.push(root);
  const dbPath = join(root, "state.sqlite"),
    f = setup(dbPath);
  const other = Store.open({ dbPath });
  stores.push(other);
  f.check("running");
  f.register();
  f.check("failed");
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.recover.mockImplementationOnce(async () => {
    await waiting;
    return { status: "manual_attention", reason: "unverified", processes: [] };
  });
  const work = f.service.sweep(f.project);
  await new CheckRecovery({ ...f.options, store: other }).sweep(f.project);
  expect(f.recover).toHaveBeenCalledTimes(1);
  const registration = registrationId(f);
  f.service.recheck(human, f.project, registration);
  release();
  await work;
  expect(
    f.events().filter((e) => e.type === "merge_check_recovery_finished"),
  ).toHaveLength(0);
  await f.service.sweep(f.project);
  expect(f.recover).toHaveBeenCalledTimes(2);
});

test("the original handoff fence blocks recovery IO and a fence raised during IO prevents cleaned publication", async () => {
  const { CheckHandoffs } = await import("@cardigan/store");
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed");
  const facts = new CheckHandoffs(f.options.store, "controller");
  facts.begin(f.project, f.options.executor().name, "binding");
  await expect(f.service.sweep(f.project)).rejects.toThrow("围栏");
  expect(f.recover).not.toHaveBeenCalled();
  const g = setup();
  g.check("running");
  g.register();
  g.check("failed");
  g.recover.mockImplementationOnce(async (_execution, input) => {
    input.confirmAbsence();
    new CheckHandoffs(g.options.store, "controller").begin(
      g.project,
      g.options.executor().name,
      "binding",
    );
    return { status: "cleaned", reason: "complete", processes: [] };
  });
  await g.service.sweep(g.project);
  expect(
    g.events().some((e) => e.type === "merge_check_recovery_finished"),
  ).toBe(false);
});

test("cleaned evidence is revisited and authenticated reappearance causes exactly one manual transition", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed");
  f.recover.mockImplementationOnce(async (_execution, input) => {
    input.confirmAbsence();
    return {
      status: "cleaned",
      reason: "complete",
      stage: "absence",
      evidence: "a".repeat(64),
      processes: [],
    };
  });
  await f.service.sweep(f.project);
  f.advance();
  f.recover.mockImplementation(async (_execution, input) => ({
    status: "manual_attention",
    reason: input.observeOnly ? "unverified" : "exclusion_unproven",
    stage: input.observeOnly ? "presence" : "exclusion",
    evidence: "b".repeat(64),
    processes: [],
  }));
  await new CheckRecovery(f.options).sweep(f.project);
  f.advance();
  await f.service.sweep(f.project);
  expect(f.recover.mock.calls.map(([, i]) => !!i.observeOnly)).toEqual([
    false,
    true,
    false,
    true,
  ]);
  expect(
    f
      .events()
      .filter((e) => e.type === "merge_check_recovery_finished")
      .map((e) => (e.payload as { status: string }).status),
  ).toEqual(["cleaned", "manual_attention"]);
});

test("a failed audit publication rolls back outcome, event pair and timeline together", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed");
  f.recover.mockResolvedValue({
    status: "manual_attention",
    reason: "unverified",
    processes: [],
  });
  f.options.store.database.exec(
    "CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON events WHEN NEW.type='merge_check_recovery_finished' BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END",
  );
  await expect(f.service.sweep(f.project)).rejects.toThrow(
    "synthetic publication failure",
  );
  const journal = new (await import("@cardigan/store")).CheckRecoveryJournal(
    f.options.store,
  );
  expect(journal.get(f.project, registrationId(f))).toMatchObject({
    state: "pending",
    result: undefined,
  });
  expect(
    f.events().filter((e) => e.type.startsWith("merge_check_recovery_")),
  ).toHaveLength(0);
  expect(
    f.options.store.uow.read((tx) => tx.timeline.list(f.project)),
  ).toHaveLength(0);
  f.options.store.database.exec("DROP TRIGGER reject_recovery_audit");
  f.advance();
  await f.service.sweep(f.project);
  expect(
    f.events().filter((e) => e.type === "merge_check_recovery_finished"),
  ).toHaveLength(1);
});

test("Q-618 defaults to five minutes across services, then performs only a lightweight safety inspection", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed");
  const { inspectionIntervalMs: _fixtureInterval, ...options } = f.options;
  const service = new CheckRecovery(options);
  f.recover.mockResolvedValue({
    status: "manual_attention",
    reason: "unverified",
    stage: "registration",
    evidence: "a".repeat(64),
    processes: [],
  });
  await service.sweep(f.project);
  for (let minute = 0; minute < 4; minute++) {
    f.advance();
    await new CheckRecovery(options).sweep(f.project);
  }
  expect(f.recover).toHaveBeenCalledOnce();
  f.recover.mockResolvedValue({
    status: "manual_attention",
    reason: "unverified",
    stage: "presence",
    evidence: "a".repeat(64),
    processes: [],
  });
  f.advance();
  await new CheckRecovery(options).sweep(f.project);
  expect(f.recover).toHaveBeenCalledTimes(2);
  expect(f.recover.mock.calls.at(-1)?.[1].observeOnly).toBe(true);
  expect(
    f.events().filter((e) => e.type === "merge_check_recovery_finished"),
  ).toHaveLength(1);
});

test("unchanged existence evidence still rechecks current ownership before retaining cleaned", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed");
  f.recover.mockImplementationOnce(async (_execution, input) => {
    input.confirmAbsence();
    return {
      status: "cleaned",
      reason: "complete",
      stage: "absence",
      evidence: "a".repeat(64),
      processes: [],
    };
  });
  await f.service.sweep(f.project);
  f.advance();
  f.recover.mockImplementationOnce(async () => {
    f.changeExecutor();
    return {
      status: "manual_attention",
      reason: "unverified",
      stage: "presence",
      evidence: "a".repeat(64),
      processes: [],
    };
  });
  await f.service.sweep(f.project);
  expect(f.events().at(-1)?.payload).toMatchObject({
    status: "manual_attention",
    stage: "ownership",
  });
});

test("a publication handoff read failure rejects the sweep without publishing an outcome", async () => {
  const f = setup();
  f.options.inspectionIntervalMs = 300_000;
  f.check("running");
  f.register();
  f.check("failed");
  let recovered = false,
    injected = 0;
  const failure = new Error("synthetic handoff-read storage failure");
  f.recover.mockImplementation(async () => {
    recovered = true;
    return {
      status: "manual_attention",
      reason: "unverified",
      stage: "target_identity",
      processes: [],
    };
  });
  const database = f.options.store.database,
    prepare = database.prepare.bind(database);
  const spy = vi.spyOn(database, "prepare").mockImplementation((sql) => {
    if (recovered && sql.includes("SELECT * FROM check_handoff")) {
      injected++;
      throw failure;
    }
    return prepare(sql);
  });
  let observed: unknown;
  try {
    await f.service.sweep(f.project);
  } catch (error) {
    observed = error;
  } finally {
    spy.mockRestore();
  }
  expect(observed).toBe(failure);
  expect(injected).toBe(1);
  const journal = new (await import("@cardigan/store")).CheckRecoveryJournal(
    f.options.store,
  );
  const registration = journal.get(f.project, registrationId(f));
  expect(registration).toMatchObject({
    state: "pending",
    result: undefined,
    next_inspection_at: new Date(Date.parse(now) + 300_000).toISOString(),
  });
  expect(
    f.events().filter((e) => e.type.startsWith("merge_check_recovery_")),
  ).toHaveLength(0);
  expect(
    f.options.store.uow.read((tx) => tx.timeline.list(f.project)),
  ).toHaveLength(0);
  console.info(
    "C-329 handoff read failure",
    JSON.stringify({
      injected,
      rejected: observed === failure,
      state: registration?.state,
      result: registration?.result ?? null,
      recoveryEvents: 0,
    }),
  );
  f.advance(300_000);
  await new CheckRecovery(f.options).sweep(f.project);
  expect(
    f.events().filter((e) => e.type === "merge_check_recovery_finished"),
  ).toHaveLength(1);
});
