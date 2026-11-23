import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { Store as StoreFor } from "./store.js";
import { assignment, project_id, withTempStore } from "./test-support.js";

/** M3.2: the watchdog of M3 plan §3.3 reads the last authenticated MCP call. */

test("touchAssignmentActivity records the time on an active Assignment", () => {
  let now = "2026-01-01T00:00:00.000Z";
  withTempStore(
    (store) => {
      store.uow.run((tx) => tx.assignments.put(project_id, assignment()));
      expect(
        store.touchAssignmentActivity(project_id, assignment().id, now),
      ).toBe(true);
      expect(
        store.uow.read((tx) => tx.assignments.get(project_id, assignment().id))
          ?.last_mcp_activity_at,
      ).toBe(now);

      // A later call overwrites the previous timestamp.
      now = "2026-01-01T00:10:00.000Z";
      expect(
        store.touchAssignmentActivity(project_id, assignment().id, now),
      ).toBe(true);
      expect(
        store.uow.read((tx) => tx.assignments.get(project_id, assignment().id))
          ?.last_mcp_activity_at,
      ).toBe(now);
    },
    { clock: { now: () => now } },
  );
});

test("touchAssignmentActivity ignores unknown and released Assignments", () => {
  withTempStore((store) => {
    store.uow.run((tx) => tx.assignments.put(project_id, assignment()));
    expect(
      store.touchAssignmentActivity(
        project_id,
        "A-9" as never,
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(false);

    store.uow.run((tx) =>
      tx.assignments.put(
        project_id,
        assignment({ id: "A-2" as never, status: "released" }),
      ),
    );
    expect(
      store.touchAssignmentActivity(
        project_id,
        "A-2" as never,
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(false);
    expect(
      store.uow.read((tx) => tx.assignments.get(project_id, "A-2" as never))
        ?.last_mcp_activity_at,
    ).toBeUndefined();
  });
});

test("touchAssignmentActivity is visible to a second connection", () => {
  withTempStore((store, dataDir) => {
    store.uow.run((tx) => tx.assignments.put(project_id, assignment()));
    store.touchAssignmentActivity(
      project_id,
      assignment().id,
      "2026-01-01T00:05:00.000Z",
    );
    // A second connection (the MCP server process) sees the same fact.
    const reopened = StoreFor.open({ dataDir });
    try {
      expect(
        reopened.uow.read((tx) =>
          tx.assignments.get(project_id, assignment().id),
        )?.last_mcp_activity_at,
      ).toBe("2026-01-01T00:05:00.000Z");
    } finally {
      reopened.close();
    }
  });
});

test("C-600 only the launch's own key advances a pending session; anything else proves it has no native tools", () => {
  withTempStore((store, dataDir) => {
    const id = assignment().id;
    const own = "a".repeat(64),
      other = "b".repeat(64);
    store.uow.run((tx) => tx.assignments.put(project_id, assignment()));
    // Legacy and unverified sessions have no handshake to advance.
    expect(
      store.advanceMcpHandshake(project_id, id, "tool_called"),
    ).toBeUndefined();
    expect(
      store.uow.read((tx) => tx.assignments.get(project_id, id))?.mcp_handshake,
    ).toBeUndefined();

    const pending = () =>
      store.uow.run((tx) =>
        tx.assignments.put(project_id, {
          ...assignment(),
          mcp_handshake: "pending",
          mcp_session_key_sha256: own,
          mcp_session_token_id: "token-new",
        }),
      );
    pending();
    // A late call on the replaced launch's Token says nothing about this one.
    expect(
      store.advanceMcpHandshake(
        project_id,
        id,
        "tool_called",
        undefined,
        "token-old",
      ),
    ).toBeUndefined();
    expect(
      store.advanceMcpHandshake(
        project_id,
        id,
        "tools_listed",
        own,
        "token-old",
      ),
    ).toBeUndefined();
    expect(
      store.uow.read((tx) => tx.assignments.get(project_id, id))?.mcp_handshake,
    ).toBe("pending");
    // Another client of the same Token listing tools proves nothing.
    expect(store.advanceMcpHandshake(project_id, id, "tools_listed")).toBe(
      "pending",
    );
    expect(
      store.advanceMcpHandshake(project_id, id, "tools_listed", other),
    ).toBe("pending");
    // A late call from another launch's harness (its own key) proves nothing.
    expect(
      store.advanceMcpHandshake(project_id, id, "tool_called", other),
    ).toBe("pending");
    // A deadline for another session does not touch this one.
    expect(store.advanceMcpHandshake(project_id, id, "deadline", other)).toBe(
      "pending",
    );
    expect(store.advanceMcpHandshake(project_id, id, "tools_listed", own)).toBe(
      "listed",
    );
    // Later calls without the key cannot undo a native listing.
    expect(store.advanceMcpHandshake(project_id, id, "tool_called")).toBe(
      "listed",
    );

    // A native call before listing (same key) is still native.
    pending();
    expect(store.advanceMcpHandshake(project_id, id, "tool_called", own)).toBe(
      "listed",
    );

    pending();
    expect(store.advanceMcpHandshake(project_id, id, "tool_called")).toBe(
      "missing",
    );
    // Listing afterwards does not revive the session.
    expect(store.advanceMcpHandshake(project_id, id, "tools_listed", own)).toBe(
      "missing",
    );
    const reopened = StoreFor.open({ dataDir });
    try {
      expect(
        reopened.uow.read((tx) => tx.assignments.get(project_id, id))
          ?.mcp_handshake,
      ).toBe("missing");
    } finally {
      reopened.close();
    }

    // The host's deadline for this very session.
    pending();
    expect(store.advanceMcpHandshake(project_id, id, "deadline", own)).toBe(
      "missing",
    );

    store.uow.run((tx) =>
      tx.assignments.put(project_id, {
        ...assignment(),
        status: "released",
        mcp_handshake: "pending",
        mcp_session_key_sha256: own,
      }),
    );
    expect(store.advanceMcpHandshake(project_id, id, "tool_called")).toBe(
      "pending",
    );
  });
});

test("C-600 V-2999:1 another launch's Token is not the verified session's activity", () => {
  withTempStore((store) => {
    const id = assignment().id;
    const activity = () =>
      store.uow.read((tx) => tx.assignments.get(project_id, id))
        ?.last_mcp_activity_at;
    store.uow.run((tx) =>
      tx.assignments.put(project_id, {
        ...assignment(),
        mcp_handshake: "listed",
        mcp_session_key_sha256: "a".repeat(64),
        mcp_session_token_id: "token-new",
      }),
    );
    expect(
      store.touchAssignmentActivity(
        project_id,
        id,
        "2026-01-01T00:01:00.000Z",
        "token-old",
      ),
    ).toBe(false);
    expect(activity()).toBeUndefined();
    expect(
      store.touchAssignmentActivity(
        project_id,
        id,
        "2026-01-01T00:02:00.000Z",
        "token-new",
      ),
    ).toBe(true);
    expect(activity()).toBe("2026-01-01T00:02:00.000Z");
    // Sessions without a recorded launch Token keep the old behaviour.
    store.uow.run((tx) => tx.assignments.put(project_id, assignment()));
    expect(
      store.touchAssignmentActivity(
        project_id,
        id,
        "2026-01-01T00:03:00.000Z",
        "token-any",
      ),
    ).toBe(true);
  });
});

/** C-635: hold the write lock from another process's connection. */
function holdWriteLock(dataDir: string) {
  const other = new DatabaseSync(join(dataDir, "cardigan.db"));
  other.exec("BEGIN IMMEDIATE");
  return () => {
    other.exec("ROLLBACK");
    other.close();
  };
}

test("C-635 withoutLockWait answers busy at once instead of waiting for another process", () => {
  withTempStore((store, dataDir) => {
    store.uow.run((tx) => tx.assignments.put(project_id, assignment()));
    const release = holdWriteLock(dataDir);
    try {
      const started = performance.now();
      expect(
        store.withoutLockWait(() =>
          store.touchAssignmentActivity(
            project_id,
            assignment().id,
            "2026-01-01T00:00:00.000Z",
          ),
        ),
      ).toEqual({ busy: true });
      // The store's busy timeout is 5 s; nothing waited for it.
      expect(performance.now() - started).toBeLessThan(200);
      // Reads are not affected by another process's write lock (WAL).
      expect(
        store.withoutLockWait(
          () =>
            store.uow.read((tx) =>
              tx.assignments.get(project_id, assignment().id),
            )?.status,
        ),
      ).toEqual({ busy: false, value: "active" });
    } finally {
      release();
    }
    // The busy timeout is restored and the write goes through.
    expect(
      store.withoutLockWait(() =>
        store.touchAssignmentActivity(
          project_id,
          assignment().id,
          "2026-01-01T00:00:00.000Z",
        ),
      ),
    ).toEqual({ busy: false, value: true });
    expect(
      store.uow.read((tx) => tx.assignments.get(project_id, assignment().id))
        ?.last_mcp_activity_at,
    ).toBe("2026-01-01T00:00:00.000Z");
  });
});

test("C-635 deferred activity rides along with the next write, never backwards, only for the session's own Token", () => {
  withTempStore((store) => {
    let writes = 0;
    store.observe({ transaction: (kind) => kind === "run" && writes++ });
    store.uow.run((tx) => {
      tx.assignments.put(project_id, assignment());
      tx.assignments.put(
        project_id,
        assignment({
          id: "A-2" as never,
          mcp_session_token_id: "token-new",
          last_mcp_activity_at: "2026-01-01T00:05:00.000Z",
        }),
      );
      tx.assignments.put(
        project_id,
        assignment({ id: "A-3" as never, status: "released" }),
      );
    });
    const activity = (id: string) =>
      store.uow.read((tx) => tx.assignments.get(project_id, id as never))
        ?.last_mcp_activity_at;
    writes = 0;
    // Nothing deferred: no transaction at all.
    expect(store.flushDeferredActivity()).toBe(0);
    expect(writes).toBe(0);
    store.deferAssignmentActivity({
      project_id,
      assignment_id: assignment().id,
      at: "2026-01-01T00:01:00.000Z",
    });
    // A later call of the same session replaces an earlier one, not the reverse.
    store.deferAssignmentActivity({
      project_id,
      assignment_id: assignment().id,
      at: "2026-01-01T00:02:00.000Z",
    });
    store.deferAssignmentActivity({
      project_id,
      assignment_id: assignment().id,
      at: "2026-01-01T00:01:30.000Z",
    });
    // The replaced launch's Token is not this session's activity.
    store.deferAssignmentActivity({
      project_id,
      assignment_id: "A-2" as never,
      at: "2026-01-01T00:06:00.000Z",
      token_id: "token-old",
    });
    for (const id of ["A-3", "A-9"])
      store.deferAssignmentActivity({
        project_id,
        assignment_id: id as never,
        at: "2026-01-01T00:06:00.000Z",
      });
    expect(store.deferredAssignmentActivity()).toHaveLength(4);
    expect(activity(assignment().id)).toBeUndefined();
    // Any write of this Store carries them, in its own transaction.
    store.uow.run((tx) =>
      tx.cards.put(project_id, {
        id: "C-9",
        project_id,
        title: "Unrelated",
      } as never),
    );
    expect(writes).toBe(1);
    expect(store.deferredAssignmentActivity()).toEqual([]);
    expect(activity(assignment().id)).toBe("2026-01-01T00:02:00.000Z");
    expect(activity("A-2")).toBe("2026-01-01T00:05:00.000Z");
    expect(activity("A-3")).toBeUndefined();
    // An older, delayed time never replaces a newer one.
    store.deferAssignmentActivity({
      project_id,
      assignment_id: "A-2" as never,
      at: "2026-01-01T00:04:00.000Z",
      token_id: "token-new",
    });
    expect(store.flushDeferredActivity()).toBe(1);
    expect(activity("A-2")).toBe("2026-01-01T00:05:00.000Z");
    store.deferAssignmentActivity({
      project_id,
      assignment_id: "A-2" as never,
      at: "2026-01-01T00:07:00.000Z",
      token_id: "token-new",
    });
    expect(store.flushDeferredActivity()).toBe(1);
    expect(activity("A-2")).toBe("2026-01-01T00:07:00.000Z");
    expect(writes).toBe(3);
  });
});

test("C-635 deferred activity survives a rolled-back or busy write", () => {
  withTempStore((store, dataDir) => {
    store.uow.run((tx) => tx.assignments.put(project_id, assignment()));
    const activity = () =>
      store.uow.read((tx) => tx.assignments.get(project_id, assignment().id))
        ?.last_mcp_activity_at;
    store.deferAssignmentActivity({
      project_id,
      assignment_id: assignment().id,
      at: "2026-01-01T00:01:00.000Z",
    });
    expect(() =>
      store.uow.run(() => {
        throw new Error("fictional command failure");
      }),
    ).toThrow("fictional command failure");
    expect(store.deferredAssignmentActivity()).toHaveLength(1);
    const release = holdWriteLock(dataDir);
    try {
      expect(
        store.withoutLockWait(() => store.flushDeferredActivity()),
      ).toEqual({ busy: true });
    } finally {
      release();
    }
    expect(activity()).toBeUndefined();
    expect(store.flushDeferredActivity()).toBe(1);
    expect(activity()).toBe("2026-01-01T00:01:00.000Z");
  });
});

test("C-635 tryAdvanceMcpHandshake decides while busy and writes later, with advanceMcpHandshake's rules", () => {
  withTempStore((store, dataDir) => {
    const id = assignment().id;
    const own = "a".repeat(64);
    store.uow.run((tx) =>
      tx.assignments.put(project_id, {
        ...assignment(),
        mcp_handshake: "pending",
        mcp_session_key_sha256: own,
        mcp_session_token_id: "token-new",
      }),
    );
    const stored = () =>
      store.uow.read((tx) => tx.assignments.get(project_id, id))?.mcp_handshake;
    const release = holdWriteLock(dataDir);
    try {
      const started = performance.now();
      expect(
        store.tryAdvanceMcpHandshake(
          project_id,
          id,
          "tool_called",
          own,
          "token-new",
        ),
      ).toEqual({ state: "listed", persisted: false });
      expect(performance.now() - started).toBeLessThan(200);
      expect(stored()).toBe("pending");
      // Nothing to write: answered from the read, even while busy.
      expect(
        store.tryAdvanceMcpHandshake(
          project_id,
          id,
          "tool_called",
          undefined,
          "token-old",
        ),
      ).toEqual({ state: undefined, persisted: true });
    } finally {
      release();
    }
    expect(
      store.tryAdvanceMcpHandshake(
        project_id,
        id,
        "tool_called",
        own,
        "token-new",
      ),
    ).toEqual({ state: "listed", persisted: true });
    expect(stored()).toBe("listed");
    // Once decided, a wrapper's call no longer changes it.
    expect(
      store.tryAdvanceMcpHandshake(
        project_id,
        id,
        "tool_called",
        undefined,
        "token-new",
      ),
    ).toEqual({ state: "listed", persisted: true });
  });
});

test("C-635 dispatchedRunIds finds only the Assignment's dispatched Runs", () => {
  withTempStore((store) => {
    const run = (id: string, assignment_id: string, status: string) =>
      ({
        id,
        project_id,
        assignment_id,
        trigger_event_id: `E-${id}`,
        status,
      }) as never;
    store.uow.run((tx) => {
      tx.assignments.put(project_id, assignment());
      tx.assignments.put(project_id, assignment({ id: "A-2" as never }));
      tx.runs.put(project_id, run("R-1", assignment().id, "completed"));
      tx.runs.put(project_id, run("R-2", "A-2", "dispatched"));
      tx.runs.put(project_id, run("R-3", assignment().id, "dispatched"));
      tx.runs.put(project_id, run("R-4", assignment().id, "running"));
    });
    expect(store.dispatchedRunIds(project_id, assignment().id)).toEqual([
      "R-3",
    ]);
    expect(store.dispatchedRunIds(project_id, "A-2" as never)).toEqual(["R-2"]);
    expect(store.dispatchedRunIds(project_id, "A-9" as never)).toEqual([]);
  });
});
