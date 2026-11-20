import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateWorkItem } from "@cardigan/domain";
import {
  loadRunCapacityConfig,
  MachineLeases,
  runCapacitySnapshot,
} from "@cardigan/host";
import { defaultMigrationsDir, listMigrations, migrate } from "@cardigan/store";
import { expect, onTestFinished, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

test.each(["snapshot", "historical", "exit_unconfirmed"] as const)(
  "v44 dispatch without a resource grant cannot retry on v45: %s",
  async (scenario) => {
    const migrations = await mkdtemp(join(tmpdir(), "cg-resource-v44-"));
    onTestFinished(() => rm(migrations, { recursive: true, force: true }));
    for (const { version, name, sql } of listMigrations(
      defaultMigrationsDir,
    ).filter((m) => m.version <= 44))
      await writeFile(
        join(migrations, `${String(version).padStart(4, "0")}_${name}.sql`),
        sql,
      );
    const f = recoveryFixture("local", migrations);
    onTestFinished(() => f.close());
    const requirements = (capabilities: string[]) =>
      f.apply((s, a, p) =>
        updateWorkItem(
          s,
          a,
          { work_item_id: f.target.item.id, requirements: { capabilities } },
          p,
        ),
      );
    requirements(["godot"]);
    vi.mocked(f.runtime.wake).mockResolvedValueOnce({
      ok: false,
      error: { code: "runtime_timeout", message: "synthetic" },
    });
    const settings = {
      ...f.options,
      dispatchTimeoutMs: 60_000,
      deliveryRetryBaseMs: 100,
    };
    f.comment();
    await new Dispatcher(settings).tick();
    const old = f.latest();
    expect(old).toMatchObject({
      status: "dispatched",
      resource_keys: ["godot"],
    });
    if (scenario !== "snapshot") {
      const { resource_keys: _snapshot, ...legacy } = old;
      f.store.uow.run((tx) => tx.runs.put(f.project, legacy));
      requirements([]); // This edit is not the original admission.
    }
    const upgrade = "0045_machine_resource_leases.sql";
    await copyFile(
      join(defaultMigrationsDir, upgrade),
      join(migrations, upgrade),
    );
    expect(migrate(f.store.database, migrations).map((m) => m.version)).toEqual(
      [45],
    );
    await writeFile(
      join(f.dataDir, "run-capacity.yaml"),
      JSON.stringify({
        machines: {
          local: {
            limit: 1,
            resources: { godot: 1 },
            resource_policies: {
              godot: { checks: { mount: ["/test/mount"] } },
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const cfg = await loadRunCapacityConfig({ configDir: f.dataDir });
    expect(cfg.errors).toEqual([]);
    const probe = vi.fn(async () =>
      scenario === "snapshot" ? "local" : undefined,
    );
    const leases = new MachineLeases(f.store, cfg, probe);
    const d = new Dispatcher({
      ...settings,
      leases,
      resourceLimits: cfg.resourcesForMachine,
      runLimit: cfg.forMachine,
    });
    const occupied = () =>
      f.store.uow.read(
        (tx) =>
          runCapacitySnapshot(f.store, tx, cfg.resourcesForMachine)
            .resourcesForMachine("local")
            .get("godot")?.occupied,
      );
    f.advance(100);
    await d.tick();
    expect(f.latest().id).toBe(old.id);
    expect(occupied()).toBe(1);
    expect(f.runtime.wake).toHaveBeenCalledTimes(1);
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(
      f.store.database
        .prepare(
          "SELECT reason,publication_wait FROM machine_resource_waits WHERE project=? AND run_id=?",
        )
        .get(f.project, old.id),
    ).toMatchObject({
      reason: expect.stringContaining("重新排队"),
      publication_wait: 0,
    });
    if (scenario === "exit_unconfirmed")
      vi.mocked(f.runtime.release).mockResolvedValue({
        ok: true,
        value: undefined,
      }); // status stays alive
    f.advance(60_000);
    await d.tick();
    expect(f.runtime.release).toHaveBeenCalledOnce();
    expect(f.runtime.wake).toHaveBeenCalledTimes(1);
    const events = f.state().events.map((e) => e.type);
    if (scenario === "exit_unconfirmed") {
      expect(events).toContain("run_dispatch_stalled");
      expect(events).not.toContain("run_dispatch_recovered");
      expect(occupied()).toBe(1);
      expect(f.latest().id).toBe(old.id);
    } else {
      expect(events).toContain("run_dispatch_recovered");
      expect(f.state().runs.find((r) => r.id === old.id)?.status).toBe(
        "cancelled",
      );
      expect(f.latest().id).not.toBe(old.id);
      if (scenario === "snapshot") expect(probe).toHaveBeenCalled();
    }
  },
);
