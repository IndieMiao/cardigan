import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import {
  HC_RELEASE,
  isHcCompatible,
  isHcVersionCompatible,
  warnIfHcUntested,
} from "./hc-version.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// Literal releases here are compatibility boundary data, never installation defaults.
test.each([
  ["0.1.17", false],
  ["0.1.18", true],
  ["0.1.21", true],
  ["0.1.100", true],
  ["1.0.0", true],
  ["0.1.21-rc.1", false],
  ["0.1.21+build", false],
  ["0.01.21", false],
  ["0.1", false],
  ["0.1.9007199254740992", false],
  [null, false],
])(
  "version %s follows the numeric stable release floor",
  (version, accepted) => {
    expect(isHcVersionCompatible(version)).toBe(accepted);
    expect(isHcCompatible(version, HC_RELEASE.generation)).toBe(accepted);
    expect(isHcCompatible(version, HC_RELEASE.generation + 1)).toBe(false);
  },
);

test("hc releases are defined only in the manifest and explicit compatibility data", () => {
  const fixtures = new Set([
    "packages/runtime-herdr/src/hc-version.test.ts",
    "packages/runtime-herdr/src/adapter.test.ts",
    "packages/runtime-herdr/src/socket-client.test.ts",
    "packages/runtime-herdr/src/agent-ssh.test.ts",
    "packages/runtime-herdr/src/worker-capabilities.test.ts",
    "packages/runtime-herdr/src/runtime.acceptance.test.ts",
  ]);
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const offenders = files
    .filter(
      (file) =>
        !file.startsWith("docs/") &&
        file !== "deploy/hc-version.json" &&
        file !== "pnpm-lock.yaml" &&
        !fixtures.has(file),
    )
    .filter((file) =>
      /(?<![\d.])0\.1\.\d+(?![\d.])/.test(
        readFileSync(new URL(file, `file://${root}`), "utf8").replace(
          file === "deploy/install-agent.py" ? /^VERSION = "[^"\n]+"$/m : /$^/,
          "",
        ),
      ),
    );
  expect(offenders).toEqual([]);
});

test("versions above the tested ceiling warn once and remain compatible", () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    warnIfHcUntested(HC_RELEASE.minimum_version);
    warnIfHcUntested(HC_RELEASE.maximum_tested);
    expect(warning).not.toHaveBeenCalled();
    expect(isHcCompatible("0.1.101", HC_RELEASE.generation)).toBe(true);
    warnIfHcUntested("0.1.101");
    warnIfHcUntested("0.1.101");
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        `exceeds maximum tested ${HC_RELEASE.maximum_tested}`,
      ),
      { code: "HC_UNTESTED_VERSION" },
    );
  } finally {
    warning.mockRestore();
  }
});

test("the release manifest pins official versioned archives and checksums", () => {
  expect(isHcVersionCompatible(HC_RELEASE.version)).toBe(true);
  expect(
    isHcVersionCompatible(HC_RELEASE.maximum_tested, HC_RELEASE.version),
  ).toBe(true);
  expect(Number.isSafeInteger(HC_RELEASE.generation)).toBe(true);
  for (const [platform, target] of Object.entries(HC_RELEASE.targets)) {
    const extension = platform.startsWith("windows-") ? "zip" : "tar.gz";
    expect(target.url).toBe(
      `https://releases.herdr.dev/core/${HC_RELEASE.version}/herdr-core-${platform}.${extension}`,
    );
    expect(target.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
});

test("the current trusted workflow can read installer mirrors matching the manifest", () => {
  const constants = JSON.parse(
    execFileSync(
      "python3",
      [
        "-B",
        "-c",
        `
import ast,json,pathlib
source=ast.parse(pathlib.Path('deploy/install-agent.py').read_text())
constants={node.targets[0].id:ast.literal_eval(node.value)
           for node in source.body if isinstance(node,ast.Assign)
           and isinstance(node.targets[0],ast.Name)
           and node.targets[0].id in ('VERSION','CHECKSUMS','DOWNLOAD_USER_AGENT')}
print(json.dumps(constants))
`,
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const manifest = JSON.parse(
    readFileSync(
      new URL("../../../deploy/hc-version.json", import.meta.url),
      "utf8",
    ),
  );
  expect(constants).toEqual({
    VERSION: manifest.version,
    CHECKSUMS: Object.fromEntries(
      ["x86_64", "aarch64"].map((arch) => [
        arch,
        manifest.targets[`linux-${arch}`].sha256,
      ]),
    ),
    DOWNLOAD_USER_AGENT: manifest.download_user_agent,
  });
});
