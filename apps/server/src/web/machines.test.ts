import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginMachineObservation,
  completeMachineObservation,
  Store,
} from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";
import { type MachineHost, machineHost } from "./machine-host.js";

test("global read, atomic drain/resume, authenticated single-flight checks and durable results", async () => {
  const gate = Promise.withResolvers<void>();
  const check = vi.fn<MachineHost["check"]>(async (_p, _m, _k, progress) => {
    progress("runtime");
    await gate.promise;
    throw new Error("sensitive host exception");
  });
  const f = await m5Cross({
    machineHost: {
      check,
      bindings: () => () => null,
      workerRecord: () => null,
    },
    runLimit: () => 7,
    resourceLimits: () => new Map([["gpu", 2]]),
  });
  try {
    const store = f.store(),
      project = f.project.project_id;
    store.createProject({ id: "peer" });
    const now = new Date(f.now()).toISOString();
    beginMachineObservation(
      store,
      { kind: "system", project_id: "peer" },
      "peer",
      "local",
      "probe",
      now,
    );
    completeMachineObservation(
      store,
      { kind: "system", project_id: "peer" },
      "peer",
      "local",
      "probe",
      {
        status: "passed",
        checked_at: now,
        blockers: [],
        launch_enabled: false,
      },
      [
        {
          key: "node",
          version: "24",
          verified_at: now,
          evidence_ref: "private-ref",
        },
      ],
    );
    const machines = f.projectPath("/machines"),
      path = `${machines}/local`;
    const write = (url: string, body: Record<string, unknown> = {}) =>
      f.call(url, { method: "POST", body });
    const headers = { authorization: `Bearer ${f.token(f.primary.owner)}` };
    for (const suffix of ["", "/check", "/drain", "/resume"]) {
      expect(
        (
          await f.call(path + suffix, {
            headers,
            anonymous: true,
            ...(suffix ? { method: "POST", body: {} } : {}),
          })
        ).status,
      ).toBe(401);
    }
    await f.password(TEST_PASSWORD);
    await f.login();
    expect(
      (await f.call(`${path}/check`, { headers, method: "POST", body: {} }))
        .status,
    ).toBe(403);
    expect(
      (await write(`${path}/check`, { command: "forbidden" })).status,
    ).toBe(400);
    const detail = await f.call(path);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({
      machine: {
        id: "local",
        run_limit: 7,
        max_assignments: 7,
        resources: [{ key: "gpu", limit: 2 }],
        bindings: expect.arrayContaining([
          expect.objectContaining({
            project_id: project,
            is_current: true,
            assignments: expect.arrayContaining([
              expect.objectContaining({
                assignment_id: f.primary.owner.id,
                role_id: f.primary.owner.role_id,
                card_id: f.card.id,
              }),
            ]),
          }),
          expect.objectContaining({
            project_id: "peer",
            is_current: false,
            capabilities: [
              expect.objectContaining({
                key: "node",
                version: "24",
                verified_at: now,
                available: true,
              }),
            ],
          }),
        ]),
      },
    });
    expect(detail.text).not.toMatch(/private-ref|mcp_token|runtime_ref/i);
    expect((await f.call(machines)).json).toMatchObject({
      machines: expect.arrayContaining([
        expect.objectContaining({ id: "local" }),
      ]),
    });
    const [a, b] = await Promise.all([
      write(`${path}/check`),
      write("/api/projects/peer/machines/local/check"),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    const { check: job } = a.json as {
      check: { id: string; project_id: string };
    };
    expect(b.json).toMatchObject({
      check: { id: job.id, project_id: job.project_id },
    });
    expect(check).toHaveBeenCalledTimes(1);
    const poll = `${path}/checks/${job.id}`;
    expect((await f.call(poll)).json).toMatchObject({
      check: { status: "running", step: "runtime" },
    });
    gate.resolve();
    await vi.waitFor(async () => {
      const result = await f.call(poll);
      expect(result.json).toMatchObject({
        check: { id: job.id, status: "failed", failed_steps: ["runtime"] },
      });
      expect(result.text).not.toContain("sensitive");
    });
    expect((await f.call(path)).json).toMatchObject({
      machine: {
        bindings: expect.arrayContaining([
          expect.objectContaining({
            project_id: job.project_id,
            last_requested_check: expect.objectContaining({
              id: job.id,
              status: "failed",
            }),
          }),
        ]),
      },
    });
    const retry = await write(`${path}/check`);
    expect(retry.json).not.toMatchObject({ check: { id: job.id } });
    expect((await f.call(poll)).status).toBe(200);
    expect((await write(`${path}/drain`)).status).toBe(200);
    const states = () =>
      store.uow.read((tx) =>
        [project, "peer"].map((p) => tx.machines.get(p, "local")?.status),
      );
    expect(states()).toEqual(["draining", "draining"]);
    expect((await write(`${path}/resume`)).status).toBe(200);
    expect(states()).toEqual(["online", "online"]);
    store.uow.run((tx) => {
      const m = tx.machines.get("peer", "local");
      if (m) tx.machines.put("peer", { ...m, status: "offline" });
    });
    expect((await write(`${path}/drain`)).status).toBe(409);
    expect(states()).toEqual(["online", "offline"]);
    const audit = store.uow
      .read((tx) => tx.global_events.listAfter(0))
      .filter((e) => e.type.startsWith("machine_"));
    expect(audit.map((e) => e.type)).toEqual([
      "machine_check_requested",
      "machine_check_joined",
      "machine_check_finished",
      "machine_check_requested",
      "machine_check_finished",
      "machine_drain_requested",
      "machine_resume_requested",
    ]);
    for (const e of audit.filter((e) => e.type !== "machine_check_finished"))
      expect(e).toMatchObject({
        actor: { kind: "human" },
        payload: { member_id: expect.any(String), machine_id: "local" },
      });
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("host adapter projects a private worker binding and reads a blocked worker step without configuration or journal secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "machine-read-"));
  const store = Store.open({ dbPath: ":memory:" });
  try {
    const input = {
      version: 1,
      machines: [
        {
          id: "worker",
          os: "linux",
          arch: "x64",
          host: "private.invalid",
          port: 22,
          identity_file: "/private/identity",
          known_hosts_file: "/private/known_hosts",
          host_key_alias: "worker",
          projects: [
            {
              project_id: "example",
              user: "worker_user",
              gid: 2300,
              alias: "binding",
              session: "bound",
              root: "/worker/example",
              path: "/bin:/usr/bin",
              generation: "secret_generation",
              publication: {
                header_max_bytes: 65536,
                file_max_bytes: 1048576,
                batch_max_bytes: 8388608,
                timeout_ms: 30000,
              },
              python: "/usr/bin/python3",
              file_helper: "/worker/example/libexec/worker-files.py",
              git_helper: "/worker/example/libexec/worker-git.py",
              mcp_url: "https://private.example.ts.net/mcp",
            },
          ],
        },
      ],
    };
    await writeFile(join(root, "runtime-workers.yaml"), JSON.stringify(input), {
      mode: 0o600,
    });
    const host = machineHost(
      store,
      { mode: "local", dataDir: root },
      "local-session",
      { CARDIGAN_CONFIG_DIR: root },
    );
    expect(host.bindings()("example", "worker")).toEqual({
      account: "worker_user",
      directory: "/worker/example",
      session: "bound",
      path_entries: 2,
    });
    expect(host.bindings()("other", "worker")).toBeNull();
    expect(host.workerRecord("example", "worker")).toBeNull();
    if (process.platform === "linux") {
      await writeFile(
        join(root, "worker-worker-example.yaml"),
        JSON.stringify({
          version: 1,
          runtime: input,
          uid: 2300,
          home: "/home/example",
          mcp_url: "https://private.example.ts.net/mcp",
        }),
        { mode: 0o600 },
      );
      const steps: string[] = [];
      // No registration -> block at the first real wizard step. No SSH or registration writes.
      const result = await host.check(
        "example",
        "worker",
        "worker",
        (step) => steps.push(step),
        new AbortController().signal,
      );
      expect(steps).toEqual(["configuration", "registration"]);
      expect(result).toEqual({
        status: "failed",
        failed_steps: ["registration"],
      });
      expect(host.workerRecord("example", "worker")).toEqual({
        status: "failed",
        checked_at: expect.any(String),
        failed_steps: ["registration"],
      });
    }
  } finally {
    store.close();
    await rm(root, { force: true, recursive: true });
  }
});
