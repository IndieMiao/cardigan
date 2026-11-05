/** M4.T2: plan §3.3, §3.6–3.7; real loops/CLI/Git and read-only observations. */
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { git, type M4Cross, m4Cross } from "../test-support/m4-cross.js";
import { BackupExecutor } from "./reconcile-loop.js";

let f: M4Cross | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
}, 30_000);
const wait = <T>(read: () => T) =>
  expect.poll(read, { timeout: 10_000, interval: 30 });
const findings = (s: M4Cross) =>
  s.store().listReconcileFindings(s.card.project_id);

test("R01 §3.6: reconciliation reports once, survives restart, and announces a resolved orphan again", async () => {
  const s = await m4Cross();
  f = s;
  await s.start(s.primary.owner);
  const orphan = join(s.trees, "unowned");
  await mkdir(orphan);
  const notices = () =>
    s
      .state()
      .events.filter(
        (e) =>
          e.type === "reconcile_finding" &&
          JSON.stringify(e.payload).includes(orphan),
      );
  await s.restart();
  await wait(() => notices().length).toBe(1);
  const first = findings(s).find((x) => x.path === orphan);
  expect(first).toMatchObject({ kind: "orphan_worktree", resolved_at: null });
  expect(await s.cli("attention")).toContain(orphan);
  await wait(
    () => findings(s).find((x) => x.path === orphan)?.last_seen_at,
  ).not.toBe(first?.last_seen_at);
  expect(notices()).toHaveLength(1);
  expect(existsSync(orphan)).toBe(true);
  const lastSeen = findings(s).find((x) => x.path === orphan)?.last_seen_at;
  await s.restart();
  await wait(
    () => findings(s).find((x) => x.path === orphan)?.last_seen_at,
  ).not.toBe(lastSeen);
  expect(notices()).toHaveLength(1);
  expect(findings(s).find((x) => x.path === orphan)?.first_seen_at).toBe(
    first?.first_seen_at,
  );
  await rm(orphan, { recursive: true });
  await wait(
    () => findings(s).find((x) => x.path === orphan)?.resolved_at,
  ).toBeTruthy();
  await mkdir(orphan);
  await wait(() => notices().length).toBe(2);
  expect(existsSync(orphan)).toBe(true);
}, 30_000);

test("R02 §3.3: reconciliation repairs missing delivery pins from candidates, otherwise raises attention", async () => {
  const s = await m4Cross();
  f = s;
  const d = await s.deliver(
    s.primary,
    await s.change(s.primary.owner, "draft.txt", "saved\n"),
  );
  const ref = `refs/cardigan/deliveries/${d.id}`;
  git(s.center, "update-ref", "-d", ref);
  await s.restart();
  await wait(() => git(s.center, "rev-parse", "--verify", ref)).toBe(
    d.subject.value,
  );
  expect(
    findings(s).filter((x) => x.delivery_id === d.id && !x.resolved_at),
  ).toEqual([]);
  await s.restart(false);
  git(s.center, "update-ref", "-d", ref);
  git(
    s.center,
    "update-ref",
    "-d",
    `refs/cardigan/candidates/${s.primary.owner.id}/${d.subject.value}`,
  );
  await s.restart();
  await wait(() =>
    findings(s).some(
      (x) =>
        x.kind === "missing_delivery_ref" &&
        x.delivery_id === d.id &&
        !x.resolved_at,
    ),
  ).toBe(true);
  expect(await s.cli("attention")).toContain(d.id);
  expect(s.state().deliveries.find((x) => x.id === d.id)).toEqual(d);
}, 30_000);

test("R03 §3.7: backup loop saves unfinished commits; failed fetch keeps the previous ref and business state", async () => {
  const s = await m4Cross();
  f = s;
  const sha = await s.change(s.primary.owner, "unfinished.txt", "half done\n");
  const ref = `refs/cardigan/backups/local/${s.current(s.primary.owner).branch}`;
  await s.restart();
  await wait(() => git(s.center, "rev-parse", "--verify", ref)).toBe(sha);
  await s.restart(false);
  const before = s.state(),
    errors: unknown[] = [];
  const unavailable = `${s.repository}-unavailable`;
  await rename(s.repository, unavailable);
  try {
    await new BackupExecutor({
      store: s.store(),
      git: s.binding(),
      onError: (e) => errors.push(e),
      report: (e) => errors.push(e),
    }).tick();
    expect(errors.length).toBeGreaterThan(0);
    expect(git(s.center, "rev-parse", ref)).toBe(sha);
    expect(s.state().deliveries).toEqual(before.deliveries);
    expect(s.state().cards).toEqual(before.cards);
    expect(s.state().runs).toEqual(before.runs);
  } finally {
    await rename(unavailable, s.repository);
  }
});
