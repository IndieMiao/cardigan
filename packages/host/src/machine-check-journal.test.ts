import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { MachineCheckJournal } from "./machine-check-journal.js";
import { checkRegisteredMachine } from "./runtime-targets.js";

test("a live owner does not expire; a reused PID is interrupted and fenced before retry", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  let now = "2026-11-01T00:00:00Z";
  const journal = new MachineCheckJournal(store, { now: () => now });
  try {
    const first = journal.claim("one", "worker", "machine", "patrol");
    expect(journal.latest("worker", "one")).toBeNull(); // unattended patrol
    now = "2026-11-20T00:00:00Z";
    expect(journal.claim("two", "worker", "worker", "web")).toEqual({
      job: first.job,
      joined: true,
    });
    expect(journal.claim("two", "other", "worker", "cli").joined).toBe(false);
    expect(journal.latest("worker", "one")).toEqual(first.job); // explicit join
    expect(journal.latest("worker", "two", "worker")).toBeNull();
    // Simulate recovery on the same PID, but after a controller reboot.
    store.database
      .prepare("UPDATE machine_check_jobs SET owner_start=? WHERE id=?")
      .run("old-incarnation", first.job.id);
    expect(journal.read("worker", first.job.id)).toMatchObject({
      status: "failed",
      failed_steps: ["interrupted"],
    });
    const retry = journal.claim("two", "worker", "worker", "cli");
    expect(retry.joined).toBe(false);
    await expect(
      journal.execute(
        first.job,
        async () => true,
        () => ({ status: "passed", failed_steps: [] }),
      ),
    ).rejects.toThrow("no longer current");
    expect(journal.read("worker", retry.job.id)?.status).toBe("running");
  } finally {
    store.close();
  }
});

test("concurrent patrol and CLI machine checks reuse the exact same observation", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  const release = Promise.withResolvers<void>();
  // Fail runtime configuration inside the observation fence, without any subprocess.
  const create = vi.fn(async () => {
    await release.promise;
    throw new Error("fixture");
  });
  try {
    store.createProject({ id: "example" });
    const options = { store, project: "example", machine: "local" };
    const first = checkRegisteredMachine(options, create, "patrol");
    const second = checkRegisteredMachine(options, create, "cli");
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a.health).toMatchObject({
      status: "failed",
      blockers: ["machine_observation_failed"],
    });
    expect(b).toEqual(a);
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    store.close();
  }
});

test("if completion auditing rolls back, the listener frees the machine without advertising success", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    const journal = new MachineCheckJournal(store);
    const { job } = journal.claim("one", "worker", "worker", "web");
    await expect(
      journal.execute(
        job,
        async () => true,
        () => ({ status: "passed", failed_steps: [] }),
        () => {
          throw new Error("audit unavailable");
        },
      ),
    ).rejects.toThrow("audit unavailable");
    expect(journal.read("worker", job.id)).toMatchObject({
      status: "failed",
      failed_steps: ["record_result"],
    });
    expect(journal.claim("one", "worker", "worker", "cli").joined).toBe(false);
  } finally {
    store.close();
  }
});
