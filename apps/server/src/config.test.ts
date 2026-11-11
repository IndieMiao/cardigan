import { DEFAULT_CHECK_CLEANUP_GRACE_MS } from "@cardigan/git-service";
import { expect, test } from "vitest";
import {
  DEFAULT_INTERVALS,
  DEFAULT_MCP_HOST,
  DEFAULT_MCP_PORT,
  LOCAL_ONLY_HINT,
  resolveServerConfig,
} from "./config.js";

test("S10 defaults to loopback, port 3004 and the same user data directory as the CLI", () => {
  expect(resolveServerConfig({ HOME: "/fixture/home" })).toEqual({
    dataDir: "/fixture/home/.local/share/cardigan",
    execution: {
      mode: "local",
      dataDir: "/fixture/home/.local/share/cardigan",
    },
    host: DEFAULT_MCP_HOST,
    port: DEFAULT_MCP_PORT,
    mergeIntervalMs: DEFAULT_INTERVALS.merge,
    cleanupIntervalMs: DEFAULT_INTERVALS.cleanup,
    reconcileIntervalMs: DEFAULT_INTERVALS.reconcile,
    checkCleanupGraceMs: DEFAULT_CHECK_CLEANUP_GRACE_MS,
    backupIntervalMs: DEFAULT_INTERVALS.backup,
    attachmentIntervalMs: DEFAULT_INTERVALS.attachment,
    dispatchTimeoutMs: 600_000,
    shutdownGraceMs: 10_000,
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
    checkCleanupGraceMs: DEFAULT_CHECK_CLEANUP_GRACE_MS,
    backupIntervalMs: DEFAULT_INTERVALS.backup,
    attachmentIntervalMs: DEFAULT_INTERVALS.attachment,
    dispatchTimeoutMs: 600_000,
    shutdownGraceMs: 10_000,
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

test("the attachment sweep defaults to six hours and can be overridden", () => {
  expect(
    resolveServerConfig({ HOME: "/fixture/home" }).attachmentIntervalMs,
  ).toBe(DEFAULT_INTERVALS.attachment);
  expect(
    resolveServerConfig({
      HOME: "/fixture/home",
      CARDIGAN_ATTACHMENT_GC_INTERVAL_MS: "900000",
    }).attachmentIntervalMs,
  ).toBe(900_000);
  expect(() =>
    resolveServerConfig({
      HOME: "/fixture/home",
      CARDIGAN_ATTACHMENT_GC_INTERVAL_MS: "0",
    }),
  ).toThrow(/CARDIGAN_ATTACHMENT_GC_INTERVAL_MS/);
});

test("check cleanup grace is configurable and rejects invalid durations", () => {
  expect(
    resolveServerConfig({ CARDIGAN_CHECK_CLEANUP_GRACE_MS: "1234" })
      .checkCleanupGraceMs,
  ).toBe(1234);
  for (const value of ["0", "-1", "1.5", "NaN", "2147483648"])
    expect(() =>
      resolveServerConfig({ CARDIGAN_CHECK_CLEANUP_GRACE_MS: value }),
    ).toThrow(/CARDIGAN_CHECK_CLEANUP_GRACE_MS/);
});

test("the shutdown grace period defaults to 10 seconds and is configurable", () => {
  expect(resolveServerConfig({ HOME: "/fixture/home" }).shutdownGraceMs).toBe(
    10_000,
  );
  expect(
    resolveServerConfig({ CARDIGAN_SHUTDOWN_GRACE_MS: "2500" }).shutdownGraceMs,
  ).toBe(2500);
  for (const value of ["0", "-1", "1.5", "abc"])
    expect(() =>
      resolveServerConfig({ CARDIGAN_SHUTDOWN_GRACE_MS: value }),
    ).toThrow(/CARDIGAN_SHUTDOWN_GRACE_MS/);
});
