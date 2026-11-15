import { execFileSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { TEST_HC_VERSION, testHcBinary } from "../../../test-support/hc.js";

describe("real-hc test prerequisite", () => {
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
