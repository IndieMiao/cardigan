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
import { githubCheckRunName } from "./github-dispatch-discovery.js";
import { MACOS_CHECK_WORKFLOW } from "./macos-check-config.js";
import { parseMacosCheckLog } from "./macos-check-result.js";

const root = new URL("../../../", import.meta.url);
const source = readFileSync(new URL(MACOS_CHECK_WORKFLOW, root), "utf8");
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
  "timeout-minutes"?: number;
}
const steps: Step[] = job.steps;
const step = (name: string): Step => {
  const found = steps.find((s) => s.name === name);
  if (!found) throw new Error(`missing step ${name}`);
  return found;
};
const manifest = JSON.parse(
  readFileSync(new URL("deploy/hc-version.json", root), "utf8"),
);
const FILES = [
  "packages/runtime-herdr/src/darwin-retirement.test.ts",
  "packages/runtime-herdr/src/darwin-idle-owner.test.ts",
];
const scratch = mkdtempSync(join(tmpdir(), "macos-workflow-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("Cardigan macOS check workflow", () => {
  test("is host-dispatched, read-only, one job on a standard arm64 runner", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
      "sha",
      "tree",
      "card",
      "delivery",
      "attempt",
      "kind",
      "files",
    ]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["macos"]);
    expect(job["runs-on"]).toBe("macos-15");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(40);
    expect(step("test")["timeout-minutes"]).toBeLessThan(
      job["timeout-minutes"],
    );
    expect(job.strategy).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(source).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token/u);
    expect(source).not.toMatch(/upload-artifact|actions\/cache|mac-mini/u);
    for (const s of steps)
      if (s.uses) expect(s.uses).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/u);
  });

  test("run-name is the host's exact discovery identity", () => {
    const inputs = {
      card: "C-1",
      delivery: "D-2",
      attempt: "a".repeat(32),
      kind: "precheck",
      sha: "b".repeat(40),
      tree: "c".repeat(40),
    };
    const rendered = String(workflow["run-name"]).replace(
      /\$\{\{ inputs\.([a-z]+) \}\}/gu,
      (_, key: keyof typeof inputs) => inputs[key],
    );
    expect(rendered).toBe(githubCheckRunName(inputs));
  });

  test("checks out the candidate without credentials and verifies its identity and files", () => {
    expect(step("Checkout candidate").with).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression
      ref: "${{ inputs.sha }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    const verify = step("Verify candidate identity").run ?? "";
    expect(verify).toContain(`test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"`);
    expect(verify).toContain(
      `test "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_TREE"`,
    );
    expect(verify).toContain("git ls-files --error-unmatch");
  });

  test("runs only the requested files once, without retry or GitHub command files", () => {
    const run = step("test").run ?? "";
    expect(run).toContain("--retry=0");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion
    expect(run).toContain('"${files[@]}"');
    expect(run).toContain("-u CARDIGAN_AGENT_LOCAL_TESTS");
    for (const name of ["GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH"])
      expect(run).toContain(`-u ${name}`);
    expect(step("test").env).toMatchObject({
      COREPACK_ENABLE_NETWORK: "0",
      CARDIGAN_FLAKE_CASES: "",
      CARDIGAN_CHECKED_CASES: "",
    });
    expect(step("Install and verify hc").run).toContain(
      "echo CARDIGAN_REQUIRE_HC=1",
    );
    expect(steps.at(-1)?.name).toBe("Summarize");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression
    expect(step("Summarize").if).toBe("${{ always() }}");
  });

  describe("input validation", () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "uname"),
      '#!/bin/sh\n[ "$1" = -s ] && echo Darwin || echo arm64\n',
    );
    chmodSync(join(bin, "uname"), 0o755);
    const validate = (files: string, attempt = "1") =>
      spawnSync("bash", ["-e", "-c", step("Validate inputs").run ?? ""], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_RUN_ATTEMPT: attempt,
          EXPECTED_SHA: "a".repeat(40),
          EXPECTED_TREE: "b".repeat(40),
          FILES: files,
        },
      });

    test("accepts repository test files and refuses re-runs, options and paths", () => {
      expect(validate(FILES.join(" ")).status).toBe(0);
      const rerun = validate(FILES.join(" "), "2");
      expect(rerun.status).toBe(1);
      expect(rerun.stdout).toContain("request a new macOS check");
      for (const bad of [
        "",
        "--reporter=x",
        "packages/a/../b/x.test.ts",
        "/tmp/x.test.ts",
        `${FILES[0]} ${FILES[0]}`,
        "packages/a/src/x.ts",
        `${FILES[0]}  ${FILES[1]}`,
      ])
        expect(validate(bad).status).not.toBe(0);
    });
  });

  test("reads the hc archive from the candidate manifest", () => {
    const run = step("Install and verify hc").run ?? "";
    const script = /<<'PY'\n([\s\S]*?)\n\s*PY\n/u.exec(run)?.[1];
    expect(script).toBeDefined();
    const result = spawnSync("python3", ["-I", "-"], {
      input: script?.replace(/^ {10}/gmu, ""),
      encoding: "utf8",
      cwd: fileURLToPath(root),
      env: { PATH: process.env.PATH },
    });
    expect(result.status).toBe(0);
    const arch = manifest.targets["macos-aarch64"];
    expect(result.stdout.trim().split(" ")).toEqual([
      arch.url,
      arch.sha256,
      manifest.download_user_agent,
      manifest.version,
    ]);
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
          FILES: FILES.join(" "),
          TEST_OUTCOME: outcome,
          TEST_EXIT_CODE: outcome === "success" ? "0" : "1",
          CARDIGAN_TEST_HC: join(dir, "missing-hc"),
          GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        },
      });
      expect(result.status).toBe(0);
      // GitHub prefixes every log line with a timestamp.
      const log = result.stdout
        .split("\n")
        .map((line) => `2026-11-23T03:00:00.0000000Z ${line}`)
        .join("\n");
      return parseMacosCheckLog(log, FILES);
    };
    const realHc =
      "real hc: a null-status session at its steady empty prompt is stopped";
    const vitest = (state: string, timeout = false) => ({
      testResults: [
        {
          name: `/w/${FILES[0]}`,
          status: "passed",
          assertionResults: [
            { title: "a", fullName: "suite a", status: "passed", duration: 5 },
            { title: "b", status: "passed", duration: 7 },
          ],
        },
        {
          name: `/w/${FILES[1]}`,
          status: state === "passed" ? "passed" : "failed",
          message: state === "failed" && !timeout ? "boom\nsecond" : undefined,
          assertionResults: [
            { title: "c", status: "passed", duration: 1 },
            {
              title: realHc,
              status: state,
              duration: 30000,
              failureMessages: timeout
                ? ["Error: Test timed out in 30000ms."]
                : [],
              meta: {
                cardigan_phases: [
                  { name: "fixture ready", at_ms: 1200 },
                  { name: "signed stop sent", at_ms: 7300 },
                  { name: "bad", at_ms: 10 },
                  { name: "await exit\u0007", at_ms: 8000 },
                ],
              },
            },
            { title: "d", status: "pending" },
          ],
        },
      ],
    });

    test("the host parses per-file counts and the executed real hc case", () => {
      const report = summarize(vitest("passed"));
      expect(report).toMatchObject({
        hc: "unavailable",
        test_step: "success",
        exit_code: 0,
        real_hc_cases: [
          {
            file: FILES[1],
            title: realHc,
            status: "passed",
            duration_ms: 30000,
          },
        ],
        timeouts: [],
      });
      expect(report?.candidate_sha).toMatch(/^[0-9a-f]{40}$/u);
      expect(report?.files).toEqual([
        { file: FILES[0], status: "passed", passed: 2, failed: 0, skipped: 0 },
        { file: FILES[1], status: "passed", passed: 2, failed: 0, skipped: 1 },
      ]);
    });

    test("a timed-out case carries its own phase marks and its file's case timings", () => {
      const report = summarize(vitest("failed", true), "failure");
      expect(report?.exit_code).toBe(1);
      expect(report?.real_hc_cases[0]?.status).toBe("failed");
      expect(report?.timeouts).toEqual([
        {
          file: FILES[1],
          title: realHc,
          status: "failed",
          duration_ms: 30000,
          // Out-of-order marks are dropped; control characters never reach the host.
          phases: [
            { name: "fixture ready", at_ms: 1200 },
            { name: "signed stop sent", at_ms: 7300 },
            { name: "await exit", at_ms: 8000 },
          ],
          file_cases: [
            { title: "c", status: "passed", duration_ms: 1 },
            { title: realHc, status: "failed", duration_ms: 30000 },
            { title: "d", status: "skipped", duration_ms: 0 },
          ],
        },
      ]);
    });

    test("a failed file keeps its first error line; a missing report is explicit", () => {
      expect(summarize(vitest("failed"), "failure")?.files[1]).toMatchObject({
        status: "failed",
        failed: 1,
        error: "boom",
      });
      const missing = summarize(undefined, "failure");
      expect(missing?.files.map((f) => f.status)).toEqual([
        "no_report",
        "no_report",
      ]);
      expect(missing?.real_hc_cases).toEqual([]);
    });
  });
});
