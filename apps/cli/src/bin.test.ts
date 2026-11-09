import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.NODE_NO_WARNINGS;
delete env.NODE_REDIRECT_WARNINGS;

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../node_modules/typescript/bin/tsc", import.meta.url),
      ),
      "-b",
      cliRoot,
    ],
    { stdio: "pipe" },
  );
}, 30_000);

function run(args: string[]) {
  const result = spawnSync(process.execPath, args, {
    cwd: cliRoot,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

test("built CLI prints help without the SQLite warning", () => {
  const result = run([bin, "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("用法：cardigan <命令>");
  expect(result.stderr).toBe("");
});

test("built CLI preserves usage errors and exit codes", () => {
  const result = run([bin, "unknown-command"]);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^不认识的命令：unknown-command\n/);
  expect(result.stderr).not.toContain("ExperimentalWarning");
});

test("filter is installed before SQLite loads and leaves other warnings visible", () => {
  // Newer Node versions may no longer emit the warning themselves. Emit it
  // at the import boundary as well, so static imports cannot pass silently.
  const preload = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'node:sqlite') {
        process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
        process.emitWarning('Another experimental feature', 'ExperimentalWarning');
        process.emitWarning('Ordinary startup warning');
      }
      return nextResolve(specifier, context);
    } });
  `;
  const result = run([
    "--import",
    `data:text/javascript,${encodeURIComponent(preload)}`,
    bin,
    "--help",
  ]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("用法：cardigan <命令>");
  expect(result.stderr).not.toContain("SQLite is an experimental feature");
  expect(result.stderr).toContain(
    "ExperimentalWarning: Another experimental feature",
  );
  expect(result.stderr).toContain("Warning: Ordinary startup warning");
});

test.each([
  'process.emitWarning(message, "ExperimentalWarning");',
  'process.emitWarning(message, { type: "ExperimentalWarning" });',
  `const warning = new Error(message);
   warning.name = 'ExperimentalWarning';
   process.emitWarning(warning, 'Warning');`,
])("filters the exact SQLite warning: %s", (emit) => {
  const result = run([
    "--input-type=module",
    "--eval",
    `import { installSqliteWarningFilter } from '@cardigan/host/warnings';
     installSqliteWarningFilter();
     const message = 'SQLite is an experimental feature and might change at any time';
     ${emit}`,
  ]);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
});

test("passes through nonmatching warnings with their original arguments", () => {
  const result = run([
    "--input-type=module",
    "--eval",
    `import assert from 'node:assert/strict';
     import { installSqliteWarningFilter } from '@cardigan/host/warnings';
     const calls = [];
     process.emitWarning = function (...args) {
       assert.equal(this, process);
       calls.push(args);
     };
     installSqliteWarningFilter();
     const message = 'SQLite is an experimental feature and might change at any time';
     const ctor = function warningOrigin() {};
     const warning = new Error(message);
     const cases = [
       [message],
       [message, 'Warning'],
       [message, { type: 'Warning', code: 'INFO', detail: 'Keep details' }],
       [message + ' (changed)', 'ExperimentalWarning'],
       ['Another feature', 'ExperimentalWarning', 'OTHER', ctor],
       ['Ordinary warning', ctor],
       ['Ordinary warning', 'Warning', ctor],
       [warning, 'ExperimentalWarning'],
       [42],
     ];
     for (const args of cases) process.emitWarning(...args);
     assert.equal(calls.length, cases.length);
     for (let i = 0; i < cases.length; i++) {
       assert.equal(calls[i].length, cases[i].length);
       for (let j = 0; j < cases[i].length; j++) {
         assert.equal(calls[i][j], cases[i][j]);
       }
     }`,
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
});
