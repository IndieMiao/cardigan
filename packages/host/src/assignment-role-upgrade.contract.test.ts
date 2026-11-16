import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { defaultRoleDefinition } from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { fixture, human } from "../../domain/src/commands/test-fixtures.js";
import { upgradeIdleAssignmentRoles } from "./assignment-role-upgrade.js";
import { issueAssignmentToken, launchEntities } from "./commands.js";

test.each([false, true])(
  "maintenance retires an idle pinned owner after confirmed exit; manual conflict=%s",
  async (manual) => {
    const dir = await mkdtemp("/tmp/cg-role-upgrade-");
    const store = Store.open({ dbPath: join(dir, "test.db") });
    let time = Date.parse("2030-01-01T00:00:00Z");
    const clock = { now: () => new Date(time).toISOString() };
    try {
      const state = fixture(),
        owner = {
          ...state.assignments[0]!,
          worktree_path: dir,
          branch: "agent/keep",
          session_ref: "old-session",
          employee_id: "E-1" as never,
          runtime_ref: {
            runtime_machine: "local",
            terminal_ref: "t-old",
            agent_name: "fixture",
            worktree_path: dir,
          },
        };
      store.createProject({ id: human.project_id });
      await writeFile(join(dir, "dirty.txt"), "uncommitted work");
      const source = defaultRoleDefinition("coder", {
        harness: "codex",
        launch_profile_ref: "fixture",
      });
      const token = store.uow.run((tx) => {
        tx.cards.put(human.project_id, state.cards[0]!);
        tx.work_items.put(human.project_id, state.work_items[0]!);
        tx.assignments.put(human.project_id, owner);
        tx.runs.put(human.project_id, state.runs[0]!);
        writeRole(
          tx,
          human.project_id,
          {
            ...source,
            version: 1,
            allowed_tools: source.allowed_tools.filter(
              (t) => t !== "request_check",
            ),
          },
          { mode: "add" },
        );
        writeRole(
          tx,
          human.project_id,
          {
            ...source,
            version: 2,
            ...(manual ? { instructions: "Local manual rule" } : {}),
          },
          { mode: "update" },
        );
        return tx.issueToken({
          project_id: human.project_id,
          assignment_id: owner.id,
          role: { role_version: 1, allowed_tools: ["get_card"] },
        });
      });
      let exited = false;
      let finishRelease!: () => void;
      const release = vi.fn(async () => {
        await new Promise<void>((r) => {
          finishRelease = r;
        });
        return { ok: true as const, value: undefined };
      });
      const runtime = {
        release,
        status: vi.fn(async () => ({
          ok: true as const,
          value: {
            process: exited ? "exited" : "alive",
            agent: "idle",
            observed_seq: 1,
          },
        })),
      } as unknown as Runtime;
      // Running work stays pinned and its token stays valid.
      await upgradeIdleAssignmentRoles(store, human.project_id, runtime, clock);
      expect(release).not.toHaveBeenCalled();
      expect(store.verifyToken(token.token)).toBeTruthy();
      store.uow.run((tx) =>
        tx.runs.put(human.project_id, {
          ...state.runs[0]!,
          status: "completed",
          outcome: "completed",
        }),
      );
      if (manual) {
        await upgradeIdleAssignmentRoles(
          store,
          human.project_id,
          runtime,
          clock,
        );
        expect(release).not.toHaveBeenCalled();
        expect(store.verifyToken(token.token)).toBeTruthy();
        await upgradeIdleAssignmentRoles(
          store,
          human.project_id,
          runtime,
          clock,
        );
        expect(
          store.uow.read((tx) => tx.human_actions.list(human.project_id)),
        ).toHaveLength(1);
        return;
      }
      const first = upgradeIdleAssignmentRoles(
        store,
        human.project_id,
        runtime,
        clock,
      );
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      expect(store.verifyToken(token.token)).toBeUndefined();
      expect(() =>
        issueAssignmentToken(
          store,
          human.project_id,
          launchEntities(store, human.project_id, owner.id),
        ),
      ).toThrow("upgrade is pending");
      await upgradeIdleAssignmentRoles(store, human.project_id, runtime, clock);
      expect(release).toHaveBeenCalledOnce(); // Non-expiring host lock fences late IO.
      expect(release).toHaveBeenCalledWith(owner.runtime_ref, { force: false });
      finishRelease();
      await first;
      expect(
        store.uow.read(
          (tx) => tx.assignments.get(human.project_id, owner.id)?.role_upgrade,
        ),
      ).toBeDefined();
      // A restart resumes the durable fence; an ACK without observed exit cannot upgrade.
      time += 60_000;
      exited = true;
      release.mockImplementation(async () => ({ ok: true, value: undefined }));
      await upgradeIdleAssignmentRoles(store, human.project_id, runtime, clock);
      await upgradeIdleAssignmentRoles(store, human.project_id, runtime, clock);
      const after = store.uow.read((tx) =>
        loadCommandState(tx, human.project_id),
      );
      expect(after.assignments).toMatchObject([
        {
          id: owner.id,
          employee_id: owner.employee_id,
          branch: owner.branch,
          worktree_path: dir,
          role_version: 2,
          runtime_ref: null,
        },
      ]);
      expect(after.assignments[0]?.session_ref).toBeUndefined();
      const refreshed = issueAssignmentToken(
        store,
        human.project_id,
        launchEntities(store, human.project_id, owner.id),
      );
      expect(refreshed.record.role_version).toBe(2);
      expect(refreshed.record.allowed_tools).toContain("request_check");
      expect(refreshed.record.allowed_tools).toContain("get_check_log");
      const repeated = issueAssignmentToken(
        store,
        human.project_id,
        launchEntities(store, human.project_id, owner.id),
      );
      expect(repeated.record.allowed_tools).toEqual(
        refreshed.record.allowed_tools,
      );
      expect(
        after.events.filter((e) => e.type === "session_replaced"),
      ).toHaveLength(1);
      expect(await readFile(join(dir, "dirty.txt"), "utf8")).toBe(
        "uncommitted work",
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("unaudited version changes and same-version token replacement retain the existing tool ceiling", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    const state = fixture(),
      owner = { ...state.assignments[0]!, role_version: 2 };
    const source = defaultRoleDefinition("coder", {
      harness: "codex",
      launch_profile_ref: "fixture",
    });
    store.createProject({ id: human.project_id });
    store.uow.run((tx) => {
      tx.assignments.put(human.project_id, owner);
      tx.issueToken({
        project_id: human.project_id,
        assignment_id: owner.id,
        role: { role_version: 1, allowed_tools: ["get_card"] },
      });
    });
    const entities = { assignment: owner, role: { ...source, version: 2 } };
    const first = issueAssignmentToken(store, human.project_id, entities);
    expect(first.record.allowed_tools).toEqual(["get_card"]);
    const next = issueAssignmentToken(store, human.project_id, entities);
    expect(next.record.allowed_tools).toEqual(["get_card"]);
  } finally {
    store.close();
  }
});

function batchFixture() {
  const store = Store.open({ dbPath: ":memory:" });
  const state = fixture(),
    source = defaultRoleDefinition("coder", {
      harness: "codex",
      launch_profile_ref: "fixture",
    });
  store.createProject({ id: human.project_id });
  store.uow.run((tx) => {
    writeRole(
      tx,
      human.project_id,
      { ...source, version: 1, allowed_tools: ["get_card"] },
      { mode: "add" },
    );
    writeRole(
      tx,
      human.project_id,
      { ...source, version: 2 },
      { mode: "update" },
    );
    for (let i = 1; i <= 5; i++) {
      const card = { ...state.cards[0]!, id: `C-${i}` as never };
      const item = {
        ...state.work_items[0]!,
        id: `W-${i}` as never,
        card_id: card.id,
        assignment_id: `A-${i}` as never,
      };
      tx.cards.put(human.project_id, card);
      tx.work_items.put(human.project_id, item);
      tx.assignments.put(human.project_id, {
        ...state.assignments[0]!,
        id: item.assignment_id,
        scope: "work_item",
        work_item_id: item.id,
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: `t${i}`,
          agent_name: `fixture-${i}`,
        },
      });
    }
  });
  const gone = new Set<string>();
  const release = vi.fn(async (ref: { terminal_ref: string }) => {
    gone.add(ref.terminal_ref);
    return { ok: true as const, value: undefined };
  });
  const runtime = {
    release,
    status: vi.fn(async (ref: { terminal_ref: string }) =>
      gone.has(ref.terminal_ref)
        ? {
            ok: false as const,
            error: { code: "runtime_not_found" as const, message: "gone" },
          }
        : {
            ok: true as const,
            value: {
              process: "alive" as const,
              agent: "idle" as const,
              observed_seq: 1,
            },
          },
    ),
  } as unknown as Runtime;
  return {
    store,
    runtime,
    release,
    gone,
    clock: { now: () => "2030-01-01T00:00:00Z" },
  };
}

test("a maintenance pass replaces at most two sessions and leaves later owners for subsequent passes", async () => {
  const f = batchFixture();
  try {
    for (const expected of [2, 4, 5]) {
      await upgradeIdleAssignmentRoles(
        f.store,
        human.project_id,
        f.runtime,
        f.clock,
      );
      expect(
        f.store.uow.read((tx) =>
          tx.assignments
            .list(human.project_id)
            .filter((a) => a.role_version === 2),
        ),
      ).toHaveLength(expected);
      expect(f.release).toHaveBeenCalledTimes(expected);
    }
  } finally {
    f.store.close();
  }
});

test("concurrent maintenance controllers share the two-session reservation limit", async () => {
  const f = batchFixture(),
    finish: (() => void)[] = [];
  f.release.mockImplementation(async (ref) => {
    await new Promise<void>((resolve) => finish.push(resolve));
    f.gone.add(ref.terminal_ref);
    return { ok: true, value: undefined };
  });
  const first = upgradeIdleAssignmentRoles(
    f.store,
    human.project_id,
    f.runtime,
    f.clock,
  );
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
  const second = upgradeIdleAssignmentRoles(
    f.store,
    human.project_id,
    f.runtime,
    f.clock,
  );
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(2));
  try {
    await upgradeIdleAssignmentRoles(
      f.store,
      human.project_id,
      f.runtime,
      f.clock,
    );
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.runtime.status).toHaveBeenCalledTimes(2);
    expect(
      f.store.uow.read((tx) =>
        tx.assignments.list(human.project_id).filter((a) => a.role_upgrade),
      ),
    ).toHaveLength(2);
    f.store.uow.run((tx) => {
      for (const a of tx.assignments.list(human.project_id))
        if (!a.role_upgrade)
          tx.assignments.put(human.project_id, { ...a, status: "released" });
    });
  } finally {
    for (const done of finish) done();
    await Promise.all([first, second]);
    f.store.close();
  }
});
