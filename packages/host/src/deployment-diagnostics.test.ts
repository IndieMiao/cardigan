import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  createHostOpsAssignment,
  HOST_OPS_ROLE_TOOLS,
  type Runtime,
} from "@cardigan/domain";
import {
  authenticate,
  hostOpsTools,
  loadCommandState,
  persistEffect,
  type ToolContext,
  unwrap,
} from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  writeDeploymentRecord,
  writeDeploymentStop,
  writeServerLogAudit,
} from "./deployment-audit.js";
import { HostOpsService } from "./host-ops.js";

test("host ops reads deployment evidence without mutation, cross-project access or execution privileges", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cg-deployment-diagnostics-"));
  const store = Store.open({ dataDir });
  const project = "cardigan";
  const clock = { now: () => "2026-11-13T00:00:00.000Z" };
  try {
    store.createProject({ id: project });
    const assignment = store.uow.run((tx) => {
      tx.roles.put(project, {
        role_id: "host_ops",
        role_version: 1,
        allowed_tools: HOST_OPS_ROLE_TOOLS,
        capabilities: [],
      });
      const effect = unwrap(
        createHostOpsAssignment(
          loadCommandState(tx, project),
          { kind: "human", project_id: project },
          {},
          { ids: tx.ids, clock },
        ),
      );
      persistEffect(tx, project, effect);
      return effect.data.assignment;
    });
    const token = store.issueToken({
      project_id: project,
      assignment_id: assignment.id,
      role: { role_version: 1, allowed_tools: HOST_OPS_ROLE_TOOLS },
    });
    const context: ToolContext = {
      store,
      identity: unwrap(authenticate(store, token.token)),
      revalidateToken: () => {
        if (!store.verifyToken(token.token)) throw new Error("revoked");
      },
    };
    const runtime = { release: vi.fn(), wake: vi.fn() };
    const service = new HostOpsService({
      store,
      runtime: runtime as unknown as Runtime,
      snapshot: async () => ({
        model: "fixture",
        agent_cli_version: "fixture",
      }),
      clock,
    });
    const tools = hostOpsTools({ hostOps: service.tools });
    expect(tools.map((t) => t.name)).not.toEqual(
      expect.arrayContaining(["deploy", "restart_server"]),
    );
    const read = tools.find((t) => t.name === "host_ops_read_diagnostics");
    if (!read) throw new Error("Missing diagnostics tool");
    store.uow.run((tx) =>
      tx.runs.put(project, {
        id: tx.ids.next(project, "run"),
        assignment_id: assignment.id,
        trigger_event_id: tx.ids.nextEventId(),
        kind: "followup",
        status: "running",
        role_version: 1,
        model: "fixture",
        agent_cli_version: "fixture",
        outcome: null,
        summary: "",
      }),
    );
    const record = writeDeploymentStop(store, project, {
      attempt: "fixture",
      from: "a".repeat(40),
      to: "b".repeat(40),
      status: "started",
      build: "passed",
      ready: false,
      downtime_ms: 0,
      summary: "starting",
    });
    writeDeploymentRecord(store, project, {
      ...record,
      status: "rolled_back",
      ready: true,
      summary: "ready_failed；已恢复上一构建",
      log_tail: "TypeScript TS6305\nbuild: exit 1",
    });
    await mkdir(join(dataDir, "self-deploy"), { mode: 0o700 });
    await mkdir(join(dataDir, "self-deploy/logs"), { mode: 0o700 });
    await writeFile(
      join(dataDir, "self-deploy/logs/server-private.log"),
      "raw-server-secret",
      { mode: 0o600 },
    );
    writeServerLogAudit(store, {
      status: "opened",
      file_name: "server-private.log",
    });
    await writeFile(
      join(dataDir, "self-deploy/state.json"),
      JSON.stringify({
        current: { sha: record.from, release: "/private/release" },
        environment: { TOKEN: "hidden-token" },
      }),
      { mode: 0o600 },
    );
    const before = store.uow.read((tx) => loadCommandState(tx, project));
    const view = await read.handler(read.input.parse({}), context);
    expect(view).toMatchObject({
      deployment: {
        deployed_sha: record.from,
        records: [
          expect.objectContaining({
            status: "rolled_back",
            stop_snapshot: {
              captured_at: expect.any(String),
              runs: [
                {
                  run_id: expect.any(String),
                  assignment_id: assignment.id,
                  card_id: null,
                },
              ],
            },
          }),
          expect.objectContaining({ status: "stopping" }),
        ],
      },
    });
    expect(JSON.stringify(view)).not.toMatch(
      /hidden-token|private\/release|environment|raw-server-secret|server-private\.log/,
    );
    expect(store.uow.read((tx) => loadCommandState(tx, project))).toEqual(
      before,
    );
    expect(runtime.release).not.toHaveBeenCalled();
    expect(runtime.wake).not.toHaveBeenCalled();
    await expect(
      read.handler(read.input.parse({ project_id: "other" }), context),
    ).rejects.toMatchObject({ code: "unauthorized" });
    // Revocation between async diagnostics IO and the final snapshot also rejects.
    const revoke = vi.fn(() => {
      if (revoke.mock.calls.length === 2) throw new Error("revoked");
    });
    await expect(
      read.handler(read.input.parse({}), {
        ...context,
        revalidateToken: revoke,
      }),
    ).rejects.toThrow("revoked");
    store.uow.run((tx) =>
      tx.assignments.put(project, {
        ...assignment,
        status: "released",
      } as Assignment),
    );
    await expect(read.handler(read.input.parse({}), context)).rejects.toThrow();
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
