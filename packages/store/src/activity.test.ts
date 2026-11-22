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
      store.advanceMcpHandshake(project_id, id, "tools_listed", own, "token-old"),
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
