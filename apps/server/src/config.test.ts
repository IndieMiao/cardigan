import { expect, test } from "vitest";
import {
  DEFAULT_INTERVALS,
  DEFAULT_MCP_HOST,
  DEFAULT_MCP_PORT,
  LOCAL_ONLY_HINT,
  resolveServerConfig,
} from "./config.js";

test("defaults to the loopback address, port 3004 and .data", () => {
  expect(resolveServerConfig({})).toEqual({
    dataDir: ".data",
    execution: { mode: "local", dataDir: resolve(".data") },
    host: DEFAULT_MCP_HOST,
    port: DEFAULT_MCP_PORT,
    mergeIntervalMs: DEFAULT_INTERVALS.merge,
    cleanupIntervalMs: DEFAULT_INTERVALS.cleanup,
    reconcileIntervalMs: DEFAULT_INTERVALS.reconcile,
    backupIntervalMs: DEFAULT_INTERVALS.backup,
  });
});

test("accepts loopback hosts", () => {
  for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) {
    expect(resolveServerConfig({ CARDIGAN_MCP_HOST: host }).host).toBe(
      host.toLowerCase(),
    );
  }
});

test("refuses to listen on every interface", () => {
  for (const host of ["0.0.0.0", "::", "*"]) {
    expect(() => resolveServerConfig({ CARDIGAN_MCP_HOST: host })).toThrow(
      LOCAL_ONLY_HINT,
    );
  }
});

test("refuses LAN and public addresses", () => {
  for (const host of [
    "192.168.1.10",
    "10.0.0.5",
    "172.16.31.2",
    "example.com",
  ]) {
    expect(() => resolveServerConfig({ CARDIGAN_MCP_HOST: host })).toThrow(
      /M1 只支持本机监听/,
    );
  }
});

test("the refusal names the rejected value and the phase", () => {
  try {
    resolveServerConfig({ CARDIGAN_MCP_HOST: "0.0.0.0" });
    expect.unreachable("should have thrown");
  } catch (error) {
    const message = (error as Error).message;
    expect(message).toContain('"0.0.0.0"');
    expect(message).toContain("127.0.0.1");
    expect(message).toContain("Phase 2");
  }
});

test("an empty host falls back to the default", () => {
  expect(resolveServerConfig({ CARDIGAN_MCP_HOST: "  " }).host).toBe(
    DEFAULT_MCP_HOST,
  );
});

test("reads data dir and port from the environment", () => {
  expect(
    resolveServerConfig({
      CARDIGAN_DATA_DIR: "/srv/cardigan/data",
      CARDIGAN_MCP_PORT: "0",
    }),
  ).toEqual({
    dataDir: "/srv/cardigan/data",
    execution: { mode: "local", dataDir: "/srv/cardigan/data" },
    host: DEFAULT_MCP_HOST,
    port: 0,
    mergeIntervalMs: DEFAULT_INTERVALS.merge,
    cleanupIntervalMs: DEFAULT_INTERVALS.cleanup,
    reconcileIntervalMs: DEFAULT_INTERVALS.reconcile,
    backupIntervalMs: DEFAULT_INTERVALS.backup,
  });
});

test("rejects an invalid port", () => {
  for (const port of ["abc", "-1", "70000", "1.5"]) {
    expect(() => resolveServerConfig({ CARDIGAN_MCP_PORT: port })).toThrow(
      /CARDIGAN_MCP_PORT/,
    );
  }
});

test("server parses agent-ssh settings and refuses unknown runtime modes", () => {
  expect(
    resolveServerConfig({
      CARDIGAN_RUNTIME_MODE: "agent-ssh",
      CARDIGAN_DATA_DIR: "/fixture/private",
      CARDIGAN_AGENT_ROOT: "/fixture/agent",
      CARDIGAN_AGENT_GID: "2001",
      CARDIGAN_AGENT_IDENTITY: "/fixture/key",
      CARDIGAN_AGENT_KNOWN_HOSTS: "/fixture/known_hosts",
    }).execution,
  ).toMatchObject({ mode: "agent-ssh", machine: "cardigan-agent" });
  expect(() =>
    resolveServerConfig({ CARDIGAN_RUNTIME_MODE: "remote" }),
  ).toThrow(/local or agent-ssh/);
});

import { resolve } from "node:path";
