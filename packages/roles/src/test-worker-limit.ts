import { join } from "node:path";
import type { CompiledFile } from "./compile.js";

/** Serialized into the private launch directory; no dependency on the project. */
function guardVitest(maxWorkers: number, lockFile: string): void {
  const { realpathSync, openSync, fstatSync, constants } =
    require("node:fs") as typeof import("node:fs");
  const { basename } = require("node:path") as typeof import("node:path");
  const { spawnSync } =
    require("node:child_process") as typeof import("node:child_process");
  // pnpm/npm scripts, package filters, bin symlinks and direct node invocation
  // all reach Vitest's published CLI. Other Node programs are untouched.
  if (!process.argv[1]) return;
  try {
    if (basename(realpathSync(process.argv[1])) !== "vitest.mjs") return;
  } catch {
    // `node -`, eval and non-file entrypoints are not Vitest.
    return;
  }
  try {
    const fd = openSync(
      lockFile,
      constants.O_CREAT |
        constants.O_RDWR |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    if (!fstatSync(fd).isFile()) throw new Error("Invalid lock");
    // flock's child shares the open file description; this process retains the
    // lock until exit, including crash/SIGKILL. Never wait: nested test runners
    // must fail instead of deadlocking the enclosing test.
    const locked = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      env: { PATH: "/usr/bin:/bin" },
    });
    if (locked.error || locked.status !== 0)
      throw new Error("Lock unavailable");
  } catch {
    process.stderr.write(
      "cardigan: 无法取得员工测试锁（可能已有测试在运行）；请等其结束后重试。\n",
    );
    process.exit(75);
  }
  const args = process.argv.slice(2);
  const kept: string[] = [];
  const positional: string[] = [];
  let limit = maxWorkers;
  // Vitest resolves this environment variable after CLI/project options.
  // Preserve a lower budget, but never let inherited or script-local values
  // raise the host limit (or leave invalid/percentage values for Vitest).
  const inherited = Number(process.env.VITEST_MAX_WORKERS);
  if (Number.isSafeInteger(inherited) && inherited > 0)
    limit = Math.min(limit, inherited);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      positional.push(...args.slice(i));
      break;
    }
    const match = /^--max(?:Workers|-workers)(?:=(.*))?$/.exec(arg);
    if (match) {
      const value = Number(match[1] ?? args[++i]);
      if (Number.isSafeInteger(value) && value > 0)
        limit = Math.min(limit, value);
    } else kept.push(arg);
  }
  process.env.VITEST_MAX_WORKERS = String(limit);
  process.argv.splice(
    2,
    Infinity,
    ...kept,
    `--maxWorkers=${limit}`,
    ...positional,
  );
}

export function testWorkerLimit(
  runDir: string,
  maxWorkers: number,
): {
  file: CompiledFile;
  nodeOptions: string;
} {
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1)
    throw new Error("Test worker limit must be a positive integer");
  const path = join(runDir, "test-workers.cjs");
  return {
    file: {
      path,
      content: `(${guardVitest.toString()})(${maxWorkers}, ${JSON.stringify(join(runDir, "vitest.lock"))});\n`,
      mode: 0o600,
    },
    nodeOptions: `--require=${JSON.stringify(path)}`,
  };
}
