import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Assignment, MachineRunCapacity, Run } from "@cardigan/domain";
import {
  canDispatchRun,
  isRunCapacityExempt,
  setRunLimit,
} from "@cardigan/domain";
import {
  acquireMergeCheckCapacity,
  effectiveRunLimit,
  loadRunCapacityConfig,
  runCapacitySnapshot,
} from "@cardigan/host";
import { beginLaunchAttempt, persistRunLimitEffect } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { startCardiganServer } from "./server.js";
import { executionCapacity } from "./web/execution-capacity.js";

test.each(["missing", "configured", "invalid"] as const)(
  "PM capacity shares scheduler and execution totals with %s config",
  async (configuration) => {
    const f = dispatchFixture();
    const own = f.create();
    const { work_item_id: _workItem, ...base } = own.assignment;
    const pm: Assignment = {
      ...base,
      id: "A-900",
      scope: "standing",
      role_id: "pm",
      standing_mode: "ops",
    };
    const office: Assignment = { ...pm, id: "A-910", standing_mode: "office" };
    const hostOps: Assignment = {
      ...base,
      id: "A-911",
      scope: "standing",
      role_id: "host_ops",
    };
    const workPm: Assignment = {
      ...own.assignment,
      id: "A-912",
      role_id: "pm",
    };
    const other = "other-project";
    f.store.createProject({ id: other });
    f.store.uow.run((tx) => {
      tx.roles.put(f.project, {
        role_id: "pm",
        role_version: 1,
        allowed_tools: ["project_snapshot"],
        capabilities: [],
      });
      tx.assignments.put(f.project, pm);
      tx.cards.put(other, {
        ...own.card,
        project_id: other,
        title: "Private foreign card",
      });
    });
    const seedRun = (
      project: string,
      owner: Assignment,
      id: Run["id"],
      status: Run["status"],
      queue_reason?: Run["queue_reason"],
    ): Run =>
      f.store.uow.run((tx) => {
        tx.assignments.put(project, owner);
        const event = {
          id: tx.ids.nextEventId(),
          seq: tx.events.listAfter(project, undefined, 0).length + 1,
          type: "run_queued" as const,
          actor: { kind: "system" as const, project_id: project },
          payload: {},
          created_at: f.clock.now(),
        };
        tx.events.append(project, event);
        const run: Run = {
          id,
          assignment_id: owner.id,
          trigger_event_id: event.id,
          kind: "initial",
          status,
          role_version: 1,
          model: "fixture",
          agent_cli_version: "fixture",
          outcome: null,
          summary: "Private run detail",
          ...(queue_reason ? { queue_reason } : {}),
        };
        tx.runs.put(project, run);
        return run;
      });
    seedRun(f.project, own.assignment, "R-800", "running");
    seedRun(f.project, pm, "R-801", "running");
    seedRun(f.project, office, "R-810", "running");
    seedRun(other, hostOps, "R-811", "running");
    seedRun(other, workPm, "R-812", "running");
    seedRun(other, { ...own.assignment, id: "A-901" }, "R-802", "acked");
    seedRun(
      other,
      { ...own.assignment, id: "A-902", machine_id: "worker" },
      "R-803",
      "dispatched",
    );
    if (configuration !== "missing")
      writeFileSync(
        join(f.dataDir, "run-capacity.yaml"),
        configuration === "invalid"
          ? "machines: { local: 0 }\n"
          : "machines: { local: { limit: 3, max_limit: 8, display_name: Workstation }, worker: 2 }\n",
        { mode: 0o600 },
      );
    const config = await loadRunCapacityConfig({ configDir: f.dataDir });
    const server = await startCardiganServer({
      store: f.store,
      config: { dataDir: f.dataDir, host: "127.0.0.1", port: 0 },
      env: { CARDIGAN_CONFIG_DIR: f.dataDir },
      warn: () => {},
      log: () => {},
    });
    const token = f.store.issueToken({
      project_id: f.project,
      assignment_id: pm.id,
      role: { role_version: 1, allowed_tools: ["project_snapshot"] },
    });
    const client = new Client({ name: "capacity-fixture", version: "1" });
    const releaseChecks: Array<() => void> = [];
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { Authorization: `Bearer ${token.token}` } },
        }),
      );
      const snapshot = async () => {
        const result = await client.callTool({
          name: "project_snapshot",
          arguments: { project_id: other },
        });
        expect(result.isError).not.toBe(true);
        for (const privateValue of [
          other,
          "Private foreign card",
          "Private run detail",
          "A-901",
          "R-802",
        ])
          expect(JSON.stringify(result)).not.toContain(privateValue);
        const data = result.structuredContent as {
          project_id: string;
          run_capacity: MachineRunCapacity[];
        };
        expect(data.project_id).toBe(f.project);
        const capacity = data.run_capacity;
        expect(capacity).toEqual(
          executionCapacity(
            f.store,
            config.forMachine,
            undefined,
            config.maxForMachine,
            config.displayNameForMachine,
          ).agents,
        );
        f.store.uow.read((tx) => {
          const dispatch = runCapacitySnapshot(f.store, tx);
          for (const machine of capacity) {
            expect(machine.running + machine.merge_check_slots).toBe(
              dispatch.occupied.get(machine.machine_id),
            );
            expect(machine.total_running).toBe(
              dispatch.allAgentOccupied.get(machine.machine_id),
            );
            expect(machine.running).toBe(
              dispatch.agentOccupied.get(machine.machine_id),
            );
            expect(machine.limit).toBe(
              effectiveRunLimit(
                f.store,
                machine.machine_id,
                config.forMachine,
                config.maxForMachine,
              ),
            );
            expect(machine.queued).toBe(
              dispatch.queue.filter((r) => r.machine_id === machine.machine_id)
                .length,
            );
            expect(Object.keys(machine).sort()).toEqual([
              "label",
              "limit",
              "machine_id",
              "max_limit",
              "merge_check_slots",
              "queued",
              "running",
              "total_running",
            ]);
          }
        });
        return capacity;
      };
      expect(await snapshot()).toEqual([
        {
          machine_id: "local",
          label: configuration === "configured" ? "Workstation" : "local",
          running: 3,
          total_running: 6,
          limit:
            configuration === "invalid"
              ? 0
              : configuration === "configured"
                ? 3
                : 4,
          max_limit:
            configuration === "invalid"
              ? 0
              : configuration === "configured"
                ? 8
                : 16,
          queued: 0,
          merge_check_slots: 0,
        },
        {
          machine_id: "worker",
          label: "worker",
          running: 1,
          total_running: 1,
          limit:
            configuration === "invalid"
              ? 0
              : configuration === "configured"
                ? 2
                : 4,
          max_limit: configuration === "invalid" ? 0 : 16,
          queued: 0,
          merge_check_slots: 0,
        },
      ]);
      // Standing roles never enter the capacity queue; work-item PMs still do.
      seedRun(
        other,
        { ...own.assignment, id: "A-903" },
        "R-804",
        "queued",
        "concurrency_limit",
      );
      seedRun(
        f.project,
        { ...own.assignment, id: "A-904" },
        "R-805",
        "queued",
        "concurrency_limit",
      );
      seedRun(
        other,
        { ...pm, id: "A-905" },
        "R-806",
        "queued",
        "concurrency_limit",
      );
      seedRun(
        other,
        { ...office, id: "A-913" },
        "R-813",
        "queued",
        "concurrency_limit",
      );
      seedRun(
        other,
        { ...hostOps, id: "A-914" },
        "R-814",
        "queued",
        "concurrency_limit",
      );
      seedRun(
        other,
        { ...workPm, id: "A-917" },
        "R-817",
        "queued",
        "concurrency_limit",
      );
      seedRun(
        other,
        { ...own.assignment, id: "A-906" },
        "R-807",
        "queued",
        "runtime_unavailable",
      );
      const reserved = seedRun(
        other,
        { ...own.assignment, id: "A-907" },
        "R-808",
        "queued",
        "concurrency_limit",
      );
      const stopping = seedRun(
        other,
        { ...own.assignment, id: "A-908" },
        "R-809",
        "unknown",
      );
      const exemptReserved = seedRun(
        other,
        { ...hostOps, id: "A-915" },
        "R-815",
        "queued",
        "concurrency_limit",
      );
      const exemptStopping = seedRun(
        other,
        { ...office, id: "A-916" },
        "R-816",
        "unknown",
      );
      f.store.uow.run((tx) => {
        for (const run of [reserved, exemptReserved])
          beginLaunchAttempt(f.store.database, {
            id: `reserved-start-${run.id}`,
            project_id: other,
            assignment_id: run.assignment_id,
            run_id: run.id,
            started_at: f.clock.now(),
            lease_until: new Date(
              Date.parse(f.clock.now()) + 60_000,
            ).toISOString(),
          });
        for (const run of [stopping, exemptStopping])
          tx.runs.put(other, {
            ...run,
            inactivity_stop: {
              attempt_id: "stop",
              runtime_ref: f.refFor(own.assignment),
              stopping: true,
              lease_until: f.clock.now(),
            },
          });
        const effect = setRunLimit(
          { kind: "human" },
          { machine_id: "local", limit: 6 },
          {
            machines: [{ id: "local" }],
            previous: 4,
            member_id: "M-1",
            clock: f.clock,
            ids: tx.global_ids,
          },
        );
        if (!effect.ok) throw new Error(effect.error.message);
        persistRunLimitEffect(f.store.database, tx, effect.value);
      });
      releaseChecks.push(
        acquireMergeCheckCapacity(f.store, other, "local-check"),
        acquireMergeCheckCapacity(
          f.store,
          other,
          "remote-check",
          undefined,
          "worker",
        ),
      );
      const before = f.state();
      const capacity = await snapshot();
      expect(capacity[0]).toMatchObject({
        running: 5,
        total_running: 10,
        queued: 3,
        merge_check_slots: 2,
        limit: configuration === "invalid" ? 0 : 6,
      });
      const local = capacity[0];
      if (!local) throw new Error("Missing local capacity");
      const occupied = local.running + local.merge_check_slots;
      for (const owner of [pm, office, hostOps])
        expect(
          canDispatchRun(local.limit, occupied, isRunCapacityExempt(owner)),
        ).toBe(true);
      expect(
        canDispatchRun(local.limit, occupied, isRunCapacityExempt(workPm)),
      ).toBe(false);
      expect(capacity[1]).toMatchObject({
        running: 1,
        total_running: 1,
        merge_check_slots: 0,
      });
      expect(f.state()).toEqual(before);
    } finally {
      for (const release of releaseChecks) release();
      await client.close();
      await server.close();
      f.close();
    }
  },
);
