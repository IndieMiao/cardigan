import { Readable } from "node:stream";
import type { Run } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { authenticate } from "./auth.js";
import { startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
  project_id,
  seedProject,
  serverCard,
  workItems,
} from "./test-support.js";
import { mobileSigningTool } from "./tools/mobile-signing.js";

test("request has no selector beyond platform; host release needs the same running, token-bound dispatch", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    const { assignment: a } = seedProject(store, {
      allowed_tools: ["request_mobile_signature"],
    });
    const issued = store.issueToken({
      project_id,
      assignment_id: a.id,
      role: { role_version: 1, allowed_tools: ["request_mobile_signature"] },
    });
    const caller = authenticate(store, issued.token);
    if (!caller.ok) throw Error("missing test actor");
    const ctx = { store, identity: caller.value, revalidateToken: vi.fn() };
    const ref = {
      machine_id: a.machine_id,
      runtime_machine: "remote",
      launch_generation: { run_id: "R-1" as never, generation: "a".repeat(32) },
      terminal_ref: "t1",
      agent_name: "fixture",
    };
    const r: Run = {
      id: "R-1" as never,
      assignment_id: a.id,
      trigger_event_id: "event-1" as never,
      kind: "initial",
      status: "running",
      role_version: 1,
      model: "fixture",
      agent_cli_version: "test",
      outcome: null,
      summary: "",
      launch_publication: {
        phase: "started",
        generation: "a".repeat(32),
        target: {
          project_id,
          machine_id: a.machine_id,
          session: "test",
          generation: "one",
          fingerprint: "a".repeat(64),
        },
        lease_until: "2099-01-01T00:00:00.000Z",
        agent_name: "fixture",
        work_dir: "fixture",
        sha: null,
        token_id: issued.record.id,
        runtime_ref: ref,
        process: {
          uid: 42,
          machine: "remote",
          boot: "fixture",
          pid: 100,
          start: "1",
          process_group: 100,
          terminal: "t1",
        },
        log_offset: 0,
        artifacts: [],
        wait: false,
      },
    };
    store.uow.run((tx) => {
      tx.assignments.put(project_id, {
        ...a,
        runtime_state: "running",
        runtime_ref: ref,
      });
      tx.work_items.put(project_id, {
        ...workItems,
        assignment_id: a.id,
        status: "in_progress",
      });
      tx.cards.put(project_id, { ...serverCard, status: "in_progress" });
      tx.runs.put(project_id, r);
    });
    const input = { platform: "ios" };
    const invoke = async (options: Parameters<typeof mobileSigningTool>[0]) =>
      mobileSigningTool(options).handler(input, ctx);
    const tool = mobileSigningTool({});
    for (const patch of [
      { path: "other" },
      { run: "R-2" },
      { operation: "publish" },
      { platform: "aab" },
      { sha256: "a".repeat(64) },
    ])
      expect(tool.input.safeParse({ ...input, ...patch }).success).toBe(false);
    await expect(invoke({})).rejects.toThrow("未启用");
    const signMobile = vi.fn(async (scope, current) => {
      current();
      return scope;
    });
    await expect(invoke({ signMobile })).resolves.toEqual({
      project: project_id,
      machine: a.machine_id,
      card: workItems.card_id,
      run: r.id,
      assignment: a.id,
      platform: "ios",
      worker_uid: 42,
    });
    const bytes = Buffer.from([0, 0xf1, 2]);
    const openArtifact = vi.fn(async () => ({
      size: bytes.length,
      sha256: "a".repeat(64),
      stream: Readable.from([bytes]),
    }));
    const server = await startMcpServer({
      store,
      openMobileArtifact: openArtifact,
      deliveryVerifier: acceptingVerifierFor,
      acknowledgeRuns: false,
      log: () => {},
    });
    try {
      const url = `${server.url}?mobile_artifact=${"1".repeat(32)}&platform=ios`;
      const headers = { Authorization: `Bearer ${issued.token}` };
      const ok = await fetch(url, { headers });
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer())).toEqual(bytes);
      expect(ok.headers.get("cache-control")).toContain("no-store");
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(`${url}&path=other`, { headers })).status).toBe(404);
      expect((await fetch(url, { headers, method: "POST" })).status).toBe(404);
      expect(
        (
          await fetch(url, {
            headers: { ...headers, Origin: "https://invalid.example" },
          })
        ).status,
      ).toBe(404);
      const restricted = store.issueToken({
        project_id,
        assignment_id: a.id,
        role: { role_version: 1, allowed_tools: ["whoami"] },
      });
      expect(
        (
          await fetch(url, {
            headers: { Authorization: `Bearer ${restricted.token}` },
          })
        ).status,
      ).toBe(404);
      store.uow.run((tx) =>
        tx.runs.put(project_id, { ...r, status: "completed" }),
      );
      expect((await fetch(url, { headers })).status).toBe(404);
      expect(openArtifact).toHaveBeenCalledOnce();
      store.uow.run((tx) => tx.runs.put(project_id, r));
    } finally {
      await server.close();
    }
    const publication = r.launch_publication;
    if (!publication) throw new Error("missing fixture");
    for (const patch of [
      { token_id: "wrong" },
      { phase: "stopping" as const },
      { process: null },
    ]) {
      store.uow.run((tx) =>
        tx.runs.put(project_id, {
          ...r,
          launch_publication: { ...publication, ...patch },
        }),
      );
      await expect(invoke({ signMobile })).rejects.toThrow("未获");
    }
    expect(signMobile).toHaveBeenCalledTimes(1);
    store.uow.run((tx) => tx.runs.put(project_id, r));
    await expect(
      invoke({
        signMobile: async (_scope, current) => {
          store.uow.run((tx) =>
            tx.runs.put(project_id, { ...r, status: "completed" }),
          );
          current();
          return "must not release";
        },
      }),
    ).rejects.toThrow("未放行");
  } finally {
    store.close();
  }
});
