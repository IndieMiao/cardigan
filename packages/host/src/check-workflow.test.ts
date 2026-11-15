import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { githubCheckRunName } from "./github-check-executor.js";
import {
  GITHUB_CHECK_NAMES,
  GITHUB_WORKFLOW_STEPS,
} from "./github-check-poller.js";

const root = new URL("../../../", import.meta.url);
const candidateSource = readFileSync(
  new URL(".github/workflows/cardigan-check.yml", root),
  "utf8",
);
const warmSource = readFileSync(
  new URL(".github/workflows/cache-warm.yml", root),
  "utf8",
);
const candidate = parse(candidateSource);
const warm = parse(warmSource);
const steps = candidate.jobs.check.steps;
const plan = readFileSync(
  new URL("docs/plans/p2a-1-merge-gate.md", root),
  "utf8",
);
const config = parse(plan.match(/```yaml\n([\s\S]*?)```/)?.[1] ?? "");

describe("trusted GitHub check workflow", () => {
  test.each(["merge_check", "precheck"])(
    "D3 host run name matches the published workflow for %s",
    (kind) => {
      const inputs: Record<string, string> = {
        card: "C-1",
        delivery: kind === "precheck" ? "A-1" : "D-1",
        attempt: "attempt-1",
        kind,
        sha: "a".repeat(40),
        tree: "b".repeat(40),
      };
      const rendered = candidate["run-name"].replace(
        /\$\{\{ inputs\.(\w+) \}\}/gu,
        (_match: string, key: string) => inputs[key] ?? "missing",
      );
      expect(githubCheckRunName(inputs)).toBe(rendered);
    },
  );

  test("D4 explicitly names every trusted step in the polling contract", () => {
    expect(steps.map((step: { name: string }) => step.name)).toEqual([
      ...GITHUB_WORKFLOW_STEPS,
    ]);
    expect(
      steps
        .filter((step: { id?: string }) =>
          GITHUB_CHECK_NAMES.includes(step.id as never),
        )
        .map((step: { name: string }) => step.name),
    ).toEqual([...GITHUB_CHECK_NAMES]);
  });

  test("restricts triggers, credentials, concurrency and timeout", () => {
    expect(Object.keys(candidate.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(candidate.on.workflow_dispatch.inputs)).toEqual([
      "sha",
      "tree",
      "card",
      "delivery",
      "attempt",
      "kind",
    ]);
    expect(candidate.permissions).toEqual({ contents: "read" });
    expect(warm.permissions).toEqual({ contents: "read" });
    expect(warm.on).toEqual({ push: { branches: ["main"] } });
    expect(candidateSource + warmSource).not.toMatch(
      /secrets\s*\.|pull_request_target/,
    );
    expect(candidate.concurrency).toEqual({
      group: `cardigan-check-\${{ inputs.card }}`,
      "cancel-in-progress": false,
    });
    expect(candidate.jobs.check["timeout-minutes"] * 60000).toBe(
      config.projects.cardigan.total_timeout_minutes * 60000,
    );
    for (const input of Object.keys(candidate.on.workflow_dispatch.inputs))
      expect(candidate["run-name"]).toContain(`\${{ inputs.${input} }}`);
    expect(
      steps.find((step: { uses?: string }) =>
        step.uses?.startsWith("actions/checkout@"),
      ).with,
    ).toEqual({ ref: `\${{ inputs.sha }}`, "persist-credentials": false });
    expect(warm.jobs.warm.steps[0].with["persist-credentials"]).toBe(false);
  });

  test("candidate cache is restore only; only main push warms it", () => {
    const caches = steps.filter((step: { uses?: string }) =>
      step.uses?.startsWith("actions/cache"),
    );
    expect(caches).toHaveLength(1);
    expect(caches[0].uses).toMatch(/^actions\/cache\/restore@[a-f0-9]{40}$/);
    const warmCache = warm.jobs.warm.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/cache@"),
    );
    expect(warmCache.with).toEqual(caches[0].with);
    expect(
      steps.every((step: { run?: string }) => !step.run?.includes("${{")),
    ).toBe(true);
  });

  test("six ordered check ids and commands match the existing gate contract", () => {
    const ids = ["install", "build", "test", "lint", "deps", "e2e"];
    expect(
      steps
        .filter((step: { id?: string }) => ids.includes(step.id ?? ""))
        .map((step: { id: string }) => step.id),
    ).toEqual(ids);
    expect(
      config.projects.cardigan.checks.map(
        (check: { name: string }) => check.name,
      ),
    ).toEqual(ids);
    const commands = steps
      .filter((step: { id?: string }) => ids.includes(step.id ?? ""))
      .map((step: { run: string }) => step.run);
    expect(commands).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm build",
      'pnpm test --maxWorkers="$(getconf _NPROCESSORS_ONLN)"',
      "pnpm lint",
      "pnpm check:deps",
      "pnpm test:e2e",
    ]);
    const hcIndex = steps.findIndex(
      (step: { name?: string }) => step.name === "Install and verify hc",
    );
    expect(hcIndex).toBeLessThan(
      steps.findIndex((step: { id?: string }) => step.id === "test"),
    );
    expect(steps[hcIndex].run).toContain("ast.literal_eval");
    expect(steps[hcIndex].run).toContain(
      "hashlib.sha256(data).hexdigest() != checksum",
    );
    expect(steps[hcIndex].run).toContain("CARDIGAN_REQUIRE_HC=1");
  });

  test("hc installation verifies archive and executable using offline fixtures", () => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-hc-"));
    try {
      const install = steps.find(
        (step: { name?: string }) => step.name === "Install and verify hc",
      ).run;
      const script = install.match(/python3 - <<'PY'\n([\s\S]*)\nPY\n?$/)?.[1];
      expect(script).toBeTruthy();
      const harness = join(dir, "probe.py");
      writeFileSync(
        harness,
        `
import hashlib, io, json, os, pathlib, platform, tarfile, urllib.request, sys
root = pathlib.Path(sys.argv[1])
os.chdir(root)
(root / 'deploy').mkdir()
data = b'#!/bin/sh\\nprintf "hc 1.2.3\\n"\\n'
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode='w:gz') as bundle:
    member = tarfile.TarInfo('herdr-core')
    member.size = len(data)
    bundle.addfile(member, io.BytesIO(data))
payload = archive.getvalue()
checksum = hashlib.sha256(payload).hexdigest()
mode = sys.argv[2]
if mode == 'checksum': checksum = '0' * 64
version = '9.9.9' if mode == 'version' else '1.2.3'
# This statement must never execute: workflow reads constants with ast only.
source = 'raise RuntimeError("must not execute installer")\\nVERSION = ' + repr(version) + '\\nCHECKSUMS = ' + repr({platform.machine(): checksum})
(root / 'deploy/install-agent.py').write_text(source)
urllib.request.urlopen = lambda *args, **kwargs: io.BytesIO(payload)
os.environ.update(RUNNER_TEMP=str(root), GITHUB_PATH=str(root/'path'), GITHUB_ENV=str(root/'env'))
exec(json.loads(sys.argv[3]))
`,
      );
      for (const mode of ["success", "checksum", "version"]) {
        const fixture = join(dir, mode);
        execFileSync("mkdir", [fixture]);
        const result = spawnSync(
          "python3",
          [harness, fixture, mode, JSON.stringify(script)],
          { encoding: "utf8" },
        );
        if (mode === "success") {
          expect(result.stderr).toBe("");
          expect(result.status).toBe(0);
          expect(readFileSync(join(fixture, "env"), "utf8")).toContain(
            "CARDIGAN_REQUIRE_HC=1",
          );
        } else {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            mode === "checksum" ? "sha256 mismatch" : "hc 缺失或版本不符",
          );
          expect(() => readFileSync(join(fixture, "env"))).toThrow();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("identity gate fails before candidate execution on wrong HEAD/tree or shell payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-gate-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
      git("init", "--quiet");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "fixture",
      );
      const sha = git("rev-parse", "HEAD"),
        tree = git("rev-parse", "HEAD^{tree}");
      const verifyIndex = steps.findIndex(
        (step: { name?: string }) => step.name === "Verify candidate identity",
      );
      expect(
        steps
          .slice(0, verifyIndex + 1)
          .every(
            (step: { run?: string; uses?: string }) =>
              !step.run?.includes("pnpm") &&
              !step.uses?.startsWith("actions/cache"),
          ),
      ).toBe(true);
      const marker = join(dir, "continued");
      const script = `${steps[verifyIndex].run}\nprintf continued > continued\n`;
      const run = (head: string, expectedTree: string) => {
        rmSync(marker, { force: true });
        return spawnSync("bash", ["-e", "-c", script], {
          cwd: dir,
          env: {
            ...process.env,
            EXPECTED_SHA: head,
            EXPECTED_TREE: expectedTree,
          },
        });
      };
      expect(run(sha, tree).status).toBe(0);
      for (const [head, expectedTree] of [
        ["0".repeat(40), tree],
        [sha, "0".repeat(40)],
        ["$(touch injected)", tree],
        [sha, "`touch injected`"],
      ]) {
        expect(run(head, expectedTree).status).not.toBe(0);
        expect(() => readFileSync(marker)).toThrow();
        expect(() => readFileSync(join(dir, "injected"))).toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
