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

test("C-600 the MCP handshake only advances a pending session, in a write visible to command state", () => {
  withTempStore((store, dataDir) => {
    const id = assignment().id;
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
        }),
      );
    pending();
    expect(store.advanceMcpHandshake(project_id, id, "tools_listed")).toBe(
      "listed",
    );
    // A later premature-looking call cannot undo a native listing.
    expect(store.advanceMcpHandshake(project_id, id, "tool_called")).toBe(
      "listed",
    );

    pending();
    expect(store.advanceMcpHandshake(project_id, id, "tool_called")).toBe(
      "missing",
    );
    // Listing afterwards (e.g. by a wrapper) does not revive the session.
    expect(store.advanceMcpHandshake(project_id, id, "tools_listed")).toBe(
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

    store.uow.run((tx) =>
      tx.assignments.put(project_id, {
        ...assignment(),
        status: "released",
        mcp_handshake: "pending",
      }),
    );
    expect(store.advanceMcpHandshake(project_id, id, "tool_called")).toBe(
      "pending",
    );
  });
});
