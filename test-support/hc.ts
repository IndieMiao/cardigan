import { execFileSync } from "node:child_process";

import {
  HC_RELEASE,
  isHcVersionCompatible,
} from "../packages/runtime-herdr/src/hc-version.js";
export const TEST_HC_VERSION = HC_RELEASE.version;

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
  const binary = options.binary ?? env.CARDIGAN_TEST_HC ?? "hc";
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
    available = isHcVersionCompatible(/^hc (\S+)$/.exec(version.trim())?.[1]);
  } catch {
    // Missing binary, failed execution and timeout all mean unavailable.
  }
  if (available) return binary;
  if (env.CARDIGAN_REQUIRE_HC === "1")
    throw new Error(
      `hc 缺失或版本不符（需要 hc >= ${HC_RELEASE.minimum_version}，推荐 ${TEST_HC_VERSION}）`,
    );
  return undefined;
}
