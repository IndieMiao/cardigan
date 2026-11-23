import { DEFAULT_CHECK_CLEANUP_GRACE_MS } from "@cardigan/git-service";
import { expect, test } from "vitest";
import {
  DEFAULT_INTERVALS,
  DEFAULT_MCP_HOST,
  DEFAULT_MCP_PORT,
  LOCAL_ONLY_HINT,
  resolveServerConfig,
} from "./config.js";

test("dispatcher interval is optional, defaults in the loop to 1000ms and accepts positive milliseconds", () => {
  expect(
    resolveServerConfig({ CARDIGAN_DISPATCH_INTERVAL_MS: "2500" })
      .dispatchIntervalMs,
  ).toBe(2500);
  expect(
    resolveServerConfig({ CARDIGAN_DISPATCH_INTERVAL_MS: " " })
      .dispatchIntervalMs,
  ).toBeUndefined();
  for (const value of ["0", "-1", "1.5", "NaN", "2147483648"])
    expect(() =>
      resolveServerConfig({ CARDIGAN_DISPATCH_INTERVAL_MS: value }),
    ).toThrow("CARDIGAN_DISPATCH_INTERVAL_MS");
});

test("S10 defaults to loopback, port 3004 and the same user data directory as the CLI", () => {
  expect(resolveServerConfig({ HOME: "/fixture/home" })).toEqual({
    mcpSessionCheck: true,
    dataDir: "/fixture/home/.local/share/cardigan",
    execution: {
      mode: "local",
      dataDir: "/fixture/home/.local/share/cardigan",
    },
    host: DEFAULT_MCP_HOST,
    port: DEFAULT_MCP_PORT,
    launchReloadIntervalMs: 1000,
    listenRetryIntervalMs: 1_000,
    listenRetryTimeoutMs: 30_000,
    mergeIntervalMs: DEFAULT_INTERVALS.merge,
    mergeWatchdogMs: 300_000,
    recoveryInspectionIntervalMs: 300_000,
    cleanupIntervalMs: DEFAULT_INTERVALS.cleanup,
    reconcileIntervalMs: DEFAULT_INTERVALS.reconcile,
    runtimeUnknownGraceMs: 60_000,
    checkCleanupGraceMs: DEFAULT_CHECK_CLEANUP_GRACE_MS,
    backupIntervalMs: DEFAULT_INTERVALS.backup,
    attachmentIntervalMs: DEFAULT_INTERVALS.attachment,
    dispatchTimeoutMs: 600_000,
    providerFailureThreshold: 2,
    providerCooldownMs: 300_000,
    hostOpsPatrolIntervalMs: 1_800_000,
    contextUsageStaleAfterMs: 600_000,
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
      CARDIGAN_PROVIDER_FAILURE_THRESHOLD: "3",
      CARDIGAN_PROVIDER_COOLDOWN_MS: "1000",
    }),
  ).toEqual({
    mcpSessionCheck: true,
    dataDir: "/srv/cardigan/data",
    execution: { mode: "local", dataDir: "/srv/cardigan/data" },
    host: DEFAULT_MCP_HOST,
    port: 0,
    launchReloadIntervalMs: 1000,
    listenRetryIntervalMs: 1_000,
    listenRetryTimeoutMs: 30_000,
    mergeIntervalMs: DEFAULT_INTERVALS.merge,
    mergeWatchdogMs: 300_000,
    recoveryInspectionIntervalMs: 300_000,
    cleanupIntervalMs: DEFAULT_INTERVALS.cleanup,
    reconcileIntervalMs: DEFAULT_INTERVALS.reconcile,
    runtimeUnknownGraceMs: 60_000,
    checkCleanupGraceMs: DEFAULT_CHECK_CLEANUP_GRACE_MS,
    backupIntervalMs: DEFAULT_INTERVALS.backup,
    attachmentIntervalMs: DEFAULT_INTERVALS.attachment,
    dispatchTimeoutMs: 600_000,
    providerFailureThreshold: 3,
    providerCooldownMs: 1000,
    hostOpsPatrolIntervalMs: 1_800_000,
    contextUsageStaleAfterMs: 600_000,
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

test("listen retries accept configurable positive millisecond values", () => {
  expect(
    resolveServerConfig({
      CARDIGAN_LISTEN_RETRY_INTERVAL_MS: "25",
      CARDIGAN_LISTEN_RETRY_TIMEOUT_MS: "120",
    }),
  ).toMatchObject({ listenRetryIntervalMs: 25, listenRetryTimeoutMs: 120 });
  for (const name of [
    "CARDIGAN_LISTEN_RETRY_INTERVAL_MS",
    "CARDIGAN_LISTEN_RETRY_TIMEOUT_MS",
  ]) {
    expect(resolveServerConfig({ [name]: " " })).toMatchObject({
      listenRetryIntervalMs: 1_000,
      listenRetryTimeoutMs: 30_000,
    });
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "2147483648"])
      expect(() => resolveServerConfig({ [name]: value })).toThrow(name);
  }
});

test("context usage config defaults to ten minutes and accepts a host-selected cache directory", () => {
  expect(resolveServerConfig({})).toMatchObject({
    contextUsageStaleAfterMs: 600_000,
  });
  expect(resolveServerConfig({}).contextUsageCacheDir).toBeUndefined();
  expect(
    resolveServerConfig({
      CARDIGAN_CONTEXT_USAGE_STALE_AFTER_MS: " ",
      CARDIGAN_CONTEXT_USAGE_CACHE_DIR: " ",
    }),
  ).toMatchObject({ contextUsageStaleAfterMs: 600_000 });
  expect(
    resolveServerConfig({ CARDIGAN_CONTEXT_USAGE_CACHE_DIR: " " })
      .contextUsageCacheDir,
  ).toBeUndefined();
  expect(
    resolveServerConfig({
      CARDIGAN_CONTEXT_USAGE_STALE_AFTER_MS: " 120000 ",
      CARDIGAN_CONTEXT_USAGE_CACHE_DIR: " /fixture/context-cache ",
    }),
  ).toMatchObject({
    contextUsageStaleAfterMs: 120_000,
    contextUsageCacheDir: "/fixture/context-cache",
  });
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "2147483648"])
    expect(() =>
      resolveServerConfig({ CARDIGAN_CONTEXT_USAGE_STALE_AFTER_MS: value }),
    ).toThrow("CARDIGAN_CONTEXT_USAGE_STALE_AFTER_MS");
});

test("C-219 runtime failure limit is configurable and rejects invalid counts", () => {
  expect(
    resolveServerConfig({ CARDIGAN_RUNTIME_FAILURE_LIMIT: "5" })
      .runtimeFailureLimit,
  ).toBe(5);
  expect(resolveServerConfig({}).runtimeFailureLimit).toBeUndefined();
  for (const value of [
    "0",
    "1",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "9007199254740992",
    // C-228 / Q-387: capped at 10 so a silent failure is always confirmed.
    "11",
    "1000",
  ])
    expect(() =>
      resolveServerConfig({ CARDIGAN_RUNTIME_FAILURE_LIMIT: value }),
    ).toThrow("CARDIGAN_RUNTIME_FAILURE_LIMIT");
  for (const value of ["2", "10"])
    expect(
      resolveServerConfig({ CARDIGAN_RUNTIME_FAILURE_LIMIT: value })
        .runtimeFailureLimit,
    ).toBe(Number(value));
});

test("C-228 runtime unknown grace defaults to Q-387's 60 s and refuses invalid values", () => {
  expect(resolveServerConfig({}).runtimeUnknownGraceMs).toBe(60_000);
  expect(
    resolveServerConfig({ CARDIGAN_RUNTIME_UNKNOWN_GRACE_SECONDS: "90" })
      .runtimeUnknownGraceMs,
  ).toBe(90_000);
  for (const value of ["0", "-1", "1.5", "60s", "NaN", "300", "3600"])
    expect(() =>
      resolveServerConfig({ CARDIGAN_RUNTIME_UNKNOWN_GRACE_SECONDS: value }),
    ).toThrow("CARDIGAN_RUNTIME_UNKNOWN_GRACE_SECONDS");
});

test("check-log byte limits are host-configured and preserve the approved defaults", () => {
  expect(resolveServerConfig({}).checkLogLimits).toBeUndefined();
  expect(
    resolveServerConfig({ CARDIGAN_CHECK_LOG_READ_BYTES: "1024" })
      .checkLogLimits,
  ).toEqual({ per_read_bytes: 1024, per_assignment_attempt_bytes: 1048576 });
  expect(
    resolveServerConfig({ CARDIGAN_CHECK_LOG_ATTEMPT_BYTES: "4096" })
      .checkLogLimits,
  ).toEqual({ per_read_bytes: 65536, per_assignment_attempt_bytes: 4096 });
  for (const key of [
    "CARDIGAN_CHECK_LOG_READ_BYTES",
    "CARDIGAN_CHECK_LOG_ATTEMPT_BYTES",
  ])
    for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992"])
      expect(() => resolveServerConfig({ [key]: value })).toThrow(key);
});

test("Q-618 recovery inspection defaults to five minutes and accepts only bounded positive milliseconds", () => {
  expect(resolveServerConfig({}).recoveryInspectionIntervalMs).toBe(300_000);
  expect(
    resolveServerConfig({
      CARDIGAN_CHECK_RECOVERY_INSPECTION_INTERVAL_MS: "60000",
    }).recoveryInspectionIntervalMs,
  ).toBe(60_000);
  for (const value of ["0", "-1", "1.5", "NaN", "2147483648"])
    expect(() =>
      resolveServerConfig({
        CARDIGAN_CHECK_RECOVERY_INSPECTION_INTERVAL_MS: value,
      }),
    ).toThrow("CARDIGAN_CHECK_RECOVERY_INSPECTION_INTERVAL_MS");
});

test("C-389: attachment inline threshold is bounded trusted host configuration", () => {
  expect(resolveServerConfig({}).attachmentInlineBytes).toBeUndefined();
  for (const value of [0, 1, 65536, 1048576]) {
    expect(
      resolveServerConfig({ CARDIGAN_ATTACHMENT_INLINE_BYTES: String(value) })
        .attachmentInlineBytes,
    ).toBe(value);
  }
  for (const value of ["-1", "1.5", "NaN", "Infinity", "1048577"]) {
    expect(() =>
      resolveServerConfig({ CARDIGAN_ATTACHMENT_INLINE_BYTES: value }),
    ).toThrow("CARDIGAN_ATTACHMENT_INLINE_BYTES");
  }
});

test("C-405: merge blocker reminder accepts a positive host duration and defaults in the domain", () => {
  expect(resolveServerConfig({}).mergeBlockedReminderMs).toBeUndefined();
  expect(
    resolveServerConfig({ CARDIGAN_MERGE_BLOCKED_REMINDER_MS: "60000" })
      .mergeBlockedReminderMs,
  ).toBe(60000);
  for (const value of ["0", "-1", "NaN", "1.5"])
    expect(() =>
      resolveServerConfig({ CARDIGAN_MERGE_BLOCKED_REMINDER_MS: value }),
    ).toThrow("CARDIGAN_MERGE_BLOCKED_REMINDER_MS");
});

test("C-466: watchdog duration is host-configurable and rejects overflowing timers", () => {
  expect(
    resolveServerConfig({ CARDIGAN_MERGE_WATCHDOG_MS: "120000" })
      .mergeWatchdogMs,
  ).toBe(120_000);
  for (const value of ["0", "-1", "2147483648"])
    expect(() =>
      resolveServerConfig({ CARDIGAN_MERGE_WATCHDOG_MS: value }),
    ).toThrow("CARDIGAN_MERGE_WATCHDOG_MS");
});

test("framework dependency reminder accepts a positive host duration", () => {
  expect(resolveServerConfig({}).frameworkWaitReminderMs).toBeUndefined();
  expect(
    resolveServerConfig({ CARDIGAN_FRAMEWORK_WAIT_REMINDER_MS: "60000" })
      .frameworkWaitReminderMs,
  ).toBe(60000);
  for (const value of ["0", "-1", "1.5", "Infinity"])
    expect(() =>
      resolveServerConfig({ CARDIGAN_FRAMEWORK_WAIT_REMINDER_MS: value }),
    ).toThrow("CARDIGAN_FRAMEWORK_WAIT_REMINDER_MS");
});

test("worker inspection cadence accepts only a positive deployment interval", () => {
  expect(
    resolveServerConfig({ CARDIGAN_WORKER_INSPECTION_INTERVAL_MS: "30000" })
      .workerInspectionIntervalMs,
  ).toBe(30000);
  expect(() =>
    resolveServerConfig({ CARDIGAN_WORKER_INSPECTION_INTERVAL_MS: "0" }),
  ).toThrow("positive");
});

test("C-600 the MCP session check is on unless explicitly turned off", () => {
  expect(resolveServerConfig({}).mcpSessionCheck).toBe(true);
  expect(
    resolveServerConfig({ CARDIGAN_MCP_SESSION_CHECK: "1" }).mcpSessionCheck,
  ).toBe(true);
  expect(
    resolveServerConfig({ CARDIGAN_MCP_SESSION_CHECK: "0" }).mcpSessionCheck,
  ).toBe(false);
  for (const value of ["off", "true", "2"])
    expect(() =>
      resolveServerConfig({ CARDIGAN_MCP_SESSION_CHECK: value }),
    ).toThrow("CARDIGAN_MCP_SESSION_CHECK");
});

test("C-600 the MCP handshake deadline is a positive millisecond setting", () => {
  expect(resolveServerConfig({}).mcpHandshakeTimeoutMs).toBeUndefined();
  expect(
    resolveServerConfig({ CARDIGAN_MCP_HANDSHAKE_TIMEOUT_MS: "90000" })
      .mcpHandshakeTimeoutMs,
  ).toBe(90000);
  for (const value of ["0", "-1", "1.5", "soon"])
    expect(() =>
      resolveServerConfig({ CARDIGAN_MCP_HANDSHAKE_TIMEOUT_MS: value }),
    ).toThrow("CARDIGAN_MCP_HANDSHAKE_TIMEOUT_MS");
});

test("C-632: request_check busy-lock retry is host-configured with defaults", () => {
  expect(resolveServerConfig({}).checkHeadRetry).toBeUndefined();
  expect(
    resolveServerConfig({ CARDIGAN_CHECK_HEAD_RETRY_TOTAL_MS: "60000" })
      .checkHeadRetry,
  ).toEqual({ attempts: 3, totalMs: 60000, backoffMs: 1000 });
  expect(
    resolveServerConfig({
      CARDIGAN_CHECK_HEAD_RETRY_ATTEMPTS: "5",
      CARDIGAN_CHECK_HEAD_RETRY_BACKOFF_MS: "500",
    }).checkHeadRetry,
  ).toEqual({ attempts: 5, totalMs: 90000, backoffMs: 500 });
  for (const value of ["0", "11", "1.5", "many"])
    expect(() =>
      resolveServerConfig({ CARDIGAN_CHECK_HEAD_RETRY_ATTEMPTS: value }),
    ).toThrow("CARDIGAN_CHECK_HEAD_RETRY_ATTEMPTS");
  for (const key of [
    "CARDIGAN_CHECK_HEAD_RETRY_TOTAL_MS",
    "CARDIGAN_CHECK_HEAD_RETRY_BACKOFF_MS",
  ])
    for (const value of ["0", "-1", "1.5", "soon"])
      expect(() => resolveServerConfig({ [key]: value })).toThrow(key);
});
