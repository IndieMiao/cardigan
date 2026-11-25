// Standalone so the employee Vitest lock is never nested. GitHub job metadata
// is modeled; the workflow shell, Vitest processes, host decoder and DB are real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkFlakeCases,
  GITHUB_CHECK_NAMES,
  inspectGithubCheckRun,
} from "@cardigan/host";
import { parse } from "yaml";
import { recordCheckFlakes } from "../dist/check-flake-ledger.js";
import { m4Fixture, m4Scenario } from "../dist/m4-fixtures.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const steps = parse(
  readFileSync(join(root, ".github/workflows/cardigan-check.yml"), "utf8"),
).jobs.check.steps;
const partition = steps.find((step) => step.id === "isolated");
// The copied fixture has no TypeScript projects; corepack skips the build too.
const build = 'then "${clean[@]}" pnpm exec tsc -b; fi';
assert.equal(partition.run.split(build).length, 2);
// C-757: the same real flow for a 5000ms-style environment case and the
// synthetic Git transport case's 20000ms timeout inside a describe block.
const failures = {
  corepack:
    "Command failed: pnpm test\\n! Corepack is about to download https://registry.invalid/pnpm.tgz\\nDownloading the pnpm 12.21.0 binary for linux-x64...\\n",
  agent_git:
    'Test timed out in 20000ms.\\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with \\"testTimeout\\".',
};
const dir = mkdtempSync(join(tmpdir(), "check-case-flow-"));
const f = m4Fixture({ memoryDatabase: true });
try {
  const { card } = m4Scenario(f);
  for (const path of [
    "package.json",
    "vitest.config.ts",
    "test-support",
    "packages/host/src/check-flake-cases.ts",
  ]) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, path), target, { recursive: true });
  }
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  const output = join(dir, "github-output");
  for (const key of Object.keys(failures)) {
    const spec = checkFlakeCases[key],
      path = join(dir, spec.file);
    mkdirSync(dirname(path), { recursive: true });
    const marker = steps.find((step) => step.name === `Recovered ${key}`);
    assert.match(marker.if, new RegExp(`steps\\.isolated\\.outputs\\.${key} `));
    assert.ok(
      steps.indexOf(marker) < steps.findIndex((step) => step.id === "build"),
    );
    const names = spec.name.split(" > ");
    const caseName = names.pop();
    for (const mode of [
      "recover",
      "mixed",
      "clean",
      "twice",
      "absent",
      "unselected",
    ]) {
      const selected = mode !== "unselected";
      const recovers = mode === "recover" || mode === "mixed";
      writeFileSync(output, "");
      writeFileSync(
        path,
        `import { describe,expect,test } from "vitest";
      let first = true;
      ${names.map((n) => `describe(${JSON.stringify(n)}, () => {`).join("")}
      test(${JSON.stringify(mode === "absent" ? "other" : caseName)}, () => {
        expect(process.env.GITHUB_OUTPUT).toBeUndefined();
        const fail = (${recovers} && first) || ${JSON.stringify(mode)} === "twice";
        first = false;
        if (fail) throw new Error("${failures[key]}");
      });
      ${mode === "mixed" ? `test("different assertion", () => { expect(1).toBe(2); });` : ""}
      ${names.map(() => "});").join("")}`,
      );
      const result = spawnSync(
        "bash",
        ["-e", "-c", partition.run.replace(build, "then true; fi")],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_ACTIONS: "true",
            COREPACK_ENABLE_NETWORK: "0",
            CARDIGAN_FLAKE_CASES: selected ? key : "",
            GITHUB_OUTPUT: output,
          },
        },
      );
      const success = mode !== "twice" && mode !== "absent" && mode !== "mixed";
      assert.equal(result.status === 0, success, result.stderr);
      const receipt = readFileSync(output, "utf8").trim();
      assert.equal(receipt, recovers ? `${key}=true` : "", mode);
      if (mode === "mixed") {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /different assertion/);
      }
      // Ordinary step outputs cannot alter earlier marker steps, even if that
      // step ran an unrelated subset and has a same-named output.

      const sha = "a".repeat(40);
      const run = {
        id: 1,
        run_attempt: 1,
        status: "completed",
        conclusion: success ? "success" : "failure",
        head_sha: sha,
        path: "check.yml",
      };
      const job = {
        ...run,
        id: 10,
        run_id: 1,
        name: "check",
        steps: steps.map((step, i) => ({
          name: step.name,
          ...(step.id === "test" && !selected
            ? { outputs: { [key]: "true" } }
            : {}),
          number: i + 1,
          status: "completed",
          conclusion: step.name.startsWith("Recovered ")
            ? step === marker && receipt
              ? "success"
              : "skipped"
            : !success && step === partition
              ? "failure"
              : !success && i > steps.indexOf(partition)
                ? "skipped"
                : "success",
        })),
      };
      const mapped = await inspectGithubCheckRun({
        client: { run: async () => run, jobs: async () => [job] },
        runId: 1,
        expectedRun: run,
        request: {
          checks: GITHUB_CHECK_NAMES.map((name) => ({
            name,
            run: "true",
            ...(name === "test" && !selected
              ? { affectedPaths: ["apps/web"] }
              : {}),
          })),
        },
      });
      assert.equal(mapped.status, success ? "passed" : "failed");
      const settle = () =>
        recordCheckFlakes(
          f.store,
          f.project_id,
          card.id,
          `${key}:${mode}`,
          "2030-01-01T00:00:00.000Z",
          mapped.recovered,
          "2",
        );
      const summary = settle();
      if (mode === "mixed") assert.equal(settle(), summary); // Same failed attempt replay.
      if (recovers) {
        assert.deepEqual(mapped.recovered, [key]);
        assert.ok(
          summary.includes(mode === "recover" ? "近七天 1 次" : "近七天 2 次"),
        );
      } else assert.equal(summary, "");
      console.log(
        `${key} ${mode}: ${mapped.status}, ${receipt || "no receipt"}`,
      );
    }
    // The remainder still runs other tests, including a same-named case in the
    // same package, without repeating the already checked file.
    writeFileSync(path, `throw new Error("already ran the isolated file");`);
    writeFileSync(
      join(dirname(path), "other.test.ts"),
      `import {test} from "vitest"; test(${JSON.stringify(spec.name)},()=>{});`,
    );
    const remainder = spawnSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", dirname(dirname(spec.file))],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          CARDIGAN_FLAKE_CASES: "",
          CARDIGAN_CHECKED_CASES: key,
        },
      },
    );
    assert.equal(remainder.status, 0, remainder.stdout + remainder.stderr);
    assert.match(remainder.stdout, /1 passed/);
  }
  const events = f
    .state()
    .events.filter((e) => e.type === "check_case_recovered");
  assert.deepEqual(
    events.map((e) => [e.payload.attempt, e.payload.key, e.payload.signature]),
    Object.keys(failures).flatMap((key) =>
      ["recover", "mixed"].map((mode) => [
        `${key}:${mode}`,
        key,
        checkFlakeCases[key].signature,
      ]),
    ),
  );
  const notices = f.store
    .listNotifications({ project_id: f.project_id })
    .filter((n) => n.kind === "escalation" && n.recipient.kind === "pm_ops");
  assert.deepEqual(
    notices.map((n) => n.event_id),
    [events[1].id, events[3].id],
  );
} finally {
  f.close();
  rmSync(dir, { recursive: true, force: true });
}
