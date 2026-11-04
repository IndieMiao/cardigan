import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  Runtime,
  RuntimeLaunch,
  RuntimeObservation,
  RuntimeRef,
  RuntimeResult,
} from "@cardigan/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HerdrRuntime, type RuntimeEvent } from "./index.js";
import {
  assignment,
  launch,
  machine,
  ref,
  role,
  value,
} from "./test-support.js";

type ObservableRuntime = Runtime & {
  events(
    ref: RuntimeRef,
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeResult<RuntimeEvent>>;
};
const success = <T>(v: T): RuntimeResult<T> => ({ ok: true, value: v });
const missing = (): RuntimeResult<never> => ({
  ok: false,
  error: { code: "runtime_not_found", message: "Missing terminal" },
});
class MemoryRuntime implements ObservableRuntime {
  private seq = 0;
  private next = 0;
  private terminals = new Map<string, RuntimeObservation>();
  private listeners = new Set<(e: RuntimeEvent) => void>();
  private change(id: string, agent: RuntimeObservation["agent"]) {
    const status = {
      process: "alive" as const,
      agent,
      observed_seq: ++this.seq,
    };
    this.terminals.set(id, status);
    for (const listener of this.listeners)
      listener({
        seq: this.seq,
        type: "status",
        terminal_ref: id,
        observations: [{ terminal_ref: id, status }],
      });
  }
  async provision(
    _a: typeof assignment,
    _r: typeof role,
    _m: typeof machine,
    p: RuntimeLaunch,
  ) {
    const id = `t${++this.next}`;
    this.change(id, "idle");
    return success({ ...ref, terminal_ref: id, agent_name: p.agent_name });
  }
  async wake(
    r: RuntimeRef,
    text: string,
    options?: { readonly if_idle?: boolean },
  ) {
    const status = this.terminals.get(r.terminal_ref);
    if (!status) return missing();
    if (
      (options?.if_idle && status.agent !== "idle") ||
      status.agent === "blocked"
    )
      return {
        ok: false as const,
        error: { code: "runtime_conflict" as const, message: "Busy" },
      };
    this.change(r.terminal_ref, text as RuntimeObservation["agent"]);
    return success({ sent: true });
  }
  async status(r: RuntimeRef) {
    const status = this.terminals.get(r.terminal_ref);
    return status ? success({ ...status, observed_seq: this.seq }) : missing();
  }
  async interrupt(r: RuntimeRef) {
    if (!this.terminals.has(r.terminal_ref)) return missing();
    this.change(r.terminal_ref, "idle");
    return success(undefined);
  }
  async release(r: RuntimeRef, options: { readonly force: boolean }) {
    const status = this.terminals.get(r.terminal_ref);
    if (!status) return missing();
    if (!options.force && ["working", "blocked"].includes(status.agent))
      return {
        ok: false as const,
        error: { code: "runtime_conflict" as const, message: "Busy" },
      };
    this.terminals.delete(r.terminal_ref);
    this.seq++;
    return success(undefined);
  }
  async resume_or_replace(r: RuntimeRef, p: RuntimeLaunch) {
    await this.release(r, { force: true });
    return this.provision(assignment, role, machine, p);
  }
  async human_entry(r: RuntimeRef) {
    return success(`hc attach '${r.terminal_ref}'`);
  }
  async *events(r: RuntimeRef, signal?: AbortSignal) {
    const first = await this.status(r);
    if (!first.ok) {
      yield first;
      return;
    }
    const pending: RuntimeEvent[] = [];
    let ready: (() => void) | undefined;
    const push = (e: RuntimeEvent) => {
      if (e.terminal_ref === r.terminal_ref) {
        pending.push(e);
        ready?.();
      }
    };
    const abort = () => ready?.();
    this.listeners.add(push);
    signal?.addEventListener("abort", abort);
    try {
      yield success({
        seq: this.seq,
        type: "snapshot",
        observations: [{ terminal_ref: r.terminal_ref, status: first.value }],
      });
      while (!signal?.aborted) {
        if (!pending.length)
          await new Promise<void>((resolve) => {
            ready = resolve;
          });
        for (const e of pending.splice(0)) yield success(e);
      }
    } finally {
      this.listeners.delete(push);
      signal?.removeEventListener("abort", abort);
    }
  }
}
const binary = process.env.CARDIGAN_TEST_HC ?? join(homedir(), ".local/bin/hc");
let skipReason = "";
try {
  const version = execFileSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 3000,
  }).trim();
  if (version !== "hc 0.1.18")
    skipReason = `requires hc 0.1.18, found ${version}`;
} catch {
  skipReason = "hc 0.1.18 is not installed";
}
if (skipReason) console.info(`Runtime integration skipped: ${skipReason}`);
const exec = promisify(execFile);
async function nextEvent(iterator: AsyncIterator<RuntimeResult<RuntimeEvent>>) {
  const next = await iterator.next();
  if (next.done) throw new Error("Runtime event stream ended");
  return value(next.value);
}
const fakeAgent = String.raw`
const report = state => process.stdout.write('\x1b]7501;state='+state+':app=cardigan-fixture\x1b\\');
process.stdin.setRawMode(true); process.stdin.resume(); let line='';
process.stdin.on('data', bytes => { for(const c of bytes.toString()) {
 if(c === '\x1b' || c === '\x03') { report('idle'); line=''; }
 else if(c === '\r' || c === '\n') { if(line) report(line.trim()); line=''; }
 else line += c;
}}); report('idle');
`;
interface Fixture {
  runtime: ObservableRuntime;
  launch: RuntimeLaunch;
  cleanup(): Promise<void>;
  inspect?(r: RuntimeRef): Promise<unknown>;
}
async function realFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "cg-rt-"));
  const session = `test-${randomUUID().slice(0, 8)}`,
    socketPath = join(dir, "hc.sock");
  const env = {
    ...process.env,
    HC_SESSION: session,
    HC_SOCKET: socketPath,
    XDG_STATE_HOME: join(dir, "state"),
    XDG_CONFIG_HOME: join(dir, "config"),
  };
  const command = async (args: string[]) =>
    JSON.parse(
      (await exec(binary, [...args, "--json"], { env, timeout: 10000 })).stdout,
    );
  const runtime = value(
    await HerdrRuntime.create({ binary, session, socketPath, env }),
  );
  const program = join(dir, "agent.cjs");
  await writeFile(program, fakeAgent);
  return {
    runtime,
    launch: { ...launch, command: process.execPath, args: [program], cwd: dir },
    inspect: (r) => command(["get", r.terminal_ref]),
    cleanup: async () => {
      try {
        if (
          await stat(socketPath).then(
            (s) => s.isSocket(),
            () => false,
          )
        ) {
          const listing = await command(["ls", "--all"]);
          for (const t of listing.terminals)
            value(
              await runtime.release(
                { ...ref, terminal_ref: t.address },
                { force: true },
              ),
            );
          expect((await command(["ls", "--all"])).terminals).toEqual([]);
          await command(["server", "stop"]);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
async function awaitAgent(
  runtime: ObservableRuntime,
  r: RuntimeRef,
  expected: string,
) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const status = value(await runtime.status(r));
    if (status.agent === expected) return status;
    if (Date.now() >= deadline)
      throw new Error(`Agent remained ${status.agent}, expected ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
for (const kind of ["memory", "hc"] as const) {
  describe.skipIf(kind === "hc" && Boolean(skipReason))(
    `Runtime shared contract: ${kind}`,
    () => {
      let fixture: Fixture, r: RuntimeRef;
      beforeEach(async () => {
        fixture =
          kind === "memory"
            ? {
                runtime: new MemoryRuntime(),
                launch,
                cleanup: async () => undefined,
              }
            : await realFixture();
        r = value(
          await fixture.runtime.provision(
            assignment,
            role,
            machine,
            fixture.launch,
          ),
        );
        await awaitAgent(fixture.runtime, r, "idle");
      }, 15000);
      afterEach(async () => {
        await fixture?.cleanup();
      }, 15000);
      test("provision, conditional wake, OSC working/blocked/idle and interrupt preserve runtime facts", async () => {
        const initial = value(await fixture.runtime.status(r));
        expect(initial).toMatchObject({ process: "alive", agent: "idle" });
        expect(
          await fixture.runtime.wake(r, "working", { if_idle: true }),
        ).toEqual(success({ sent: true }));
        const working = await awaitAgent(fixture.runtime, r, "working");
        expect(working.observed_seq).toBeGreaterThan(initial.observed_seq);
        expect(
          await fixture.runtime.wake(r, "idle", { if_idle: true }),
        ).toMatchObject({ ok: false, error: { code: "runtime_conflict" } });
        value(await fixture.runtime.wake(r, "blocked"));
        await awaitAgent(fixture.runtime, r, "blocked");
        expect(
          await fixture.runtime.release(r, { force: false }),
        ).toMatchObject({ ok: false, error: { code: "runtime_conflict" } });
        value(await fixture.runtime.interrupt(r));
        await awaitAgent(fixture.runtime, r, "idle");
        if (fixture.inspect)
          expect(await fixture.inspect(r)).toMatchObject({
            name: launch.agent_name,
            labels: launch.labels,
            cwd: fixture.launch.cwd,
          });
      }, 20000);
      test("events provide a snapshot and increasing runtime sequences; cancellation stops the subscription", async () => {
        const controller = new AbortController();
        const events = fixture.runtime
          .events(r, controller.signal)
          [Symbol.asyncIterator]();
        try {
          const first = await nextEvent(events);
          expect(first.observations[0]?.status.agent).toBe("idle");
          value(await fixture.runtime.wake(r, "working"));
          let previous = first.seq;
          for (;;) {
            const event = await nextEvent(events);
            expect(event.seq).toBeGreaterThan(previous);
            previous = event.seq;
            if (event.type === "status") break;
          }
        } finally {
          controller.abort();
          await events.return?.();
        }
      }, 20000);
      test("replacement keeps the responsibility reference; human entry and release use the resulting terminal", async () => {
        const replacement = value(
          await fixture.runtime.resume_or_replace(r, fixture.launch),
        );
        expect(replacement.terminal_ref).not.toBe(r.terminal_ref);
        expect(await fixture.runtime.status(r)).toMatchObject({
          ok: false,
          error: { code: "runtime_not_found" },
        });
        await awaitAgent(fixture.runtime, replacement, "idle");
        const entry = value(await fixture.runtime.human_entry(replacement));
        expect(entry).toContain("attach");
        expect(entry).toContain(replacement.terminal_ref);
        value(await fixture.runtime.release(replacement, { force: true }));
        expect(
          await fixture.runtime.wake(replacement, "working"),
        ).toMatchObject({ ok: false, error: { code: "runtime_not_found" } });
      }, 20000);
    },
  );
}
