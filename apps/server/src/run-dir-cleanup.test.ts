import type {
  Assignment,
  AssignmentId,
  ExecutionConfig,
  ProjectId,
} from "@cardigan/domain";
import type { RunDirReply, reclaimRunDirectories } from "@cardigan/host";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type M4Fixture, m4Fixture, m4Scenario } from "./m4-fixtures.js";
import {
  RUN_DIR_RECLAIMED,
  RunDirRetention,
  runDirSettings,
} from "./run-dir-cleanup.js";

const now = Date.parse("2030-01-10T00:00:00.000Z");
let f: M4Fixture;
type Call = {
  machine: string;
  names: readonly string[];
  hostOwnsParent: boolean | undefined;
  preview: boolean | undefined;
};
let calls: Call[];
let replies: Map<string, RunDirReply | Error>;

beforeEach(() => {
  f = m4Fixture({ memoryDatabase: true });
  calls = [];
  replies = new Map();
  const local = f.store.uow.read((tx) =>
    tx.machines.get(f.project_id, "local"),
  );
  if (!local) throw new Error("fixture machine");
  f.store.uow.run((tx) => {
    tx.machines.put(f.project_id, {
      ...local,
      id: "mac-mini",
      label: "mac",
      herdr_machine: "mac-mini",
    });
    tx.machines.put(f.project_id, {
      ...local,
      id: "gone",
      label: "gone",
      herdr_machine: "gone",
      status: "offline",
    });
  });
  for (const [n, machine, days] of [
    [901, "local", 5],
    [902, "local", 1],
    [903, "mac-mini", 4],
    [904, "gone", 9],
  ] as const) {
    const a = {
      id: `A-${n}` as AssignmentId,
      scope: "standing",
      role_id: "pm",
      role_version: 1,
      status: "released",
      runtime_state: "idle",
      machine_id: machine,
      runtime_ref: null,
      session_ref: "fixture",
      mcp_token_id: `token-${n}`,
      created_at: "2030-01-01T00:00:00.000Z",
      released_at: new Date(now - days * 86_400_000).toISOString(),
    } as unknown as Assignment;
    f.store.uow.run((tx) => tx.assignments.put(f.project_id, a));
  }
});
afterEach(() => f.close());

const reclaim = (async (execution, _project, names, options) => {
  const machine = (execution as unknown as { machine: string }).machine;
  calls.push({
    machine,
    names: [...names],
    hostOwnsParent: options?.hostOwnsParent,
    preview: options?.preview,
  });
  const reply = replies.get(machine);
  if (reply instanceof Error) throw reply;
  return (
    reply ?? {
      results: names.map((name) => ({
        name,
        state: options?.preview ? "preview" : "removed",
        freed_bytes: 1024 ** 3,
      })),
      complete: true,
    }
  );
}) as typeof reclaimRunDirectories;

function retention(mode: "auto" | "preview" | "off" = "auto") {
  return new RunDirRetention(
    f.store,
    {
      resolve: (_project: ProjectId, machine: string) =>
        ({
          execution: {
            mode: "agent-ssh",
            machine,
          } as unknown as ExecutionConfig,
        }) as unknown as ReturnType<
          import("@cardigan/host").RuntimeTargets["resolve"]
        >,
    },
    { days: 3, mode },
    { reclaim, now: () => now },
  );
}
const events = () =>
  f.store.uow.read((tx) =>
    tx.events
      .listAfter(f.project_id, undefined, 0)
      .filter((e) => e.type === RUN_DIR_RECLAIMED)
      .map((e) => e.payload as Record<string, unknown>),
  );

test("C-743: every online machine reclaims its own released, over-age run directories and reports to the project stream", async () => {
  await retention().sweep();
  expect(calls).toEqual([
    {
      machine: "local",
      names: ["A-901"],
      hostOwnsParent: true,
      preview: false,
    },
    {
      machine: "mac-mini",
      names: ["A-903"],
      hostOwnsParent: false,
      preview: false,
    },
  ]);
  expect(events()).toEqual([
    expect.objectContaining({
      machine_id: "local",
      mode: "auto",
      status: "completed",
      released_days: 3,
      removed: 1,
      freed_bytes: 1024 ** 3,
      names: ["A-901"],
      retained_count: 0,
      notice: expect.stringContaining("腾出 1.0 GB"),
    }),
    expect.objectContaining({ machine_id: "mac-mini", removed: 1 }),
  ]);
});

test("C-743: a card PM named for keeping is skipped", async () => {
  const { card, development } = m4Scenario(f);
  f.store.uow.run((tx) => {
    tx.cards.put(f.project_id, {
      ...card,
      status: "done",
      keep_run_dirs: {
        reason: "排查",
        set_by: "human",
        set_at: "2030-01-01T00:00:00.000Z",
      },
    });
    const a = tx.assignments.get(f.project_id, "A-901" as AssignmentId);
    tx.assignments.put(f.project_id, {
      ...a,
      scope: "work_item",
      work_item_id: development.id,
    } as Assignment);
  });
  await retention().sweep();
  expect(calls.map((c) => c.names)).toEqual([["A-903"]]);
});

test("C-743: preview removes nothing and says so; off does nothing", async () => {
  await retention("off").sweep();
  expect(calls).toEqual([]);
  await retention("preview").sweep();
  expect(calls.every((c) => c.preview)).toBe(true);
  expect(events()[0]).toMatchObject({
    mode: "preview",
    removed: 1,
    notice: expect.stringContaining("预览"),
  });
});

test("C-743: a failing or stuck machine is reported once, not every round", async () => {
  replies.set("local", new Error("ssh"));
  replies.set("mac-mini", {
    results: [{ name: "A-903", state: "partial", freed_bytes: 0 }],
    complete: true,
  });
  const r = retention();
  await r.sweep();
  await r.sweep();
  expect(events()).toEqual([
    expect.objectContaining({ machine_id: "local", status: "failed" }),
    expect.objectContaining({
      machine_id: "mac-mini",
      removed: 0,
      retained: ["A-903"],
    }),
  ]);
});

test("C-743: settings default to 3 days, automatic, and reject bad values", () => {
  expect(runDirSettings({})).toEqual({ days: 3, mode: "auto" });
  expect(
    runDirSettings({
      CARDIGAN_RUN_DIR_RETENTION_DAYS: "7",
      CARDIGAN_RUN_DIR_RETENTION: "preview",
    }),
  ).toEqual({ days: 7, mode: "preview" });
  for (const env of [
    { CARDIGAN_RUN_DIR_RETENTION_DAYS: "0" },
    { CARDIGAN_RUN_DIR_RETENTION_DAYS: "1.5" },
    { CARDIGAN_RUN_DIR_RETENTION: "delete" },
  ])
    expect(() => runDirSettings(env)).toThrow();
});
