import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { processClient } from "./client.js";
import { HerdrRuntime } from "./index.js";
import { ref, value } from "./test-support.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type Message = { id: number; method: string; params: Record<string, unknown> };
async function fixture(onCall: (m: Message, s: Socket) => void) {
  const dir = await mkdtemp(join(tmpdir(), "hc-rpc-"));
  const path = join(dir, "core.sock"),
    sockets = new Set<Socket>();
  const calls: Message[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const m = JSON.parse(buffer.slice(0, end)) as Message;
        buffer = buffer.slice(end + 1);
        calls.push(m);
        onCall(m, socket);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    path,
    calls,
    sockets,
    client: processClient("/missing-fixture-hc", {}, path, 500, true),
  };
}
const reply = (s: Socket, id: number, result: unknown) =>
  s.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const hello = (s: Socket, overrides = {}) =>
  reply(s, 1, {
    generation: 1,
    version: "0.1.18",
    framed: false,
    methods: ["terminal.get", "machine.list", "events.subscribe"],
    ...overrides,
  });

test("read-only RPC preserves literal addresses, fragments and CLI JSON shape without a binary", async () => {
  const f = await fixture((m, s) => {
    if (m.method === "hello") {
      hello(s);
      return;
    }
    const result =
      m.method === "machine.list"
        ? { machines: [] }
        : { address: m.params.terminal, state: "live" };
    const encoded = JSON.stringify({ jsonrpc: "2.0", id: 2, result });
    s.write(encoded.slice(0, 9));
    s.write(`${encoded.slice(9)}\n`);
  });
  expect(
    JSON.parse(await f.client.exec(["get", "worker/t7", "--json"])),
  ).toEqual({ address: "worker/t7", state: "live" });
  expect(JSON.parse(await f.client.exec(["machine", "ls", "--json"]))).toEqual({
    machines: [],
  });
  expect(f.calls.map((m) => m.method)).toEqual([
    "hello",
    "terminal.get",
    "hello",
    "machine.list",
  ]);
});

test.each([
  ["not_found", "runtime_not_found"],
  ["finished", "runtime_conflict"],
  ["status_mismatch", "runtime_conflict"],
  ["invalid_params", "invalid_launch"],
  ["unavailable", "runtime_unavailable"],
])(
  "RPC %s uses the existing error mapping, without server text or retries",
  async (kind, code) => {
    const f = await fixture((m, s) => {
      if (m.method === "hello") {
        hello(s);
        return;
      }
      s.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Bearer secret", data: { kind } } })}\n`,
      );
    });
    await expect(f.client.exec(["get", "t7", "--json"])).rejects.toMatchObject({
      code,
    });
    await f.client
      .exec(["get", "t7", "--json"])
      .catch((e: Error) => expect(e.message).not.toContain("secret"));
    expect(f.calls.filter((m) => m.method === "terminal.get")).toHaveLength(2);
  },
);

test.each([
  { generation: 2 },
  { version: "0.1.19" },
  { framed: true },
  { methods: [] },
])(
  "unknown protocol identity %j refuses before any operation",
  async (overrides) => {
    const f = await fixture((_m, s) => hello(s, overrides));
    await expect(f.client.exec(["get", "t7", "--json"])).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
    expect(f.calls).toHaveLength(1);
  },
);

test.each(["wrong-id", "invalid-json", "disconnect", "partial-json"])(
  "%s fails closed without CLI fallback or replay",
  async (mode) => {
    const f = await fixture((m, s) => {
      if (m.method === "hello") {
        hello(s);
        return;
      }
      if (mode === "wrong-id") reply(s, 9, {});
      if (mode === "invalid-json") s.write("broken\n");
      if (mode === "partial-json") s.end('{"jsonrpc":');
      if (mode === "disconnect") s.end();
    });
    await expect(f.client.exec(["get", "t7", "--json"])).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
    expect(f.calls).toHaveLength(2);
  },
);

test("RPC timeout keeps the existing category and closes the exact connection", async () => {
  const f = await fixture((m, s) => {
    if (m.method === "hello") hello(s);
  });
  await expect(
    f.client.exec(["get", "t7", "--json"], 20),
  ).rejects.toMatchObject({ code: "runtime_timeout" });
  expect(f.calls.filter((m) => m.method === "terminal.get")).toHaveLength(1);
});

test("events deliver a new snapshot then ordered notifications; abort/reconnect never replay the old source", async () => {
  let seq = 3;
  const f = await fixture((m, s) => {
    if (m.method === "hello") {
      hello(s);
      return;
    }
    reply(s, 2, { seq: seq++, terminals: [] });
    s.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq: seq++, type: "created", terminal: "t7" } })}\n`,
    );
    s.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "missed", params: { seq: seq++, terminals: [] } })}\n`,
    );
    s.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq: seq - 2, type: "created", terminal: "old" } })}\n`,
    );
    s.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "heartbeat", params: { seq: seq - 1 } })}\n`,
    );
  });
  const controller = new AbortController(),
    stream = f.client
      .lines(["events", "--json"], controller.signal)
      [Symbol.asyncIterator]();
  expect(JSON.parse((await stream.next()).value as string)).toMatchObject({
    type: "snapshot",
    seq: 3,
  });
  expect(JSON.parse((await stream.next()).value as string)).toMatchObject({
    method: "event",
    params: { seq: 4 },
  });
  expect(JSON.parse((await stream.next()).value as string)).toMatchObject({
    method: "missed",
    params: { seq: 5 },
  });
  expect(JSON.parse((await stream.next()).value as string)).toMatchObject({
    method: "heartbeat",
    params: { seq: 5 },
  });
  const pending = stream.next();
  controller.abort();
  expect(await pending).toMatchObject({ done: true });
  const next = f.client.lines(["events", "--json"])[Symbol.asyncIterator]();
  expect(JSON.parse((await next.next()).value as string)).toMatchObject({
    type: "snapshot",
    seq: 6,
  });
  await next.return?.();
});

test("runtime status uses native socket snapshots and retains launch generation checks", async () => {
  let generation = "a".repeat(32),
    seq = 1;
  const f = await fixture((m, s) => {
    if (m.method === "hello") {
      hello(s);
      return;
    }
    const terminal = {
      address: ref.terminal_ref,
      name: ref.agent_name,
      state: "live",
      labels: { run: "R-1", generation },
      status: { state: "idle" },
    };
    reply(
      s,
      2,
      m.method === "terminal.get"
        ? terminal
        : { seq: seq++, terminals: [terminal] },
    );
  });
  const runtime = value(
    await HerdrRuntime.create({
      client: {
        ...f.client,
        exec: (args, ms) =>
          args[0] === "--version"
            ? Promise.resolve("hc 0.1.18")
            : f.client.exec(args, ms),
      },
    }),
  );
  const bound = {
    ...ref,
    launch_generation: { run_id: "R-1" as never, generation },
  };
  expect(await runtime.status(bound)).toMatchObject({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  });
  generation = "b".repeat(32);
  expect(await runtime.status(bound)).toMatchObject({
    ok: false,
    error: { code: "invalid_launch" },
  });
  expect(f.calls.filter((m) => m.method === "events.subscribe")).toHaveLength(
    1,
  );
});
