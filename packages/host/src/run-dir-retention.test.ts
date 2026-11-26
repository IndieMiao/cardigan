import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommandState,
  ExecutionConfig,
  HumanAction,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  assignment,
  card,
  fixture,
  id,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import {
  executeRunDirCommand,
  reclaimableRunDirectories,
  reclaimRunDirectories,
} from "./run-dir-retention.js";

const now = Date.parse("2026-11-25T12:00:00Z");
const DAY = 86_400_000;

function released(n: number, days: number, machine = "local") {
  return {
    ...assignment(n),
    work_item_id: id("work_item", n),
    machine_id: machine,
    status: "released" as const,
    released_at: new Date(now - days * DAY).toISOString(),
  };
}

test("C-743: only Assignments released more than K days, idle, unfenced and not kept by PM are reclaimable", () => {
  const base = fixture();
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
    ...base.work_items[0],
    id: id("work_item", n),
    card_id: id("card", n === 9 ? 2 : 1),
    assignment_id: id("assignment", n),
  }));
  const state = {
    ...base,
    cards: [
      card(1),
      {
        ...card(2),
        status: "done" as const,
        keep_run_dirs: {
          reason: "排查",
          set_by: "assignment:A-4",
          set_at: "2026-11-20T00:00:00.000Z",
        },
      },
    ],
    work_items: items,
    assignments: [
      released(1, 4),
      released(2, 3), // Exactly K days: not yet.
      { ...released(3, 10), status: "active" as const },
      released(4, 5),
      released(5, 5),
      released(6, 5),
      released(7, 5, "mac-mini"),
      {
        ...released(8, 5),
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "local/t1",
          agent_name: "fixture",
        },
      },
      released(9, 30),
      released(10, 30),
    ],
    runs: [
      { ...run(1, 1), status: "completed" as const },
      { ...run(4, 4), status: "running" as const },
    ],
    human_actions: [
      {
        id: id("human_action", 1),
        status: "open",
        blocked_work_items: [id("work_item", 5)],
      } as unknown as HumanAction,
      {
        id: id("human_action", 2),
        status: "open",
        blocked_work_items: [],
        host_assignment_id: id("assignment", 6),
      } as unknown as HumanAction,
    ],
    events: [],
  } as unknown as CommandState;
  const found = reclaimableRunDirectories(state, 3, now);
  expect(found.get("local")).toEqual(["A-1", "A-10"]);
  expect(found.get("mac-mini")).toEqual(["A-7"]);
  expect(reclaimableRunDirectories(state, 4, now).get("local")).toEqual([
    "A-10",
  ]);
});

async function tree() {
  // The remover never walks through a symlinked ancestor (macOS /var is one).
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "cg-run-dirs-")));
  const execution = {
    mode: "local",
    dataDir: tmp,
  } as unknown as ExecutionConfig;
  const parent = join(tmp, "runs", "cardigan");
  const outside = join(tmp, "outside.txt");
  await writeFile(outside, "not ours");
  for (const n of [1, 2]) {
    const dir = join(parent, `A-${n}`);
    await mkdir(join(dir, "sessions/abc/cache"), { recursive: true });
    await writeFile(join(dir, "sessions/abc/log.jsonl"), "x".repeat(9000));
    await writeFile(join(dir, "token"), "secret");
    await symlink(outside, join(dir, "link"));
    await symlink(tmp, join(dir, "sessions/up"));
    await chmod(join(dir, "sessions/abc/cache"), 0o500);
  }
  return {
    tmp,
    parent,
    outside,
    execution,
    close: async () => {
      execFileSync("chmod", ["-R", "u+rwx", tmp]);
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

test("C-743: the remover deletes only named run directories, without following links", async () => {
  const t = await tree();
  try {
    const preview = await reclaimRunDirectories(
      t.execution,
      "cardigan",
      ["A-1", "A-3"],
      { preview: true },
    );
    expect(preview.results).toEqual([
      { name: "A-1", state: "preview", freed_bytes: expect.any(Number) },
    ]);
    expect((await readdir(t.parent)).sort()).toEqual(["A-1", "A-2"]);
    const reply = await reclaimRunDirectories(t.execution, "cardigan", [
      "A-1",
      "A-3",
      "../A-2",
    ]);
    expect(reply.complete).toBe(true);
    expect(reply.results).toEqual([
      { name: "A-1", state: "removed", freed_bytes: expect.any(Number) },
    ]);
    expect(reply.results[0]?.freed_bytes).toBeGreaterThanOrEqual(8192);
    expect(await readdir(t.parent)).toEqual(["A-2"]);
    expect(await readFile(t.outside, "utf8")).toBe("not ours");
    expect(await readdir(join(t.parent, "A-2/sessions/abc"))).toContain(
      "log.jsonl",
    );
  } finally {
    await t.close();
  }
});

test("C-743: an out-of-time round reports incomplete and leaves the rest for the next round", async () => {
  const t = await tree();
  try {
    // Enough entries that a 1 ms budget always runs out inside the first directory.
    await Promise.all(
      Array.from({ length: 3000 }, (_, i) =>
        writeFile(join(t.parent, "A-1", `f${i}`), ""),
      ),
    );
    const reply = await reclaimRunDirectories(
      t.execution,
      "cardigan",
      ["A-1", "A-2"],
      {
        run: (file, args, input, timeout) =>
          executeRunDirCommand(
            file,
            args,
            // Already past the deadline once the first entry is reached.
            input.replace(/"budget_ms":\d+/u, '"budget_ms":1'),
            timeout,
          ),
        budgetMs: 1,
      },
    );
    expect(reply.complete).toBe(false);
    expect(reply.results).toEqual([
      { name: "A-1", state: "partial", freed_bytes: expect.any(Number) },
    ]);
    expect((await readdir(t.parent)).sort()).toEqual(["A-1", "A-2"]);
  } finally {
    await t.close();
  }
});

test("C-743: on the control host's Agent machine, the host removes what the Agent account could not, then the leaf", async () => {
  const t = await tree();
  try {
    const calls: string[] = [];
    const reply = await reclaimRunDirectories(
      {
        mode: "agent-ssh",
        dataDir: join(t.tmp, "data"),
        agentRoot: t.tmp,
      } as unknown as ExecutionConfig,
      "cardigan",
      ["A-1", "A-2"],
      {
        hostOwnsParent: true,
        agentCommand: async (_execution, argv) => ({
          file: "agent-ssh",
          args: [...argv],
        }),
        run: async (file, args, input, timeout) => {
          calls.push(file);
          // The Agent pass: it emptied what it owned, but the leaves are the host's.
          if (file === "agent-ssh")
            return JSON.stringify({
              results: [
                { name: "A-1", state: "emptied", freed_bytes: 10 },
                { name: "A-2", state: "partial", freed_bytes: 5 },
              ],
              complete: true,
            });
          expect(JSON.parse(input).names).toEqual(["A-1", "A-2"]);
          return executeRunDirCommand(file, args, input, timeout);
        },
      },
    );
    expect(calls).toEqual(["agent-ssh", "/usr/bin/python3"]);
    expect(reply.results.map((r) => [r.name, r.state])).toEqual([
      ["A-1", "removed"],
      ["A-2", "removed"],
    ]);
    expect(reply.results[0]?.freed_bytes).toBeGreaterThan(10);
    expect(await readdir(t.parent)).toEqual([]);
  } finally {
    await t.close();
  }
});

test("C-743: a reply naming a directory the host did not ask for is rejected", async () => {
  await expect(
    reclaimRunDirectories(
      { mode: "local", dataDir: "/nonexistent" } as unknown as ExecutionConfig,
      "cardigan",
      ["A-1"],
      {
        run: async () =>
          JSON.stringify({
            results: [{ name: "A-2", state: "removed", freed_bytes: 1 }],
            complete: true,
          }),
      },
    ),
  ).rejects.toThrow("Invalid run directory reply");
});
