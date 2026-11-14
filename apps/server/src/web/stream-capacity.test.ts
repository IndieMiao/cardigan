import { request as httpRequest } from "node:http";
import type { ProjectId } from "@cardigan/domain";
import { acquireMergeCheckCapacity } from "@cardigan/host";
import { expect, test } from "vitest";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import { executionCapacityRevision } from "./execution-capacity.js";

let harness: WebHarness;
let cookie: string;
/** Open the stream; hand out `capacity` revisions and count `change` frames. */
function openStream(): Promise<{
  next(): Promise<string>;
  changes(): number;
  close(): void;
}> {
  return new Promise((resolve, reject) => {
    const revisions: string[] = [];
    const waiting: ((revision: string) => void)[] = [];
    let changes = 0;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: harness.port,
        path: `/api/projects/${project_id}/stream`,
        agent: false,
        headers: { cookie, accept: "text/event-stream" },
      },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (frame.startsWith("event: change\n")) changes += 1;
            if (frame.startsWith("event: capacity\n")) {
              const data = JSON.parse(
                frame.slice(frame.indexOf("data: ") + 6),
              ) as { revision: string };
              const resolveNext = waiting.shift();
              if (resolveNext) resolveNext(data.revision);
              else revisions.push(data.revision);
            }
            index = buffer.indexOf("\n\n");
          }
        });
        resolve({
          next: () => {
            const ready = revisions.shift();
            return ready !== undefined
              ? Promise.resolve(ready)
              : new Promise((done) => waiting.push(done));
          },
          changes: () => changes,
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("shared capacity SSE covers other-project runs, human limit changes and CI leases without leaking bodies", async () => {
  const gate = {
    status: "enabled" as const,
    checks: [],
    env: {},
    totalTimeoutMs: 1000,
  };
  harness = await webHarness({
    password: "capacity-test-password",
    stream: { pollMs: 10 },
    mergeGate: { errors: [], forProject: () => gate },
  });
  seedWebProject(harness.store, harness.dataDir);
  cookie = await harness.login("capacity-test-password");
  const other = "private-project" as ProjectId;
  harness.store.createProject({ id: other });
  const stream = await openStream();
  try {
    const initial = await stream.next();
    expect(initial).toMatch(/^[0-9a-f]{16}$/u);
    harness.store.uow.run((tx) => {
      const owner = tx.assignments.get(project_id, "A-1");
      const run = tx.runs.get(project_id, "R-1");
      if (!owner || !run) throw new Error("Missing fixture");
      tx.assignments.put(other, {
        ...owner,
        scope: "standing",
        role_id: "pm",
        standing_mode: "ops",
      });
      tx.runs.put(other, {
        ...run,
        summary: "private task body",
        status: "running",
      });
    });
    const occupied = await stream.next();
    expect(occupied).not.toBe(initial);
    const read = await call(
      harness.port,
      `/api/projects/${project_id}/execution/capacity`,
      { cookie },
    );
    expect(read.json).toMatchObject({ agents: [{ limit: 4 }] });
    // The shared C-296 core supplies the standing/non-standing split.
    // The SSE bridge only carries its revision, never recalculates exemption.
    const row = (
      read.json as { agents: { running: number; total_running?: number }[] }
    ).agents[0];
    expect(row?.total_running ?? row?.running).toBe(2);
    expect(JSON.stringify(read.json)).not.toMatch(
      /private|worktree|token|summary/u,
    );
    const saved = await call(
      harness.port,
      `/api/projects/${project_id}/execution/capacity`,
      {
        cookie,
        method: "POST",
        body: JSON.stringify({ machine_id: "local", limit: 6 }),
        headers: {
          origin: `http://${harness.hostHeader}`,
          "idempotency-key": "capacity-sse",
          "content-type": "application/json",
        },
      },
    );
    expect(saved.status).toBe(200);
    const limit = await stream.next();
    expect(limit).not.toBe(occupied);
    const release = acquireMergeCheckCapacity(
      harness.store,
      other,
      "synthetic-check",
    );
    try {
      const checking = await stream.next();
      expect(checking).not.toBe(limit);
      expect(
        (
          await call(
            harness.port,
            `/api/projects/${project_id}/execution/capacity`,
            { cookie },
          )
        ).json,
      ).toMatchObject({
        agents: [{ merge_check_slots: 2 }],
        merge_checks: [{ running: 1 }],
      });
    } finally {
      release();
    }
    expect(await stream.next()).toBe(limit);
    expect(stream.changes()).toBe(0);
    const again = await openStream();
    try {
      expect(await again.next()).toBe(limit);
    } finally {
      again.close();
    }
    // Re-reading the display projection does not create audit/business events.
    expect(executionCapacityRevision(harness.store)).toBe(
      executionCapacityRevision(harness.store),
    );
  } finally {
    stream.close();
    await harness.close();
  }
});
