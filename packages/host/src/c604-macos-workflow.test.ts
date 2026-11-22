import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = new URL("../../../", import.meta.url);
const source = readFileSync(
  new URL(".github/workflows/c604-macos-isolated.yml", root),
  "utf8",
);
const workflow = parse(source);
const job = workflow.jobs.macos;
interface Step {
  name: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
const steps: Step[] = job.steps;
const step = (name: string): Step => {
  const found = steps.find((s) => s.name === name);
  if (!found) throw new Error(`missing step ${name}`);
  return found;
};
const CANDIDATE = "44493173ca7c778febe575987e0e66ab03021f10";
const FILES = [
  "packages/runtime-herdr/src/darwin-retirement.test.ts",
  "packages/runtime-herdr/src/darwin-idle-owner.test.ts",
];

const scratch = mkdtempSync(join(tmpdir(), "c604-workflow-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("C-604 isolated macOS workflow", () => {
  test("is manual only, read-only, single job on a standard arm64 runner within 20 minutes", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
      "candidate",
    ]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["macos"]);
    expect(job["runs-on"]).toBe("macos-15");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
    expect(job.strategy).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(source).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token/u);
    expect(source).not.toMatch(/upload-artifact|actions\/cache|mac-mini/u);
  });

  test("pins the D-2309 precheck candidate, its tree and hc 0.1.21", () => {
    expect(workflow.env).toMatchObject({
      CANDIDATE_SHA: CANDIDATE,
      CANDIDATE_TREE: "e21bcd8bc1090073b16a32e55f3ffd4bf9de9e5a",
      HC_VERSION: "0.1.21",
    });
    const checkout = step("Checkout candidate");
    expect(checkout.with).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression
      ref: "${{ env.CANDIDATE_SHA }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    for (const s of steps)
      if (s.uses) expect(s.uses).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/u);
    expect(step("Verify candidate identity").run).toContain(
      `test "$(git rev-parse 'HEAD^{tree}')" = "$CANDIDATE_TREE"`,
    );
  });

  test("runs only the two Darwin test files once, without retry or GitHub command files", () => {
    const run = step("test").run ?? "";
    expect(run.match(/packages\/\S+\.test\.ts/gu)).toEqual(FILES);
    expect(run).toContain("--retry=0");
    expect(run).toContain("-u CARDIGAN_AGENT_LOCAL_TESTS");
    for (const name of ["GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH"])
      expect(run).toContain(`-u ${name}`);
    expect(step("test").env).toEqual({
      COREPACK_ENABLE_NETWORK: "0",
      CARDIGAN_FLAKE_CASES: "",
      CARDIGAN_CHECKED_CASES: "",
    });
    expect(step("Install and verify hc").run).toContain(
      "echo CARDIGAN_REQUIRE_HC=1",
    );
  });

  describe("guard", () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "uname"),
      '#!/bin/sh\n[ "$1" = -s ] && echo Darwin || echo arm64\n',
    );
    chmodSync(join(bin, "uname"), 0o755);
    const guard = (attempt: string, requested: string) =>
      spawnSync(
        "bash",
        ["-e", "-c", step("Refuse re-runs and other candidates").run ?? ""],
        {
          encoding: "utf8",
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            GITHUB_RUN_ATTEMPT: attempt,
            REQUESTED: requested,
            CANDIDATE_SHA: CANDIDATE,
          },
        },
      );

    test("accepts only the first attempt for the pinned candidate", () => {
      expect(guard("1", CANDIDATE).status).toBe(0);
      const rerun = guard("2", CANDIDATE);
      expect(rerun.status).toBe(1);
      expect(rerun.stdout).toContain("re-runs are refused");
      const other = guard("1", "a".repeat(40));
      expect(other.status).toBe(1);
      expect(other.stdout).toContain("only the pinned candidate");
    });
  });

  test("reads the hc archive pin from the candidate manifest", () => {
    const run = step("Install and verify hc").run ?? "";
    const script = /<<'PY'\n([\s\S]*?)\nPY\n/u.exec(run)?.[1];
    expect(script).toBeDefined();
    const result = spawnSync("python3", ["-I", "-"], {
      input: script,
      encoding: "utf8",
      cwd: fileURLToPath(root),
      env: { PATH: process.env.PATH, HC_VERSION: "0.1.21" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(" ")).toEqual([
      "https://releases.herdr.dev/core/0.1.21/herdr-core-macos-aarch64.tar.gz",
      "1ab38dd9270f63a8f794d6d60e8702eb0d1c85a72bda85d735e5eea43f05ffed",
      "cardigan-hc-download/1",
    ]);
    const mismatch = spawnSync("python3", ["-I", "-"], {
      input: script,
      encoding: "utf8",
      cwd: fileURLToPath(root),
      env: { PATH: process.env.PATH, HC_VERSION: "0.1.20" },
    });
    expect(mismatch.status).not.toBe(0);
  });

  describe("summary", () => {
    const summarize = (report: unknown, outcome = "success") => {
      const dir = mkdtempSync(join(scratch, "s-"));
      const path = join(dir, "report.json");
      if (report !== undefined) writeFileSync(path, JSON.stringify(report));
      const result = spawnSync("python3", ["-I", "-"], {
        input: step("Summarize").run,
        encoding: "utf8",
        cwd: fileURLToPath(root),
        env: {
          PATH: process.env.PATH,
          REPORT: path,
          TEST_OUTCOME: outcome,
          TEST_EXIT_CODE: outcome === "success" ? "0" : "1",
          REAL_HC_CASE: workflow.env.REAL_HC_CASE,
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "1",
          CARDIGAN_TEST_HC: join(dir, "missing-hc"),
          GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        },
      });
      const json = result.stdout.slice(0, result.stdout.lastIndexOf("}") + 1);
      return {
        status: result.status,
        out: JSON.parse(json),
        stdout: result.stdout,
      };
    };
    const realHc = `${workflow.env.REAL_HC_CASE}; one still in its turn, redrawing or reporting busy is not`;
    const report = (state: string) => ({
      testResults: [
        {
          name: `/w/${FILES[0]}`,
          status: "passed",
          assertionResults: [
            { title: "a", status: "passed" },
            { title: "b", status: "passed" },
          ],
        },
        {
          name: `/w/${FILES[1]}`,
          status: state === "failed" ? "failed" : "passed",
          assertionResults: [
            { title: "c", status: "passed" },
            { title: realHc, status: state },
            { title: "d", status: "pending" },
          ],
        },
      ],
    });

    test("records per-file counts and the executed real hc case", () => {
      const { status, out } = summarize(report("passed"));
      expect(status).toBe(0);
      expect(out).toMatchObject({
        run_id: "1",
        run_attempt: "1",
        hc: "unavailable",
        test_step: "success",
        vitest_exit_code: "0",
        real_hc_case: { title: realHc, status: "passed", executed: true },
      });
      expect(out.files[FILES[0]]).toMatchObject({
        passed: 2,
        failed: 0,
        skipped: 0,
      });
      expect(out.files[FILES[1]]).toMatchObject({
        passed: 2,
        failed: 0,
        skipped: 1,
      });
    });

    test("a failed real hc case is recorded as executed", () => {
      const { status, out } = summarize(report("failed"), "failure");
      expect(status).toBe(0);
      expect(out.real_hc_case).toEqual({
        title: realHc,
        status: "failed",
        executed: true,
      });
      expect(out.files[FILES[1]]).toMatchObject({
        failed: 1,
        file_status: "failed",
      });
    });

    test("a skipped real hc case or a missing report fails the summary", () => {
      const skipped = summarize(report("skipped"));
      expect(skipped.status).toBe(1);
      expect(skipped.out.real_hc_case.executed).toBe(false);
      expect(skipped.stdout).toContain(
        "::error::the real hc case did not execute",
      );
      const missing = summarize(undefined, "failure");
      expect(missing.status).toBe(1);
      expect(missing.out.files[FILES[0]].file_status).toBe("no report");
      expect(missing.out.real_hc_case).toEqual({
        status: "not found",
        executed: false,
      });
    });
  });
});
