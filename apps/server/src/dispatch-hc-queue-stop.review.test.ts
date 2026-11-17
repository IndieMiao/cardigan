import { stoppedByHuman, stopWorkItemAssignment } from "@cardigan/domain";
import { type HcClient, HerdrRuntime } from "@cardigan/runtime-herdr";
import { listBellAttempts } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { HC_RELEASE } from "../../../packages/runtime-herdr/src/hc-version.js";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

// Independent review proof: real adapter and its four-slot queue, fake hc IO.
// No actual employee, hc process, network connection or CPU load is created.
test("a human stop while the bell waits in the hc queue must prevent the actual send", async () => {
  const f = recoveryFixture();
  let release = () => {};
  const occupied = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: string[] = [];
  const client: HcClient = {
    available: async () => true,
    async *lines() {},
    exec: vi.fn(async (args) => {
      if (args[0] === "--version") return `hc ${HC_RELEASE.version}`;
      if (args[0] === "send") {
        const bell = args.at(-1) ?? "";
        if (bell.startsWith("occupy-")) await occupied;
        else sent.push(bell);
      }
      return "{}";
    }),
  };
  const created = await HerdrRuntime.create({
    client,
    execution: { mode: "local", dataDir: f.dataDir },
    session: "review-queued-stop",
    socketPath: `${f.dataDir}/fake.sock`,
    env: { CARDIGAN_HC_CONCURRENCY: "4", CARDIGAN_HC_QUEUE_WAIT_MS: "30000" },
  });
  if (!created.ok) throw new Error(created.error.message);
  const adapter = created.value;
  const ref = f.refFor(f.target.assignment);
  const holders = Array.from({ length: 4 }, (_, i) =>
    adapter.wake(ref, `occupy-${i}`),
  );
  let sending: Promise<void> | undefined;
  try {
    await expect.poll(() => adapter.diagnostics().active).toBe(4);
    f.runtime.wake = vi.fn((...args) => adapter.wake(...args));
    f.comment();
    sending = new Dispatcher(f.options).tick();
    await expect.poll(() => adapter.diagnostics().queued).toBe(1);
    expect(sent).toHaveLength(0);
    f.apply((state, actor, ports) =>
      stopWorkItemAssignment(
        state,
        actor,
        {
          assignment_id: f.target.assignment.id,
          reason: "stop while hc send is still queued",
        },
        ports,
      ),
    );
    expect(stoppedByHuman(f.state().events, f.target.assignment.id)).toBe(true);
    expect(sent).toHaveLength(0);
    release();
    await Promise.all(holders);
    await sending;
    const observed = {
      humanStopped: stoppedByHuman(f.state().events, f.target.assignment.id),
      actualSends: sent.length,
      runStatus: f.latest().status,
      attempts: listBellAttempts(f.store.database, f.project).map(
        (a) => a.outcome,
      ),
      notices: f.notes().map((n) => n.status),
    };
    console.log(JSON.stringify(observed));
    expect(sent, "human stop was persisted before hc send began").toHaveLength(
      0,
    );
    expect(observed.attempts).toEqual([]);
    expect(observed.notices).not.toContain("belled");
  } finally {
    release();
    await Promise.allSettled(holders);
    await sending;
    f.close();
  }
});
