import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun } from "@cardigan/domain";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { standingResolver, startControlPlane } from "./assembly.js";

let f: ReturnType<typeof dispatchFixture>;
beforeEach(() => {
  f = dispatchFixture();
  // Consume the bootstrap events so a tick does not route them again.
  const streams = f.store.uow.read((tx) => [
    PROJECT_EVENT_STREAM,
    ...tx.cards.list(f.project).map((card) => card.id),
  ]);
  for (const stream of streams)
    f.store.advanceRouterCursor(
      f.project,
      stream,
      f.store.getUpdates({ project_id: f.project }).latest_seq,
    );
});
afterEach(() => f.close());

/** A standing pm Assignment whose newest token carries `tools`. */
function standingPm(tools: readonly string[]): string {
  return f.store.uow.run((tx) => {
    const assignment = {
      id: "A-90".replace(
        "90",
        String(90 + tx.assignments.list(f.project).length),
      ),
      scope: "standing",
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      machine_id: "local",
      runtime_ref: null,
      mcp_token_id: "pm",
      created_at: f.clock.now(),
    } as never;
    tx.assignments.put(f.project, assignment);
    tx.issueToken({
      project_id: f.project,
      assignment_id: (assignment as { id: string }).id as never,
      role: { role_version: 1, allowed_tools: tools as never },
      token: `fixture-${Math.random().toString(36).slice(2)}`,
    });
    return (assignment as { id: string }).id;
  });
}

test("the standing resolver tells PM Office and PM Ops apart by their newest token", () => {
  const office = standingPm(["create_card", "record_decision"]);
  const ops = standingPm(["create_card", "assign"]);
  const state = f.state();
  const resolve = standingResolver(f.store);
  expect(resolve(f.project, "pm_office", state)).toBe(office);
  expect(resolve(f.project, "pm_ops", state)).toBe(ops);
});

test("a pm role version without record_decision cannot be Office", () => {
  const ops = standingPm(["create_card", "assign"]);
  const resolve = standingResolver(f.store);
  expect(resolve(f.project, "pm_office", f.state())).toBeUndefined();
  expect(resolve(f.project, "pm_ops", f.state())).toBe(ops);
});

test("the control plane starts a loop that stops cleanly and drains", async () => {
  const target = f.create();
  const runtime = {
    status: vi.fn(async () => ({
      ok: true as const,
      value: { process: "alive" as const, agent: "working", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true as const, value: { sent: true } })),
    provision: async () => {
      throw new Error("unused");
    },
    release: async () => ({ ok: true as const, value: undefined }),
    interrupt: async () => ({ ok: true as const, value: undefined }),
    resume_or_replace: async () => ({
      ok: false as const,
      error: { code: "runtime_unavailable" as const, message: "unused" },
    }),
    human_entry: async () => ({ ok: true as const, value: "attach" }),
    // No runtime events: the monitor subscribes but stays quiet.
    async *events() {
      yield* [] as never[];
    },
  };
  const plane = startControlPlane({
    store: f.store,
    runtime,
    intervalMs: 5,
    snapshot: async () => ({ model: "m", agent_cli_version: "c" }),
    startRun: async ({ run, assignment }) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          { run_id: run.id, runtime_ref: f.refFor(assignment) },
          p,
        ),
      );
    },
    onError: () => {},
  });
  // Give the first tick a chance, then drain.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await plane.stop();
  await plane.done;
  // stop() is idempotent and never leaves a pending tick.
  await plane.stop();
  expect(target.assignment.status).toBe("active");
});

test("a failing tick is reported and the loop keeps running", async () => {
  const errors: unknown[] = [];
  let ticks = 0;
  const plane = startControlPlane({
    store: f.store,
    runtime: {
      status: async () => ({ ok: true, value: { process: "gone" } }),
      wake: async () => ({ ok: true, value: { sent: true } }),
      provision: async () => ({
        ok: false,
        error: { code: "runtime_unavailable", message: "x" },
      }),
      release: async () => ({ ok: true, value: undefined }),
      interrupt: async () => ({ ok: true, value: undefined }),
      resume_or_replace: async () => ({
        ok: false,
        error: { code: "runtime_unavailable", message: "x" },
      }),
      human_entry: async () => ({ ok: true, value: "" }),
      async *events() {
        yield* [] as never[];
      },
    },
    intervalMs: 5,
    snapshot: async () => ({ model: "m", agent_cli_version: "c" }),
    startRun: async () => {},
    onError: (error) => errors.push(error),
  });
  // A store that throws on tick proves the loop survives a failure.
  const original = f.store.listProjects.bind(f.store);
  (
    f.store as unknown as { listProjects: typeof f.store.listProjects }
  ).listProjects = () => {
    ticks += 1;
    if (ticks === 1) throw new Error("boom");
    return original();
  };
  await new Promise((resolve) => setTimeout(resolve, 40));
  await plane.stop();
  expect(errors.map(String)).toContain("Error: boom");
  expect(ticks).toBeGreaterThan(1);
});

test("the control plane sweeps orphaned attachment blobs when it knows the data dir", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-plane-attachments-"));
  const directory = join(dataDir, "attachments");
  mkdirSync(directory, { recursive: true });
  const orphan = join(directory, "a".repeat(64));
  writeFileSync(orphan, "orphan");
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(orphan, old, old);
  const runtime = {
    status: async () => ({
      ok: true as const,
      value: { process: "gone" as const },
    }),
    wake: async () => ({ ok: true as const, value: { sent: true } }),
    provision: async () => {
      throw new Error("unused");
    },
    release: async () => ({ ok: true as const, value: undefined }),
    interrupt: async () => ({ ok: true as const, value: undefined }),
    resume_or_replace: async () => ({
      ok: false as const,
      error: { code: "runtime_unavailable" as const, message: "unused" },
    }),
    human_entry: async () => ({ ok: true as const, value: "" }),
    async *events() {
      yield* [] as never[];
    },
  };
  try {
    const plane = startControlPlane({
      store: f.store,
      runtime,
      intervalMs: 10_000,
      dataDir,
      attachmentIntervalMs: 5,
      snapshot: async () => ({ model: "m", agent_cli_version: "c" }),
      startRun: async () => {},
      onError: () => {},
    });
    expect(plane.attachments).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await plane.stop();
    await plane.done;
    expect(existsSync(orphan)).toBe(false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
