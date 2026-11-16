import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticate,
  fileAttachmentStore,
  type ToolContext,
} from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  assignments,
  project_id,
  seedProject,
} from "../../mcp-server/src/test-support.js";
import type { ProbeProfiles } from "./probe-config.js";
import {
  type ProbeAdapter,
  type ProbeJob,
  ProbeService,
} from "./probe-service.js";

const roots: string[] = [],
  stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "probe-service-"));
  roots.push(dataDir);
  const store = Store.open({ dataDir });
  stores.push(store);
  store.createProject({ id: project_id });
  seedProject(store, { allowed_tools: ["run_probe"] });
  const token = store.issueToken({
    project_id,
    assignment_id: assignments.id,
    role: { role_version: 1, allowed_tools: ["run_probe"] },
  });
  const auth = authenticate(store, token.token);
  if (!auth.ok) throw new Error("fixture auth");
  const context: ToolContext = {
    store,
    identity: auth.value,
    revalidateToken: () => {
      if (!store.verifyToken(token.token)) throw new Error("Revoked");
    },
  };
  let profiles: ProbeProfiles = {
    [project_id]: {
      config: {
        operations: ["smoke", "status", "cancel", "cleanup"],
        timeout_ms: 30000,
        rest_budget_per_hour: 120,
      },
    },
  };
  const head = vi.fn(async () => "a".repeat(40));
  const adapter: ProbeAdapter = {
    advance: vi.fn(async (job) => ({
      ...job,
      tested_sha: job.head_sha,
      status: "passed",
      cleanup: "complete",
    })),
  };
  const options = {
    store,
    dataDir,
    profiles: () => profiles,
    head,
    adapters: { config: adapter },
  };
  const service = new ProbeService(options);
  return {
    store,
    dataDir,
    context,
    token,
    head,
    adapter,
    service,
    options,
    disable: () => {
      profiles = {};
    },
  };
}
const smoke = {
  probe: "config" as const,
  operation: "smoke" as const,
  idempotency_key: "one",
};
const start = async (f: ReturnType<typeof setup>) =>
  (await f.service.execute(f.context, smoke)) as { probe_run_id: string };

test("idempotent enqueue reads one HEAD, serializes capacity, and restart produces a real bound attachment once", async () => {
  const f = setup();
  const job = await start(f);
  expect(await start(f)).toEqual(job);
  expect(f.head).toHaveBeenCalledOnce();
  await expect(
    f.service.execute(f.context, { ...smoke, idempotency_key: "two" }),
  ).rejects.toThrow("已有探针");
  expect(
    await f.service.execute(f.context, {
      probe: "config",
      operation: "status",
      parameters: { probe_run_id: job.probe_run_id },
      idempotency_key: "status",
    }),
  ).toMatchObject({ status: "queued" });
  const restarted = new ProbeService(f.options);
  await restarted.tick();
  await restarted.tick();
  const view = await restarted.execute(f.context, {
    probe: "config",
    operation: "status",
    parameters: { probe_run_id: job.probe_run_id },
    idempotency_key: "status",
  });
  expect(view).toMatchObject({
    status: "passed",
    cleanup: "complete",
    head_sha: "a".repeat(40),
    attachment_id: expect.any(String),
  });
  const attachments = f.store.uow.read((tx) => tx.attachments.list(project_id));
  expect(attachments).toHaveLength(1);
  const attachment = attachments[0];
  if (!attachment) throw new Error("Missing evidence");
  const content = await fileAttachmentStore(f.dataDir).get(attachment.sha256);
  if (!content) throw new Error("Missing evidence content");
  expect(JSON.parse(Buffer.from(content).toString())).toMatchObject({
    source: "live",
    head_sha: "a".repeat(40),
  });
  expect(f.adapter.advance).toHaveBeenCalledOnce();
});

test("cancellation is owned, persistent, and never creates successful evidence", async () => {
  const f = setup();
  const job = await start(f);
  await expect(
    f.service.execute(f.context, {
      probe: "config",
      operation: "cancel",
      parameters: { probe_run_id: "f".repeat(32) },
      idempotency_key: "foreign",
    }),
  ).rejects.toThrow("不属于");
  await f.service.execute(f.context, {
    probe: "config",
    operation: "cleanup",
    parameters: { probe_run_id: job.probe_run_id },
    idempotency_key: "cancel",
  });
  await new ProbeService(f.options).tick();
  expect(f.adapter.advance).not.toHaveBeenCalled();
  expect(
    f.store.uow.read((tx) => tx.attachments.list(project_id)),
  ).toHaveLength(0);
});

test("token and profile are revalidated after asynchronous HEAD preparation", async () => {
  const f = setup();
  f.head.mockImplementationOnce(async () => {
    f.store.revokeToken(f.token.record.id);
    return "a".repeat(40);
  });
  await expect(start(f)).rejects.toThrow("Revoked");
  expect(
    f.store.uow
      .read((tx) =>
        tx.events.listAfter(
          project_id,
          assignments.scope === "work_item" ? ("C-1" as never) : undefined,
          0,
        ),
      )
      .some((e) => e.type === "probe_job"),
  ).toBe(false);
  const g = setup();
  g.head.mockImplementationOnce(async () => {
    g.disable();
    return "a".repeat(40);
  });
  await expect(start(g)).rejects.toThrow("授权已变化");
});

test("revoked profile stops queued work; failed adapter diagnostics are never exposed", async () => {
  const f = setup();
  await start(f);
  f.disable();
  await f.service.tick();
  expect(f.adapter.advance).not.toHaveBeenCalled();
  const g = setup();
  const job = await start(g);
  g.adapter.advance = async () => {
    throw new Error("SECRET /private/provider.pem");
  };
  await g.service.tick();
  const view = await g.service.execute(g.context, {
    probe: "config",
    operation: "status",
    parameters: { probe_run_id: job.probe_run_id },
    idempotency_key: "read",
  });
  expect(view).toMatchObject({ cleanup: "held" });
  expect(JSON.stringify(view)).not.toContain("SECRET");
  expect(
    g.store.uow.read((tx) => tx.attachments.list(project_id)),
  ).toHaveLength(0);
});

test("attachment persistence failures can recover after execution and cleanup without rerunning", async () => {
  const f = setup();
  await start(f);
  writeFileSync(join(f.dataDir, "attachments"), "unavailable");
  await expect(f.service.tick()).rejects.toThrow();
  unlinkSync(join(f.dataDir, "attachments"));
  await new ProbeService(f.options).tick();
  expect(f.adapter.advance).toHaveBeenCalledOnce();
  expect(
    f.store.uow.read((tx) => tx.attachments.list(project_id)),
  ).toHaveLength(1);
});

test("a cancellation arriving during IO survives the completion checkpoint", async () => {
  const f = setup();
  const job = await start(f);
  f.adapter.advance = async (j: ProbeJob) => {
    await f.service.execute(f.context, {
      probe: "config",
      operation: "cancel",
      parameters: { probe_run_id: job.probe_run_id },
      idempotency_key: "cancel-in-flight",
    });
    return {
      ...j,
      status: "passed",
      tested_sha: j.head_sha,
      cleanup: "complete",
    };
  };
  await f.service.tick();
  expect(
    f.store.uow.read((tx) => tx.attachments.list(project_id)),
  ).toHaveLength(0);
});
