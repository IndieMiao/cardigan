import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginMachineObservation,
  completeMachineObservation,
  Store,
} from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  assignment,
  card,
  fixture,
  machine,
  run,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { event } from "../../../../packages/store/src/test-support.js";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";
import { MachineChecks } from "./machine-checks.js";
import { type MachineHost, machineHost } from "./machine-host.js";
import { machineView } from "./machine-view.js";

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
    const registration = {
      ...machine(),
      id: "worker",
      herdr_machine: "worker",
    };
    expect(host.bindingFingerprint?.("example", registration)).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(host.upgradeCommand?.("example", registration)).toContain(
      "sha256sum",
    );
    // Changing the private enrollment alone invalidates the command and its Needs You cache key.
    const manualBinding = () =>
      host.bindingFingerprint?.("example", registration, "manual-upgrade");
    const binding = manualBinding();
    expect(binding).toBe(host.bindingFingerprint?.("example", registration));
    await writeFile(join(root, "upgrade-6-worker-example.key"), "fixture", {
      mode: 0o600,
    });
    expect(manualBinding()).toBeUndefined();
    expect(host.upgradeCommand?.("example", registration)).toBeUndefined();
    expect(host.bindingFingerprint?.("example", registration)).toBe(binding);
    await rm(join(root, "upgrade-6-worker-example.key"));
    expect(manualBinding()).toBe(binding);
    expect(host.bindingFingerprint?.("other", registration)).toBeUndefined();
    expect(host.upgradeCommand?.("other", registration)).toBeUndefined();
    expect(
      host.bindingFingerprint?.("example", { ...registration, os: "darwin" }),
    ).toBeUndefined();
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
        "fixture-check",
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

test("active runs use the work item's card, then their own trigger's card, otherwise null", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    const project = "example";
    store.createProject({ id: project });
    store.uow.run((tx) => {
      const triggerCard = card(8);
      tx.cards.put(project, { ...triggerCard, project_id: project });
      const work = fixture().work_items[0];
      if (!work) throw new Error("missing work item");
      tx.work_items.put(project, work);
      tx.assignments.put(project, assignment(1));
      const { work_item_id: _work, ...standing } = assignment(2, "pm");
      tx.assignments.put(project, { ...standing, scope: "standing" });
      const fromCard = event({ seq: 1, card_id: triggerCard.id });
      const { card_id: _card, ...fromProject } = event({ seq: 2 });
      for (const trigger of [fromCard, fromProject])
        tx.events.append(project, trigger);
      tx.runs.put(project, { ...run(1, 1), trigger_event_id: fromCard.id });
      tx.runs.put(project, { ...run(2, 2), trigger_event_id: fromCard.id });
      tx.runs.put(project, { ...run(3, 2), trigger_event_id: fromProject.id });
    });
    const clock = { now: () => new Date().toISOString() };
    const checks = new MachineChecks(
      store,
      clock,
      new AbortController().signal,
    );
    const assignments = machineView(
      store,
      project,
      { checks },
      clock.now(),
      "local",
    )[0]?.bindings[0]?.assignments;
    expect(
      assignments
        ?.flatMap((a) => a.runs)
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      { id: "R-1", status: "running", card_id: "C-1" },
      { id: "R-2", status: "running", card_id: "C-8" },
      { id: "R-3", status: "running", card_id: null },
    ]);
  } finally {
    store.close();
  }
});

test.each([true, false])(
  "helper completion requires fresh checks and ignores submitted results (legacy=%s)",
  async (legacy) => {
    let broken = true;
    let binding: string | undefined = "pinned";
    let command = "current release";
    const check = vi.fn<MachineHost["check"]>(async (_p, _m, kind) =>
      kind === "worker" && broken
        ? { status: "failed", failed_steps: ["directories"] }
        : { status: "passed", failed_steps: [] },
    );
    const f = await m5Cross({
      machineHost: {
        check,
        bindings: () => () => null,
        bindingFingerprint: () => binding,
        upgradeCommand: () => command,
        workerRecord: () => null,
      },
    });
    try {
      const project = f.project.project_id;
      const id = f.store().uow.run((tx) => {
        const local = tx.machines.get(project, "local");
        if (!local) throw new Error("missing fixture");
        tx.machines.put(project, {
          ...local,
          id: "remote",
          label: "Remote",
          herdr_machine: "remote",
        });
        const id = tx.ids.next(project, "human_action");
        tx.human_actions.put(project, {
          id,
          key: id,
          status: "open",
          requested_by: "system",
          instructions: "Install",
          why_human: "Administrator",
          expected_return: "Result",
          blocked_work_items: [],
          triage: "host",
          ...(!legacy
            ? {
                helper_upgrade: { machine_id: "remote", binding: "pinned" },
                terminal: {
                  target: "remote",
                  login: "owner",
                  command,
                  expected_output: "ok",
                  on_failure: "stop",
                },
              }
            : {}),
        });
        tx.events.append(project, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project),
          created_at: new Date(f.now()).toISOString(),
          actor: { kind: "system", project_id: project },
          type: "host_deployment_action_requested",
          payload: {
            key: `worker-helper:remote:${Array(3).fill("a".repeat(64)).join(":")}`,
            reason: "worker_maintenance",
            human_action_id: id,
          },
        });
        return id;
      });
      await f.password(TEST_PASSWORD);
      await f.login();
      const needs = async () =>
        (await f.call(f.projectPath("/needs-you"))).json as {
          human_actions: { id: string; terminal?: { command: string } }[];
        };
      if (!legacy) {
        const revision = async () =>
          (
            (await f.call(f.projectPath("/needs-you/version"))).json as {
              revision: string;
            }
          ).revision;
        const previous = await revision();
        expect(
          (await needs()).human_actions.find((h) => h.id === id)?.terminal
            ?.command,
        ).toBe(command);
        command = "new release";
        expect(
          (await needs()).human_actions.find((h) => h.id === id)?.terminal,
        ).toBeUndefined();
        command = "current release";
        binding = "replaced";
        expect(await revision()).not.toBe(previous);
        expect(
          (await needs()).human_actions.find((h) => h.id === id)?.terminal,
        ).toBeUndefined();
      }
      binding = undefined;
      expect(
        (await needs()).human_actions.find((h) => h.id === id)?.terminal,
      ).toBeUndefined();
      const submit = (key: string, body: unknown) =>
        f.call(f.projectPath(`/human-actions/${id}/complete`), {
          method: "POST",
          headers: { "idempotency-key": key },
          body,
        });
      expect(
        (
          await submit("forged", {
            text: "installed",
            checks: { worker: "passed" },
          })
        ).status,
      ).toBe(400);
      expect((await submit("unbound", { text: "done" })).json).toMatchObject({
        status: "open",
        helper_checks: {
          worker: { status: "failed" },
          machine: { status: "failed" },
        },
      });
      expect(check).not.toHaveBeenCalled();
      binding = "pinned";
      const attempt = () => submit("failed", { text: "installed" });
      expect((await attempt()).json).toMatchObject({
        status: "open",
        helper_checks: {
          worker: { status: "failed", failed_steps: ["directories"] },
          machine: { status: "passed" },
        },
      });
      await attempt();
      expect(check.mock.calls.map((c) => c.slice(0, 3))).toEqual([
        [project, "remote", "worker"],
        [project, "remote", "machine"],
      ]);
      expect((await f.call(f.projectPath("/needs-you"))).json).toMatchObject({
        human_actions: expect.arrayContaining([
          expect.objectContaining({ id, helper_checks: expect.anything() }),
        ]),
      });
      broken = false;
      const gate = Promise.withResolvers<void>(),
        started = Promise.withResolvers<void>();
      const locks = vi.spyOn(MachineChecks.prototype, "withHelperConfirmation");
      check.mockImplementationOnce(async () => {
        started.resolve();
        await gate.promise;
        return { status: "passed", failed_steps: [] };
      });
      const retry = () => submit("retry", { text: "repaired" });
      const first = retry();
      await started.promise;
      const duplicate = retry(),
        conflict = submit("retry", { text: "different" });
      try {
        await vi.waitFor(() => expect(locks).toHaveBeenCalledTimes(3));
      } finally {
        gate.resolve();
        locks.mockRestore();
      }
      const done = await first;
      expect((await duplicate).json).toEqual(done.json);
      expect((await conflict).status).toBe(409);
      expect(done.json).toMatchObject({
        status: "done",
        helper_checks: {
          worker: { status: "passed" },
          machine: { status: "passed" },
        },
      });
      expect(check).toHaveBeenCalledTimes(4);
    } finally {
      await f.close();
    }
  },
);

test("C-599: an attachment tools notice shows only the command the current binding and release give", async () => {
  let binding: string | undefined = "pinned";
  let command = "current release";
  const f = await m5Cross({
    machineHost: {
      check: async () => ({ status: "passed", failed_steps: [] }),
      bindings: () => () => null,
      bindingFingerprint: () => binding,
      upgradeCommand: () => (binding === "pinned" ? command : "other binding"),
      workerRecord: () => null,
    },
  });
  try {
    const project = f.project.project_id;
    const id = f.store().uow.run((tx) => {
      const local = tx.machines.get(project, "local");
      if (!local) throw new Error("missing fixture");
      tx.machines.put(project, {
        ...local,
        id: "remote",
        label: "Remote",
        herdr_machine: "remote",
      });
      const id = tx.ids.next(project, "human_action");
      tx.human_actions.put(project, {
        id,
        key: id,
        status: "open",
        requested_by: "system",
        instructions: "Install tools",
        why_human: "Administrator",
        expected_return: "Result",
        blocked_work_items: [],
        triage: "host",
        terminal: {
          target: "remote",
          login: "owner",
          command: "current release",
          expected_output: "ok",
          on_failure: "stop",
        },
        // A handoff can never substitute the administrator command.
        handoff: {
          terminal: {
            target: "remote",
            login: "owner",
            command: "rewritten",
            expected_output: "ok",
            on_failure: "stop",
          },
          title: "t",
          summary: "s",
          why_human: "w",
          instructions: "i",
          expected_outcome: "o",
          expected_return: "r",
          rewritten_by: "system",
          rewritten_at: new Date(f.now()).toISOString(),
        },
      });
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project),
        created_at: new Date(f.now()).toISOString(),
        actor: { kind: "system", project_id: project },
        type: "host_deployment_action_requested",
        payload: {
          key: `worker-agent-tools:remote:${"b".repeat(64)}`,
          reason: "worker_maintenance",
          human_action_id: id,
        },
      });
      return id;
    });
    await f.password(TEST_PASSWORD);
    await f.login();
    const shown = async () =>
      (
        (await f.call(f.projectPath("/needs-you"))).json as {
          human_actions: {
            id: string;
            instructions: string;
            terminal?: { command: string };
          }[];
        }
      ).human_actions.find((h) => h.id === id);
    const revision = async () =>
      (
        (await f.call(f.projectPath("/needs-you/version"))).json as {
          revision: string;
        }
      ).revision;
    expect((await shown())?.terminal?.command).toBe("current release");
    // A new release: the stored command is hidden, not replaced.
    command = "new release";
    const hidden = await shown();
    expect(hidden?.terminal).toBeUndefined();
    expect(hidden?.instructions).toContain("当前升级命令不可用");
    command = "current release";
    const previous = await revision();
    binding = "replaced";
    expect(await revision()).not.toBe(previous);
    expect((await shown())?.terminal).toBeUndefined();
    binding = undefined;
    expect((await shown())?.terminal).toBeUndefined();
  } finally {
    await f.close();
  }
});
