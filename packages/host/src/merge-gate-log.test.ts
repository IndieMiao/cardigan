import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  workerFile,
  workerFixture,
  workerLine,
  workerReport,
  workerRoot,
} from "../test-support/worker-failure.js";
import {
  CHECK_OUTPUT_LIMIT,
  CHECK_SUMMARY_LIMIT,
  boundedCheckSummary,
  createMergeCheckLog,
  safeCheckDiagnostic,
} from "./merge-gate-log.js";
import { verifiedCheckoutContext } from "./worker-failure-context.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-gate-log-"));
  roots.push(root);
  return root;
}
const passed = {
  status: "passed" as const,
  checks: [
    { name: "test", status: "passed" as const, exit_code: 0, duration_ms: 1 },
  ],
  cleanup_errors: [],
};
test("a timeout with surviving processes is recorded for manual attention, not automatic retry", async () => {
  const dataDir = await fixture();
  const log = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "attempt-manual",
  });
  const result = await log.finish({
    status: "timed_out",
    checks: [{ name: "test", status: "timed_out", exit_code: null }],
    cleanup_errors: [
      "Manual attention required: PID 123 state=D wchan=exit_mm",
    ],
    manual_attention: true,
  });
  expect(result.timeout_only).toBe(false);
  expect(
    await readFile(join(dataDir, "merge-gate/logs/p", log.log_ref), "utf8"),
  ).toContain("PID 123 state=D wchan=exit_mm");
});
test("logs redact configured values across chunks and retained edges before writing private files", async () => {
  const dataDir = await fixture(),
    secret = "private-env-value:abc/xyz";
  const log = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "attempt-1",
    env: { API_KEY: secret },
  });
  const path = join(dataDir, "merge-gate/logs/p", log.log_ref);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dataDir, "merge-gate/logs/p"))).mode & 0o777).toBe(
    0o700,
  );
  log.append(
    "test",
    `start\n${"x".repeat(CHECK_OUTPUT_LIMIT / 2 - 40)}${secret.slice(0, 8)}`,
  );
  log.append(
    "test",
    secret.slice(8) +
      "x".repeat(CHECK_OUTPUT_LIMIT) +
      encodeURIComponent(secret) +
      "\n" +
      Buffer.from(secret).toString("base64") +
      "\nend\n",
  );
  await log.finish(passed);
  const text = await readFile(path, "utf8");
  for (const value of [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
  ])
    expect(text).not.toContain(value);
  expect(text).toContain("[REDACTED]");
  expect(text).toContain("[中间输出已截断]");
  expect(text).toContain("start\n");
  expect(text).toContain("\nend\n");
  expect(Buffer.byteLength(text)).toBeLessThan(CHECK_OUTPUT_LIMIT + 200);
  await expect(
    createMergeCheckLog({ dataDir, project: "p", attempt: "attempt-1" }),
  ).rejects.toMatchObject({ code: "EEXIST" });
});
test("failure summaries take error lines from the last 40 lines, stay within 20 lines and redact metadata", async () => {
  const dataDir = await fixture(),
    secret = "example-sensitive-token";
  const log = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "failed",
    env: { SECRET: secret },
  });
  log.append(
    "test",
    "FAIL too old\n" +
      Array.from({ length: 50 }, (_, n) => `Error ${n}: ${secret}`).join("\n") +
      "\nAuthorization: Bearer opaque-value\n-----BEGIN PRIVATE KEY-----\nprivate-key-bytes\n-----END PRIVATE KEY-----\n",
  );
  const result = await log.finish({
    status: "failed",
    checks: [
      { name: "test", status: "failed", exit_code: 1, duration_ms: 10 },
      { name: "later", status: "not_run" },
    ],
    cleanup_errors: [secret],
    reason: secret,
  });
  expect(result.summary.split("\n").length).toBeLessThanOrEqual(20);
  expect(result.summary).toContain("退出码 1");
  expect(result.summary).not.toContain("too old");
  expect(JSON.stringify(result)).not.toContain(secret);
  const text = await readFile(
    join(dataDir, "merge-gate/logs/p", result.log_ref),
    "utf8",
  );
  for (const value of [secret, "opaque-value", "private-key-bytes"])
    expect(text).not.toContain(value);
  expect(text).toContain("later");
  expect(text).toContain("清理提示");
  expect(text).toContain("未输出内容");
});
test("retention removes only old project logs, and unsafe paths or links are rejected", async () => {
  const dataDir = await fixture();
  for (const project of ["p", "q"]) {
    const initial = await createMergeCheckLog({
      dataDir,
      project,
      attempt: "initial",
    });
    await initial.finish(passed);
  }
  const directory = join(dataDir, "merge-gate/logs/p");
  for (let n = 0; n < 51; n++) {
    const file = join(directory, `old-${String(n).padStart(2, "0")}.log`);
    await writeFile(file, "old", { mode: 0o600 });
    await utimes(file, n + 1, n + 1);
  }
  const latest = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "latest",
  });
  await latest.finish(passed);
  const names = await readdir(directory);
  expect(names).toHaveLength(50);
  expect(names).not.toContain("old-00.log");
  expect(names).toContain("latest.log");
  expect(await readdir(join(dataDir, "merge-gate/logs/q"))).toEqual([
    "initial.log",
  ]);
  await expect(
    createMergeCheckLog({ dataDir, project: "../p", attempt: "x" }),
  ).rejects.toThrow();
  const target = join(dataDir, "keep");
  await writeFile(target, "keep");
  await symlink(target, join(directory, "linked.log"));
  await expect(
    createMergeCheckLog({ dataDir, project: "p", attempt: "linked" }),
  ).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("keep");
  await chmod(directory, 0o777);
  await expect(
    createMergeCheckLog({ dataDir, project: "p", attempt: "unsafe" }),
  ).rejects.toThrow(/private/);
});

test("short env values do not corrupt output; the eight-byte boundary and multibyte values are redacted", async () => {
  const dataDir = await fixture();
  const log = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "short-env",
    env: {
      CI: "1",
      MODE: "a",
      SHORT: "abcdefg",
      EMPTY: "",
      ASCII: "abcdefgh",
      UNICODE: "中文值",
    },
  });
  log.append("test", "FAIL a command returned 1\nabcdefg\nabcdefgh\n中文值\n");
  const result = await log.finish({
    status: "failed",
    checks: [{ name: "test", status: "failed", exit_code: 1 }],
    cleanup_errors: [],
  });
  const text = await readFile(
    join(dataDir, "merge-gate/logs/p", log.log_ref),
    "utf8",
  );
  expect(text).toContain(
    "FAIL a command returned 1\nabcdefg\n[REDACTED]\n[REDACTED]\n",
  );
  expect(result.summary).toContain("FAIL a command returned 1");
  expect(text).not.toContain("abcdefgh");
  expect(text).not.toContain("中文值");
});
test.each([
  [
    "interrupted",
    "临时工作区建好之前已取消",
    [],
    "合并检查已取消：临时工作区建好之前已取消",
  ],
  [
    "failed",
    "Temporary checkout failed",
    ["Could not remove temporary worktree registration"],
    "合并检查未通过：Temporary checkout failed",
  ],
] as const)(
  "%s results before any check summarise as cancellation or failure",
  async (status, reason, cleanup_errors, summary) => {
    const dataDir = await fixture();
    const log = await createMergeCheckLog({
      dataDir,
      project: "p",
      attempt: status,
    });
    const result = await log.finish({
      status,
      checks: [{ name: "test", status: "not_run" }],
      cleanup_errors: [...cleanup_errors],
      reason,
    });
    expect(result.summary).toBe(summary);
    const text = await readFile(
      join(dataDir, "merge-gate/logs/p", result.log_ref),
      "utf8",
    );
    expect(text).toContain(`\n${summary}\n`);
    if (cleanup_errors.length)
      expect(text).toContain(
        "\n清理提示：\nCould not remove temporary worktree registration\n",
      );
    else expect(text).not.toContain("清理提示");
  },
);

test("D4: failure excerpt comes from the first FAIL after redaction, is byte bounded, and resume keeps private file checks", async () => {
  const dataDir = await fixture();
  const input = {
    dataDir,
    project: "p",
    attempt: "github-attempt",
    failureExcerptBytes: 4096,
    env: { SECRET: "synthetic-private-value" },
  };
  await createMergeCheckLog(input);
  const log = await createMergeCheckLog({ ...input, resume: true });
  const path = join(dataDir, "merge-gate/logs/p", log.log_ref);
  log.append(
    "test",
    `setup\n2026-11-15 FAIL first synthetic-private-value token=ghp_synthetic123456\n\u0000\u200b${"中文".repeat(2000)}\nFAIL second\n`,
  );
  expect(await readFile(path, "utf8")).not.toContain("FAIL");
  const result = await log.finish({
    status: "failed",
    checks: [{ name: "test", status: "failed", exit_code: 1 }],
    cleanup_errors: [],
  });
  expect(result.failure_excerpt).toMatch(/^2026-11-15 FAIL first/u);
  expect(result.failure_excerpt).not.toContain(String.fromCharCode(0));
  expect(result.failure_excerpt).not.toContain("\u200b");
  expect(Buffer.byteLength(result.failure_excerpt!)).toBeLessThanOrEqual(4096);
  for (const text of [
    result.summary,
    result.failure_excerpt!,
    await readFile(path, "utf8"),
  ]) {
    expect(text).not.toContain("synthetic-private-value");
    expect(text).not.toContain("ghp_synthetic123456");
  }
  await chmod(path, 0o644);
  await expect(createMergeCheckLog({ ...input, resume: true })).rejects.toThrow(
    "Unsafe resumed",
  );
});

test("C-349: dotted installation tokens stay redacted in GitHub logs, summaries and excerpts", async () => {
  const dataDir = await fixture();
  const token = `ghs_${"a".repeat(190)}.${"b".repeat(195)}`;
  const log = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "dotted-token",
    failureExcerptBytes: 4096,
  });
  // Exercise existing credential markers without a configured secret value.
  log.append("test", `FAIL token=${token}\nAuthorization: Bearer ${token}\n`);
  const result = await log.finish({
    status: "failed",
    checks: [{ name: "test", status: "failed", exit_code: 1 }],
    cleanup_errors: [],
  });
  for (const text of [
    result.summary,
    result.failure_excerpt!,
    await readFile(join(dataDir, "merge-gate/logs/p", log.log_ref), "utf8"),
  ]) {
    expect(text).not.toContain(token);
    expect(text).not.toContain("b".repeat(195));
    expect(text).toContain("[REDACTED]");
  }
});

test("D4 rework: normalize controls before redaction across chunks in log, summary and excerpt", async () => {
  const dataDir = await fixture();
  const log = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "normalized",
    failureExcerptBytes: 4096,
    env: { SECRET: "synthetic-private-value" },
  });
  log.append("test", "FAIL leak synth\u200betic-private-value synth\u0000");
  log.append(
    "test",
    "etic-private-value ghp_\u200bsynthetic123456 sk-\u0000synthetic123456\n",
  );
  const result = await log.finish({
    status: "failed",
    checks: [{ name: "test", status: "failed", exit_code: 1 }],
    cleanup_errors: [],
  });
  const file = await readFile(
    join(dataDir, "merge-gate/logs/p", log.log_ref),
    "utf8",
  );
  for (const text of [file, result.summary, result.failure_excerpt ?? ""]) {
    for (const secret of [
      "synthetic-private-value",
      "ghp_synthetic123456",
      "sk-synthetic123456",
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
  }
});

test.each([
  "sk-learn",
  "ghp_x",
  "github_pat_x",
  "-----END RSA PRIVATE KEY-----",
])(
  "D4 rework: short or standalone marker %s is safe in excerpts",
  async (marker) => {
    const dataDir = await fixture();
    const log = await createMergeCheckLog({
      dataDir,
      project: "p",
      attempt: "short-marker",
      failureExcerptBytes: 4096,
    });
    log.append("test", `FAIL uses ${marker} ids\n`);
    const result = await log.finish({
      status: "failed",
      checks: [{ name: "test", status: "failed", exit_code: 1 }],
      cleanup_errors: [],
    });
    expect(result.failure_excerpt).toBe("FAIL uses [REDACTED] ids\n");
  },
);

test("D4 rework: SSH retains its summary and does not opt into GitHub failure excerpts", async () => {
  const dataDir = await fixture();
  const log = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "ssh",
  });
  log.append("test", "FAIL uses sk-learn style ids\n");
  const result = await log.finish({
    status: "failed",
    checks: [{ name: "test", status: "failed", exit_code: 1 }],
    cleanup_errors: [],
  });
  expect(result.status).toBe("failed");
  expect(result.failure_excerpt).toBeUndefined();
  expect(result.summary).toContain("FAIL");
});

test.each([false, true])(
  "D4 rework: timestamped GitHub timeout report preserves conservative classification (mixed=%s)",
  async (mixed) => {
    const dataDir = await fixture();
    const log = await createMergeCheckLog({
      dataDir,
      project: "p",
      attempt: "timestamp",
      failureExcerptBytes: 4096,
    });
    const report =
      " FAIL src/check.test.ts > slow test\nError: Test timed out in 5000ms.\n" +
      (mixed
        ? " FAIL src/check.test.ts > wrong answer\nError: expected 1 to be 2\n"
        : "");
    log.append(
      "test",
      report
        .split("\n")
        .filter(Boolean)
        .map((line) => `2030-01-01T00:00:00.0000000Z ${line}\n`)
        .join(""),
    );
    const result = await log.finish({
      status: "failed",
      checks: [{ name: "test", status: "failed", exit_code: 1 }],
      cleanup_errors: [],
    });
    expect(result.timeout_only).toBe(!mixed);
    expect(result.summary).toContain("FAIL src/check.test.ts");
  },
);

test.each(["clean", "mixed", "truncated", "empty", "manual", "unknown-stream"])(
  "A1b: full log classification before clipping the summary (%s)",
  async (mode) => {
    const dataDir = await fixture();
    const line = workerLine();
    const f = workerFixture();
    const log = await createMergeCheckLog({
      dataDir,
      project: "p",
      attempt: "infra",
      infraFlakyRules: mode === "empty" ? [] : f.options.rules,
      workerIdentity: f.identity,
      ...(f.context ? { workerContext: f.context } : {}),
      failureExcerptBytes: 4096,
    });
    log.append(
      "test",
      workerReport([line])
        .split("\n")
        .map((line) => `2030-01-01T00:00:00.0000000Z ${line}\n`)
        .join(""),
    );
    if (mode === "unknown-stream")
      log.append("executor-log", "日志获取不完整\n");
    if (mode === "mixed")
      log.append("test", "AssertionError: expected 1 to be 2\n");
    log.append(
      "test",
      "ordinary output\n".repeat(mode === "truncated" ? 160000 : 100),
    );
    const result = await log.finish({
      status: "failed",
      checks: [{ name: "test", status: "failed", exit_code: 1 }],
      cleanup_errors: [],
      ...(mode === "manual" ? { manual_attention: true } : {}),
    });
    expect(result.infra_flaky).toBe(mode === "clean");
    expect(result.timeout_only).toBe(false);
  },
);

test.each([false, true])(
  "A1b rework: complete timestamped groups reach classification (mixed=%s)",
  async (mixed) => {
    const dataDir = await fixture();
    const marker = workerLine();
    const f = workerFixture();
    const count = mixed ? 2 : 1;
    const report = [
      " RUN v5.1.0 /fixture",
      "⎯⎯⎯ Unhandled Errors ⎯⎯⎯",
      `Vitest caught ${count} unhandled error${mixed ? "s" : ""} during the test run.`,
      "⎯⎯⎯ Unhandled Error ⎯⎯⎯",
      marker,
      ...(mixed
        ? ["⎯⎯⎯ Unhandled Rejection ⎯⎯⎯", "Validation: invalid input"]
        : []),
      `Errors ${count} error${mixed ? "s" : ""}`,
    ]
      .map((line) => `2030-01-01T00:00:00.0000000Z ${line}\n`)
      .join("");
    const log = await createMergeCheckLog({
      dataDir,
      project: "p",
      attempt: "groups",
      infraFlakyRules: f.options.rules,
      workerIdentity: f.identity,
      ...(f.context ? { workerContext: f.context } : {}),
      failureExcerptBytes: 4096,
    });
    log.append("test", report.slice(0, report.length / 2));
    log.append("test", report.slice(report.length / 2));
    const result = await log.finish({
      status: "failed",
      checks: [{ name: "test", status: "failed", exit_code: 1 }],
      cleanup_errors: [],
    });
    expect(result.infra_flaky).toBe(!mixed);
    expect(result.timeout_only).toBe(false);
  },
);

test("Q-649: logger binds only authenticated roots and matching full check context", async () => {
  const dataDir = await fixture();
  const make = async (attempt: string, stale = false) => {
    const identity = { ...workerFixture().identity, attempt_id: attempt };
    const f = workerFixture({ identity });
    const log = await createMergeCheckLog({
      dataDir,
      project: "p",
      attempt,
      infraFlakyRules: f.options.rules,
      ...(f.context ? { workerContext: f.context } : {}),
      workerIdentity: stale ? { ...identity, completion_id: "D-2" } : identity,
    });
    return { log, identity };
  };
  for (const [attempt, forged, stale] of [
    ["root-real", false, false],
    ["root-forged", true, false],
    ["root-stale", false, true],
  ] as const) {
    const { log, identity } = await make(attempt, stale);
    const receipt = verifiedCheckoutContext({
      project_id: "p",
      attempt_id: attempt,
      candidate_sha: identity.candidate_sha,
      tree_sha: identity.tree_sha,
      root: workerRoot,
    });
    log.verifiedCheckout(
      forged ? JSON.parse(JSON.stringify(receipt)) : receipt,
    );
    log.append(
      "test",
      workerReport([workerLine(`${workerRoot}/${workerFile}`)]),
    );
    const finished = await log.finish({
      status: "failed",
      checks: [{ name: "test", status: "failed", exit_code: 1 }],
      cleanup_errors: [],
    });
    expect(finished.infra_flaky).toBe(!forged && !stale);
  }
});

test("safe preparation diagnostics preserve known error codes, redact the first line, and omit command arguments and raw context", () => {
  const env = { SECRET: "synthetic-secret-value" };
  for (const code of ["EACCES", "ENOSPC", "ECONNREFUSED"]) {
    const error = Object.assign(
      new Error(
        "synthetic /private/path token=synthetic-secret-value\nsecond line",
      ),
      { code, cause: new Error("raw cause") },
    );
    const text = safeCheckDiagnostic(error, env);
    expect(text).toContain(`[${code}]`);
    expect(text).toContain("synthetic");
    for (const secret of [
      "/private/path",
      "synthetic-secret-value",
      "second line",
      "raw cause",
    ])
      expect(text).not.toContain(secret);
  }
  expect(
    safeCheckDiagnostic(
      Object.assign(new Error("ordinary failure"), {
        code: "synthetic-secret-value",
      }),
      env,
    ),
  ).toBe("ordinary failure");
  expect(
    safeCheckDiagnostic(
      new Error("Command failed: synthetic-command --password=secret"),
      env,
    ),
  ).toBe("子进程执行失败（命令参数已省略）");
  expect(
    safeCheckDiagnostic(new Error("x".repeat(CHECK_SUMMARY_LIMIT + 1)), env),
  ).toHaveLength(CHECK_SUMMARY_LIMIT);
});

test("multiple failure diagnostics share the original UTF-8 budget without losing either category or splitting characters", () => {
  const text = boundedCheckSummary(
    `[EACCES] ${"界".repeat(CHECK_SUMMARY_LIMIT)}`,
    `[ENOSPC] ${"界".repeat(CHECK_SUMMARY_LIMIT)}`,
  );
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CHECK_SUMMARY_LIMIT);
  expect(text).toContain("[EACCES]");
  expect(text).toContain("[ENOSPC]");
  expect(text).not.toContain("�");
});
