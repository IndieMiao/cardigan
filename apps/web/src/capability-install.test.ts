import { expect, test } from "vitest";
import {
  INSTALLABLE_CAPABILITIES,
  type InstallSystem,
  installCommands,
  installSystems,
  probeText,
} from "./capability-install.js";

const SYSTEMS: InstallSystem[] = ["linux", "steamos", "macos"];
const ARCHES = ["x64", "arm64"];
const all = () =>
  INSTALLABLE_CAPABILITIES.flatMap((key) =>
    SYSTEMS.flatMap((system) =>
      ARCHES.map((arch) => ({
        key,
        system,
        arch,
        text: installCommands(key, system, arch) ?? "",
      })),
    ),
  );
/** Lines a person would run: comments are only read. */
const runLines = (text: string) =>
  text.split("\n").filter((line) => !line.trimStart().startsWith("#"));

test("the first batch is node, godot, blender, Android SDK/emulator and Chromium", () => {
  // The same keys as the host's built-in catalog (machine-capability-catalog).
  expect([...INSTALLABLE_CAPABILITIES].sort()).toEqual([
    "android.emulator",
    "android.sdk",
    "blender",
    "browser.chromium",
    "godot",
    "node",
  ]);
  expect(installCommands("docker", "linux", "x64")).toBeUndefined();
  expect(installCommands("harness.codex", "macos", "arm64")).toBeUndefined();
});

test("every tool has commands for Linux, SteamOS and macOS that end by running its probe", () => {
  const probes: Record<string, string> = {
    node: "node --version",
    godot: "godot --version",
    blender: "blender --version",
    "android.sdk": "adb version",
    "android.emulator": "emulator -version",
    "browser.chromium": "npx -y playwright install chromium",
  };
  for (const { key, text } of all()) {
    expect(text.split("\n")[0]).toMatch(/^# 以 worker 账号执行/);
    expect(runLines(text).join("\n")).toContain(probes[key]);
  }
});

test("no command carries a credential, an account name or a host path", () => {
  for (const { text } of all()) {
    expect(text).not.toMatch(
      /token|password|passwd|secret|bearer|api[_-]?key|mcp_|id_rsa|ssh-|\/srv\/|\/Users\/|cardigan/i,
    );
    // Downloads are public HTTPS only, without user info in the URL.
    for (const url of text.match(/https?:\/\/\S+/g) ?? []) {
      expect(url).toMatch(/^https:\/\/[a-z0-9.-]+\//);
      expect(url).not.toContain("@");
    }
  }
});

test("SteamOS never writes outside the worker's home and never needs sudo", () => {
  for (const { text } of all().filter((c) => c.system === "steamos")) {
    expect(text).toContain("SteamOS 根分区只读");
    for (const line of runLines(text)) {
      expect(line).not.toMatch(/\bsudo\b|apt-get|pacman|steamos-readonly/);
      const targets = [
        ...(line.match(/(?:-C|-fsSLo|>|ln -sf \S+) (\S+)/g) ?? []).map(
          (m) => m.split(" ").at(-1) ?? "",
        ),
        ...(line.startsWith("mkdir -p ") ? line.split(" ").slice(2) : []),
      ];
      for (const target of targets)
        expect(target).toMatch(/^(?:~\/|"\$HOME\/)/);
    }
  }
});

test("administrator steps on Linux stay commented out", () => {
  for (const { text } of all())
    for (const line of runLines(text)) expect(line).not.toMatch(/\bsudo\b/);
});

test("commands follow the machine's architecture", () => {
  expect(installCommands("node", "linux", "arm64")).toContain("linux-arm64");
  expect(installCommands("node", "macos", "arm64")).toContain("darwin-arm64");
  expect(installCommands("godot", "linux", "aarch64")).toContain("linux.arm64");
  expect(installCommands("godot", "steamos", "x64")).toContain("linux.x86_64");
  expect(installCommands("android.emulator", "macos", "arm64")).toContain(
    "/mac/aarch64/",
  );
});

test("a machine's systems: SteamOS registers as linux; unknown shows all", () => {
  expect(installSystems("linux")).toEqual(["linux", "steamos"]);
  expect(installSystems("darwin")).toEqual(["macos"]);
  expect(installSystems(undefined)).toEqual(["linux", "steamos", "macos"]);
});

test("the probe is shown shell-quoted, or as the search locations", () => {
  expect(probeText(undefined)).toEqual([]);
  expect(
    probeText({
      kind: "command",
      argv: ["docker", "version", "--format", "{{.Server.Version}}"],
    }),
  ).toEqual(["docker version --format '{{.Server.Version}}'"]);
  expect(
    probeText({ kind: "command", argv: ["/bin/sh", "-c", "it's here"] }),
  ).toEqual(["/bin/sh -c 'it'\\''s here'"]);
  expect(
    probeText({ kind: "search", locations: ["PATH:chromium", "$HOME/x"] }),
  ).toEqual(["PATH:chromium", "$HOME/x"]);
});
