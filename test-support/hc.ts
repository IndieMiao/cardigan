import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Keep CI installation and real-runtime tests on the installer's release.
export const TEST_HC_VERSION = (() => {
  const source = readFileSync(
    new URL("../deploy/install-agent.py", import.meta.url),
    "utf8",
  );
  const version = /^VERSION = "([0-9]+\.[0-9]+\.[0-9]+)"$/m.exec(source)?.[1];
  if (!version) throw new Error("Cannot read hc version from installer");
  return version;
})();

/** Probe only --version; never start a core. Required CI must fail, not skip. */
export function testHcBinary(
  options: {
    binary?: string;
    env?: NodeJS.ProcessEnv;
    probe?: (binary: string) => string;
  } = {},
): string | undefined {
  const env = options.env ?? process.env;
  if (env.CARDIGAN_AGENT_LOCAL_TESTS === "1") {
    if (env.CARDIGAN_REQUIRE_HC === "1")
      throw new Error(
        "hc 必需检查不能在员工本地测试环境跳过（CARDIGAN_REQUIRE_HC 与 CARDIGAN_AGENT_LOCAL_TESTS 冲突）",
      );
    process.stdout.write(
      "[hc] 员工本地测试跳过 hc 相关套件；e2e 只在远程检查里跑\n",
    );
    return undefined;
  }
  const binary = options.binary ?? "hc";
  let available = false;
  try {
    const version = options.probe
      ? options.probe(binary)
      : execFileSync(binary, ["--version"], {
          encoding: "utf8",
          timeout: 3000,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
    available = version.trim() === `hc ${TEST_HC_VERSION}`;
  } catch {
    // Missing binary, failed execution and timeout all mean unavailable.
  }
  if (available) return binary;
  if (env.CARDIGAN_REQUIRE_HC === "1")
    throw new Error(`hc 缺失或版本不符（需要 hc ${TEST_HC_VERSION}）`);
  return undefined;
}
