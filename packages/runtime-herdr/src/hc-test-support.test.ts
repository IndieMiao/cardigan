import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { TEST_HC_VERSION, testHcBinary } from "../../../test-support/hc.js";

describe("real-hc test prerequisite", () => {
  test.each([undefined, "0", "1"])(
    "local mode never probes hc, even when required=%s",
    (required) => {
      const probe = vi.fn(() => `hc ${TEST_HC_VERSION}`);
      const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      try {
        const call = () =>
          testHcBinary({
            env: {
              CARDIGAN_AGENT_LOCAL_TESTS: "1",
              CARDIGAN_REQUIRE_HC: required,
            },
            probe,
          });
        if (required === "1") {
          expect(call).toThrow("hc 必需检查不能在员工本地测试环境跳过");
          expect(output).not.toHaveBeenCalled();
        } else {
          expect(call()).toBeUndefined();
          expect(output).toHaveBeenCalledWith(
            "[hc] 员工本地测试跳过 hc 相关套件；e2e 只在远程检查里跑\n",
          );
        }
        expect(probe).not.toHaveBeenCalled();
      } finally {
        output.mockRestore();
      }
    },
  );

  test.each([undefined, "0"])(
    "inactive local flag %s preserves required hc probing",
    (local) => {
      const probe = vi.fn(() => `hc ${TEST_HC_VERSION}`);
      expect(
        testHcBinary({
          env: {
            CARDIGAN_AGENT_LOCAL_TESTS: local,
            CARDIGAN_REQUIRE_HC: "1",
          },
          probe,
        }),
      ).toBe("hc");
      expect(probe).toHaveBeenCalledOnce();
    },
  );

  test("e2e command refuses local execution before any build or runner starts", () => {
    const root = mkdtempSync(join(tmpdir(), "cg-e2e-guard-"));
    try {
      mkdirSync(join(root, "test-support"));
      writeFileSync(
        join(root, "test-support/e2e-guard.mjs"),
        readFileSync("test-support/e2e-guard.mjs"),
      );
      const manifest = JSON.parse(readFileSync("package.json", "utf8"));
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: { "test:e2e": manifest.scripts["test:e2e"] },
        }),
      );
      const marker = join(root, "invoked");
      for (const command of ["tsc", "vitest", "hc"])
        writeFileSync(
          join(root, command),
          `#!/bin/sh\nprintf invoked > '${marker}'\nexit 99\n`,
          { mode: 0o700 },
        );
      const env = {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        CARDIGAN_AGENT_LOCAL_TESTS: "1",
      };
      const result = spawnSync("pnpm", ["test:e2e"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("e2e 只在远程检查里跑");
      expect(() => readFileSync(marker)).toThrow();
      // The standalone guard permits the remote path; no actual E2E is run.
      const remote = spawnSync(
        process.execPath,
        [resolve("test-support/e2e-guard.mjs")],
        {
          env: {
            ...env,
            CARDIGAN_AGENT_LOCAL_TESTS: "0",
            CARDIGAN_REQUIRE_HC: "1",
          },
          encoding: "utf8",
        },
      );
      expect(remote.status).toBe(0);
      expect(remote.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tracks the installer version without importing or executing it", () => {
    const version = execFileSync(
      "python3",
      [
        "-c",
        `
import ast, pathlib
source = ast.parse(pathlib.Path('deploy/install-agent.py').read_text())
print(next(ast.literal_eval(n.value) for n in source.body
           if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)
           and n.targets[0].id == 'VERSION'))
`,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(TEST_HC_VERSION).toBe(version);
  });

  for (const required of [undefined, "0", "1"]) {
    test(`accepts the exact version (required=${required})`, () => {
      const probe = vi.fn(() => `hc ${TEST_HC_VERSION}\n`);
      expect(
        testHcBinary({ env: { CARDIGAN_REQUIRE_HC: required }, probe }),
      ).toBe("hc");
      expect(probe).toHaveBeenCalledOnce();
      expect(probe).toHaveBeenCalledWith("hc");
    });
    for (const probe of [
      () => {
        throw new Error("unavailable or timeout");
      },
      () => "hc 0.0.0",
      () => `hc ${TEST_HC_VERSION}-other`,
      () => "",
    ]) {
      test(`unavailable hc fails only in required mode (${required})`, () => {
        const call = () =>
          testHcBinary({ env: { CARDIGAN_REQUIRE_HC: required }, probe });
        if (required === "1") expect(call).toThrow("hc 缺失或版本不符");
        else expect(call()).toBeUndefined();
      });
    }
  }

  test("honors explicit binary without exposing diagnostics", () => {
    const probe = vi.fn(() => `hc ${TEST_HC_VERSION}`);
    expect(testHcBinary({ binary: "/fixture/default", env: {}, probe })).toBe(
      "/fixture/default",
    );
    expect(() =>
      testHcBinary({
        env: { CARDIGAN_REQUIRE_HC: "1" },
        probe: () => {
          throw new Error("sensitive child output");
        },
      }),
    ).toThrow(/^hc 缺失或版本不符（需要 hc [0-9.]+）$/);
  });

  test("missing executable is handled by the real probe", () => {
    expect(testHcBinary({ env: {}, binary: "/fixture/no-hc" })).toBeUndefined();
    expect(() =>
      testHcBinary({
        env: { CARDIGAN_REQUIRE_HC: "1" },
        binary: "/fixture/no-hc",
      }),
    ).toThrow("hc 缺失或版本不符");
  });
});
