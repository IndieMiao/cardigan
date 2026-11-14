import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { type HcClient, processClient, result } from "./client.js";
import { HerdrRuntime } from "./index.js";
import {
  assignment,
  launch,
  machine,
  ref,
  role,
  value,
} from "./test-support.js";

const directories: string[] = [];
const target = {
  project_id: "fixture",
  machine_id: "local",
  session: "fixture",
  generation: "one",
  fingerprint: "fixture-binding",
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
function stub(): HcClient {
  return {
    available: async () => true,
    exec: vi.fn(async (args: readonly string[]) =>
      args[0] === "--version"
        ? "hc 0.1.21"
        : JSON.stringify({
            address: "t1",
            state: "live",
            status: { state: "idle" },
          }),
    ),
    async *lines() {
      yield JSON.stringify({
        seq: 7,
        terminals: [
          { address: "t1", state: "live", status: { state: "idle" } },
        ],
      });
    },
  };
}
test.each(["0.1.18", "0.1.19", "0.1.20", "9.0.0"])(
  "version %s refuses initialization before provisioning",
  async (version) => {
    const client = stub();
    vi.mocked(client.exec).mockResolvedValue(`hc ${version}`);
    expect(await HerdrRuntime.create({ client })).toMatchObject({
      ok: false,
      error: { code: "version_mismatch" },
    });
    expect(client.exec).toHaveBeenCalledTimes(1);
  },
);
test("all hc run options precede the program; identity labels cannot be overridden", async () => {
  const client = stub();
  const runtime = value(
    await HerdrRuntime.create({ client, session: "isolated" }),
  );
  expect(
    await runtime.provision(assignment, role, machine, {
      ...launch,
      labels: { ...launch.labels, assignment: "forged" },
      args: ["--json", "literal;$(command)"],
    }),
  ).toMatchObject({ ok: true, value: ref });
  const args = vi.mocked(client.exec).mock.calls[1]?.[0] ?? [];
  expect(args.slice(args.indexOf("--"))).toEqual([
    "--",
    "node",
    "--json",
    "literal;$(command)",
  ]);
  expect(args).toContain("assignment=A-1");
  expect(args).toContain("cardigan=1");
  expect(args).not.toContain("assignment=forged");
  expect(await runtime.wake(ref, "--literal", { if_idle: true })).toEqual({
    ok: true,
    value: { sent: true },
  });
  expect(client.exec).toHaveBeenLastCalledWith([
    "send",
    "--json",
    "--if",
    "idle",
    "--",
    "t1",
    "--literal",
  ]);
});
test("an absent socket causes all probes to fail without invoking hc or starting a core", async () => {
  const client = stub();
  client.available = async () => false;
  const runtime = value(await HerdrRuntime.create({ client }));
  expect(await runtime.status(ref)).toMatchObject({
    ok: false,
    error: { code: "runtime_unavailable" },
  });
  expect(await runtime.events(ref).next()).toMatchObject({
    value: { ok: false, error: { code: "runtime_unavailable" } },
  });
  expect(client.exec).toHaveBeenCalledTimes(1);
});
test("bound local provisioning may start a missing core while probes stay read-only", async () => {
  const client = stub();
  client.available = async () => false;
  const runtime = value(
    await HerdrRuntime.create({
      client,
      session: target.session,
      execution: { mode: "local", dataDir: "/fixture", target },
    }),
  );
  const bound = value(
    await runtime.provision(assignment, role, machine, launch),
  );
  expect(bound.target).toEqual(target);
  expect(await runtime.status(bound)).toMatchObject({
    ok: false,
    error: { code: "runtime_unavailable" },
  });
  expect(await runtime.events(bound).next()).toMatchObject({
    value: { ok: false, error: { code: "runtime_unavailable" } },
  });
  expect(vi.mocked(client.exec).mock.calls.map(([args]) => args[0])).toEqual([
    "--version",
    "run",
  ]);
});
test.each([false, true])(
  "M5.6 replacement can recreate a missing core without probing it into existence (bound=%s)",
  async (bound) => {
    const client = stub();
    client.available = async () => false;
    const runtime = value(
      await HerdrRuntime.create({
        client,
        session: target.session,
        execution: {
          mode: "local",
          dataDir: "/fixture",
          ...(bound ? { target } : {}),
        },
      }),
    );
    const previous = {
      ...ref,
      agent_session_id: "obsolete",
      ...(bound ? { target } : {}),
    };
    const replaced = value(await runtime.resume_or_replace(previous, launch));
    expect(replaced).not.toHaveProperty("agent_session_id");
    const calls = vi.mocked(client.exec).mock.calls.map(([args]) => args);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(
      expect.arrayContaining(["run", "--keep", "--", launch.command]),
    );
    expect(
      calls.some((args) => ["get", "kill", "rm"].includes(args[0] ?? "")),
    ).toBe(false);
  },
);
test("M5.6 replacement refuses an uncertain release while a core socket still exists", async () => {
  const client = stub();
  const runtime = value(await HerdrRuntime.create({ client }));
  vi.mocked(client.exec).mockRejectedValue({
    code: "runtime_unavailable",
    message: "Cannot inspect live core",
  });
  expect(await runtime.resume_or_replace(ref, launch)).toMatchObject({
    ok: false,
  });
  expect(
    vi.mocked(client.exec).mock.calls.some(([args]) => args[0] === "run"),
  ).toBe(false);
});
test("status uses a runtime sequence, and malformed or ended event streams fail explicitly", async () => {
  const client = stub();
  const runtime = value(await HerdrRuntime.create({ client }));
  expect(await runtime.status(ref)).toEqual({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 7 },
  });
  for (const line of ["invalid json", JSON.stringify({ terminals: [] })]) {
    client.lines = async function* () {
      yield line;
    };
    expect(await runtime.status(ref)).toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable" },
    });
  }
});
test("launch validation rejects remote machines, wrong roles, absent labels and unsafe single-string commands", async () => {
  const client = stub();
  const runtime = value(await HerdrRuntime.create({ client }));
  for (const result of [
    await runtime.provision(
      { ...assignment, machine_id: "remote" },
      role,
      machine,
      launch,
    ),
    await runtime.provision(
      assignment,
      { ...role, version: 2 },
      machine,
      launch,
    ),
    await runtime.provision(assignment, role, machine, {
      ...launch,
      labels: {},
    }),
    await runtime.provision(assignment, role, machine, {
      ...launch,
      agent_name: "Invalid Name",
    }),
    await runtime.provision(assignment, role, machine, {
      ...launch,
      command: "echo dangerous;",
      args: [],
    }),
  ])
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_launch" },
    });
  expect(client.exec).toHaveBeenCalledTimes(1);
});
test.each([
  ["not_found", "runtime_not_found"],
  ["finished", "runtime_conflict"],
  ["status_mismatch", "runtime_conflict"],
  ["spawn_failed", "runtime_unavailable"],
  ["invalid_params", "invalid_launch"],
])("hc %s maps to %s", async (kind, code) => {
  const client = processClient(process.execPath, process.env, "/absent", 2000);
  expect(
    await result(() =>
      client.exec([
        "-e",
        `process.stderr.write(JSON.stringify({error:{kind:${JSON.stringify(kind)}}}));process.exit(3)`,
      ]),
    ),
  ).toMatchObject({ ok: false, error: { code } });
});
test("subprocesses time out; a cancelled subscription is reaped", async () => {
  const client = processClient(process.execPath, process.env, "/absent", 50);
  expect(
    await result(() => client.exec(["-e", "setInterval(()=>{},1000)"])),
  ).toMatchObject({ ok: false, error: { code: "runtime_timeout" } });
  const controller = new AbortController();
  const stream = client
    .lines(
      ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
      controller.signal,
    )
    [Symbol.asyncIterator]();
  const first = await stream.next();
  const pid = Number(first.value);
  controller.abort();
  await stream.next();
  expect(() => process.kill(pid, 0)).toThrow();
});
test("real socket guard does not launch the configured executable when the socket is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-client-"));
  directories.push(dir);
  const marker = join(dir, "called");
  const binary = join(dir, "hc");
  await writeFile(
    binary,
    `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('hc 0.1.21');else require('node:fs').writeFileSync(${JSON.stringify(marker)},'called');`,
    { mode: 0o700 },
  );
  const runtime = value(
    await HerdrRuntime.create({ binary, socketPath: join(dir, "absent.sock") }),
  );
  expect(await runtime.status(ref)).toMatchObject({
    ok: false,
    error: { code: "runtime_unavailable" },
  });
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
