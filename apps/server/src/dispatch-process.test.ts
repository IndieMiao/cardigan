import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { unfinishedBellAttempts } from "@cardigan/store";
import { expect, test } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";

interface Reply {
  phase: string;
  calls: number;
  intents: number;
  failures: number;
  runs: { id: string; status: string }[];
  notes: { id: string; status: string; recipient: string }[];
}

test("M3.4 real SIGKILL during wake: fresh processes respect the lease, recover once and keep the same Run", async () => {
  const f = recoveryFixture(),
    children: { process: ChildProcess; exited: Promise<unknown> }[] = [];
  const start = (mode: string) => {
    const child = fork(
      fileURLToPath(
        new URL("../test-support/dispatch-process.mjs", import.meta.url),
      ),
      [f.dataDir, f.project, f.clock.now(), mode],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(child, "exit");
    children.push({ process: child, exited });
    const reply = Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10000) }).then(
        ([message]) => message as Reply,
      ),
      exited.then(() => {
        throw new Error(`Child exited before reply: ${stderr}`);
      }),
    ]);
    return { child, exited, reply };
  };
  try {
    f.comment();
    const first = start("hold");
    expect(await first.reply).toEqual({ phase: "wake", intents: 1 });
    const intended = unfinishedBellAttempts(f.store.database, f.project)[0];
    if (!intended) throw new Error("Missing durable intent before wake");
    const runs = f.state().runs.map((r) => ({ id: r.id, status: r.status }));
    expect(runs).toHaveLength(2);
    expect(runs.at(-1)).toEqual({ id: intended.run_id, status: "dispatched" });
    expect(first.child.kill("SIGKILL")).toBe(true);
    expect(await first.exited).toEqual([null, "SIGKILL"]);

    const insideLease = start("recover");
    const pending = await insideLease.reply;
    await insideLease.exited;
    expect(pending).toMatchObject({ calls: 0, intents: 1, failures: 0, runs });
    expect(pending.notes).toHaveLength(1);
    expect(pending.notes[0]?.status).toBe("pending");

    f.advance(2001);
    const afterLease = start("recover");
    const recovered = await afterLease.reply;
    await afterLease.exited;
    expect(recovered).toMatchObject({
      phase: "recovered",
      calls: 0,
      intents: 0,
      failures: 0,
      runs,
    });
    expect(
      recovered.notes.find((n) => n.id === intended.notification_ids[0])
        ?.status,
    ).toBe("delivery_failed");
    expect(
      recovered.notes.filter((n) => n.recipient === "pm_ops"),
    ).toHaveLength(0);

    const again = start("recover");
    expect(await again.reply).toEqual(recovered);
    await again.exited;
  } finally {
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null)
        child.process.kill("SIGKILL");
      await child.exited.catch(() => {});
    }
    f.close();
  }
}, 30000);
