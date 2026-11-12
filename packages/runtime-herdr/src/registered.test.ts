import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ExecutionConfig } from "./execution.js";
import {
  readRegisteredRuntime,
  runtimeDifferences,
  runtimeOwnsRef,
  writeRegisteredRuntime,
} from "./registered.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-registered-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const agent: ExecutionConfig = {
  mode: "agent-ssh",
  dataDir: "/data",
  agentRoot: "/srv/agent",
  gid: 900,
  machine: "cardigan-agent",
  identityFile: "/keys/id",
  knownHostsFile: "/keys/known_hosts",
  agentNice: 5,
};

test("the registration round-trips without the data directory or priority, privately", async () => {
  expect(await readRegisteredRuntime(dir)).toBeUndefined();
  await writeRegisteredRuntime(dir, agent);
  expect((await stat(join(dir, "runtime.json"))).mode & 0o777).toBe(0o600);
  const read = await readRegisteredRuntime(dir);
  expect(read).toEqual({
    mode: "agent-ssh",
    agentRoot: "/srv/agent",
    gid: 900,
    machine: "cardigan-agent",
    identityFile: "/keys/id",
    knownHostsFile: "/keys/known_hosts",
  });
  if (!read) throw new Error("missing");
  expect(runtimeDifferences(read, { ...agent, dataDir: "/other" })).toEqual([]);
  await writeRegisteredRuntime(dir, { mode: "local", dataDir: dir });
  expect(await readRegisteredRuntime(dir)).toEqual({ mode: "local" });
});

test("differences name the environment variable and both values", () => {
  expect(
    runtimeDifferences(
      {
        mode: "agent-ssh",
        machine: "cardigan-agent",
        agentRoot: "/srv/agent",
        gid: 900,
        identityFile: "/keys/id",
        knownHostsFile: "/keys/known_hosts",
      },
      { mode: "local", dataDir: "/data" },
    ),
  ).toEqual(
    expect.arrayContaining([
      "CARDIGAN_RUNTIME_MODE：server 登记为 agent-ssh，当前 shell 为 local",
      "CARDIGAN_AGENT_MACHINE：server 登记为 cardigan-agent，当前 shell 为 （未设置）",
    ]),
  );
});

test("malformed registrations are rejected instead of treated as local", async () => {
  await writeFile(join(dir, "runtime.json"), '{"mode":"agent-ssh"}');
  await expect(readRegisteredRuntime(dir)).rejects.toThrow(/is missing/);
  await writeFile(join(dir, "runtime.json"), '{"mode":"remote"}');
  await expect(readRegisteredRuntime(dir)).rejects.toThrow(/mode must be/);
});

test("a terminal belongs to the runtime only on the same hc machine", () => {
  const local = { machine_id: "local", runtime_machine: "local" } as const;
  const remote = {
    machine_id: "local",
    runtime_machine: "cardigan-agent",
  } as const;
  expect(runtimeOwnsRef(agent, local)).toBe(false);
  expect(runtimeOwnsRef(agent, remote)).toBe(true);
  expect(runtimeOwnsRef({ mode: "local" }, local)).toBe(true);
  expect(runtimeOwnsRef({ mode: "local" }, remote)).toBe(false);
});
