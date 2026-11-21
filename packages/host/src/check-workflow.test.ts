import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { checkFlakeIds } from "./check-flake-cases.js";
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
      ...checkFlakeIds.map((id) => `Recovered ${id}`),
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
      "merge_tier",
      "scope",
      "affected_paths",
      "skip_checks",
    ]);
    expect(candidate.permissions).toEqual({ contents: "read" });
    expect(warm.permissions).toEqual({ contents: "read" });
    expect(warm.on).toEqual({ push: { branches: ["main"] } });
    expect(candidateSource + warmSource).not.toMatch(
      /secrets\s*\.|pull_request_target/,
    );
    expect(candidate).not.toHaveProperty("concurrency");
    for (const job of Object.values(candidate.jobs))
      expect(job).not.toHaveProperty("concurrency");
    expect(candidate.jobs.check["timeout-minutes"] * 60000).toBe(
      config.projects.cardigan.total_timeout_minutes * 60000,
    );
    for (const input of ["sha", "tree", "card", "delivery", "attempt", "kind"])
      expect(candidate["run-name"]).toContain(`\${{ inputs.${input} }}`);
    const checkout = steps.find(
      (step: { name: string }) => step.name === "Checkout candidate",
    );
    expect(checkout.uses).toBe(
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    );
    expect(checkout.with).toEqual({
      ref: `\${{ inputs.sha }}`,
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(warm.jobs.warm.steps[0].with["persist-credentials"]).toBe(false);
  });

  test("main archives only the verified screenshots of the pushed commit", () => {
    const [render, archive] = warm.jobs.warm.steps.slice(-2);
    expect(render.run).toContain(
      "sh apps/web/test-support/ci-page-skeleton.sh",
    );
    expect(archive.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(archive.with).toEqual({
      name: `page-skeleton-\${{ github.sha }}`,
      path: "apps/web/test-support/page-skeleton-snapshots/",
      "if-no-files-found": "error",
    });
    expect(archive.if).toBeUndefined();
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
      "pnpm build\nsh apps/web/test-support/ci-page-skeleton.sh\n",
      expect.stringContaining(
        'pnpm exec vitest run --maxWorkers="$workers" "${affected[@]}"',
      ),
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
import ast, hashlib, io, json, os, pathlib, platform, tarfile, urllib.request, sys
installer = ast.parse(pathlib.Path(sys.argv[4]).read_text())
user_agent = next(ast.literal_eval(n.value) for n in installer.body
                  if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)
                  and n.targets[0].id == 'DOWNLOAD_USER_AGENT')
assert user_agent == 'cardigan-hc-download/1'
root = pathlib.Path(sys.argv[1])
os.chdir(root)
(root / 'deploy').mkdir()
mode = sys.argv[2]
data = b'#!/bin/sh\\nprintf "hc 1.2.3\\n"\\n'
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode='w:gz') as bundle:
    member = tarfile.TarInfo('herdr-core')
    if mode in ('symlink', 'hardlink', 'directory'):
        member.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE, 'directory': tarfile.DIRTYPE}[mode]
        member.linkname = '../outside'
        bundle.addfile(member)
    else:
        member.size = len(data)
        bundle.addfile(member, io.BytesIO(data))
    extra = tarfile.TarInfo('../outside')
    extra.size = 7
    bundle.addfile(extra, io.BytesIO(b'ignored'))
payload = archive.getvalue()
checksum = hashlib.sha256(payload).hexdigest()
if mode == 'checksum': checksum = '0' * 64
version = '9.9.9' if mode == 'version' else '1.2.3'
# This statement must never execute: workflow reads constants with ast only.
source = 'raise RuntimeError("must not execute installer")\\nVERSION = ' + repr(version) + '\\nCHECKSUMS = ' + repr({platform.machine(): checksum}) + '\\nDOWNLOAD_USER_AGENT = ' + repr(user_agent)
(root / 'deploy/install-agent.py').write_text(source)
def urlopen(request, **kwargs):
    assert isinstance(request, urllib.request.Request)
    assert request.full_url == f'https://releases.herdr.dev/core/{version}/herdr-core-linux-{platform.machine()}.tar.gz'
    assert request.get_method() == 'GET' and request.data is None
    assert dict(request.header_items()) == {'User-agent': user_agent}
    assert kwargs == {'timeout': 60}
    return io.BytesIO(payload)
urllib.request.urlopen = urlopen
os.environ.update(RUNNER_TEMP=str(root), GITHUB_PATH=str(root/'path'), GITHUB_ENV=str(root/'env'))
exec(json.loads(sys.argv[3]))
`,
      );
      for (const mode of [
        "success",
        "checksum",
        "version",
        "symlink",
        "hardlink",
        "directory",
      ]) {
        const fixture = join(dir, mode);
        execFileSync("mkdir", [fixture]);
        const result = spawnSync(
          "python3",
          [
            harness,
            fixture,
            mode,
            JSON.stringify(script),
            fileURLToPath(new URL("deploy/install-agent.py", root)),
          ],
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
          const error =
            mode === "checksum"
              ? "sha256 mismatch"
              : mode === "version"
                ? "hc 缺失或版本不符"
                : "regular binary";
          expect(result.stderr).toContain(error);
          expect(() => readFileSync(join(fixture, "env"))).toThrow();
          expect(() => readFileSync(join(fixture, "path"))).toThrow();
        }
        expect(() => readFileSync(join(fixture, "outside"))).toThrow();
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
            MERGE_TIER: "single",
            GITHUB_OUTPUT: join(dir, "outputs"),
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

function scopeOutputs(scope?: string, paths = "", skips = "") {
  const dir = mkdtempSync(join(tmpdir(), "workflow-scope-"));
  try {
    const output = join(dir, "outputs");
    const env = {
      ...process.env,
      EXPECTED_SHA: "a".repeat(40),
      EXPECTED_TREE: "b".repeat(40),
      GITHUB_OUTPUT: output,
      ...(scope === undefined ? {} : { CHECK_SCOPE: scope }),
      AFFECTED_PATHS: paths,
      SKIP_CHECKS: skips,
    };
    delete (env as Record<string, string | undefined>).CHECK_SCOPE;
    if (scope !== undefined) env.CHECK_SCOPE = scope;
    const result = spawnSync("bash", ["-e", "-c", steps[0].run], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(() => readFileSync(join(dir, "injected"))).toThrow();
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.each([
  [undefined, "", "", "full", "false", "false"],
  ["full", "", "", "full", "false", "false"],
  ["unknown", "apps/web", "test,e2e", "full", "false", "false"],
  ["docs_only", "", "test,e2e", "docs_only", "true", "true"],
  ["docs_only", "", "test", "docs_only", "true", "false"],
  ["docs_only", "", "e2e", "docs_only", "false", "true"],
  ["docs_only", "", "test,lint", "full", "false", "false"],
  ["docs_only", "apps/web", "test,e2e", "full", "false", "false"],
  ["affected", "apps/web packages/host", "", "affected", "false", "false"],
  ["affected", "", "", "full", "false", "false"],
  ["affected", "apps/web;touch injected", "", "full", "false", "false"],
  ["affected", "apps/$(touch injected)", "", "full", "false", "false"],
  ["affected", "apps/web\nscope=docs_only", "", "full", "false", "false"],
  ["affected", "apps/web --help", "", "full", "false", "false"],
])(
  "trusted workflow validates scope %s / %s / %s",
  (scope, paths, skips, expected, skipTest, skipE2e) => {
    expect(scopeOutputs(scope, paths, skips)).toEqual({
      scope: expected,
      affected_paths: expected === "affected" ? paths : "",
      skip_test: skipTest,
      skip_e2e: skipE2e,
    });
  },
);

test("trusted workflow executes full or affected test arguments without shell expansion", () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-test-"));
  try {
    const log = join(dir, "calls");
    writeFileSync(
      join(dir, "pnpm"),
      '#!/usr/bin/env python3\nimport json,os,sys\nwith open(os.environ["CALLS"],"a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\n',
      { mode: 0o755 },
    );
    const testStep = steps.find(
      (step: { name: string }) => step.name === "test",
    );
    for (const scope of ["full", "affected"]) {
      rmSync(log, { force: true });
      const result = spawnSync("bash", ["-e", "-c", testStep.run], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          CALLS: log,
          CHECK_SCOPE: scope,
          AFFECTED_PATHS: scope === "affected" ? "apps/web packages/host" : "",
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toEqual(
        scope === "full"
          ? [["test", expect.stringMatching(/^--maxWorkers=\d+$/)]]
          : [
              ["--filter", "@cardigan/domain", "test:types"],
              [
                "exec",
                "vitest",
                "run",
                expect.stringMatching(/^--maxWorkers=\d+$/),
                "apps/web",
                "packages/host",
              ],
            ],
      );
    }
    expect(testStep.if).toBe("steps.scope.outputs.skip_test != 'true'");
    expect(steps.find((step: { name: string }) => step.name === "e2e").if).toBe(
      "steps.scope.outputs.skip_e2e != 'true'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only the trusted complete merge diff grants environment retries (including the old side of a rename)", () => {
  const dir = mkdtempSync(join(tmpdir(), "flake-diff-"));
  try {
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        { cwd: dir, encoding: "utf8" },
      ).trim();
    git("init", "-q");
    writeFileSync(join(dir, "package.json"), "{}");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const script = steps.find(
      (s: { name: string }) => s.name === "Verify candidate identity",
    ).run;
    const check = (
      path: string,
      { tier = "single", remove = false, wrongBase = false } = {},
    ) => {
      git("reset", "--hard", "-q", base);
      execFileSync("mkdir", ["-p", join(dir, path, "..")]);
      writeFileSync(join(dir, path), "{}");
      if (remove) git("rm", "package.json");
      git("add", "--", path);
      git("commit", "-qm", "side");
      const head = git("rev-parse", "HEAD");
      const tree = git("rev-parse", "HEAD^{tree}");
      const candidate = git(
        "commit-tree",
        tree,
        "-p",
        base,
        "-p",
        head,
        "-m",
        "candidate",
      );
      git("checkout", "-q", "--detach", candidate);
      const out = join(dir, "outputs");
      writeFileSync(out, "");
      execFileSync("bash", ["-e", "-c", script], {
        cwd: dir,
        env: {
          ...process.env,
          EXPECTED_SHA: candidate,
          EXPECTED_TREE: tree,
          MERGE_TIER: tier,
          WORKFLOW_BASE: wrongBase ? head : base,
          GITHUB_OUTPUT: out,
        },
      });
      return readFileSync(out, "utf8").trim();
    };
    expect(check("apps/web/src/file.ts")).toBe(
      "retry_cases=ssh_local ssh_remote loopback corepack",
    );
    expect(check("apps/server/src/dispatch.ts")).toBe("retry_cases=corepack");
    expect(check("packages/roles/src/file.ts")).toBe("retry_cases=");
    expect(check("apps/web/src/file.ts", { remove: true })).toBe(
      "retry_cases=",
    );
    expect(check("apps/web/src/file.ts", { wrongBase: true })).toBe(
      "retry_cases=",
    );
    expect(check("apps/web/src/file.ts", { tier: "batch" })).toBe(
      "retry_cases=",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
