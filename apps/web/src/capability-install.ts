import type { MachineCapabilityView } from "./api.js";

/**
 * C-708: install commands for the first batch of on-demand tools. They are
 * shown to be copied and run on the device by a person; the host never runs
 * them. Every tool goes under the worker account's home (`~/.local`,
 * `~/Android/Sdk`), so the same commands work on SteamOS's read-only root;
 * steps that need an administrator stay commented out. No command carries an
 * account name, token or other credential.
 */
export type InstallSystem = "linux" | "steamos" | "macos";
export const INSTALL_SYSTEM_LABELS: Readonly<Record<InstallSystem, string>> = {
  linux: "Linux",
  steamos: "SteamOS",
  macos: "macOS",
};

/** The systems a machine's registered OS can be; SteamOS registers as linux. */
export function installSystems(os: string | undefined): InstallSystem[] {
  if (os === "darwin" || os === "macos") return ["macos"];
  if (os === "linux") return ["linux", "steamos"];
  return ["linux", "steamos", "macos"];
}

type Arch = "x64" | "arm64";
const archOf = (arch: string | undefined): Arch =>
  arch === "arm64" || arch === "aarch64" ? "arm64" : "x64";

const LOCAL = "mkdir -p ~/.local/opt ~/.local/bin";
const header = (system: InstallSystem) =>
  system === "steamos"
    ? "# 以 worker 账号执行；SteamOS 根分区只读，全部装在 /home 下，worker 的 PATH 须包含 ~/.local/bin"
    : "# 以 worker 账号执行；装在用户目录下，worker 的 PATH 须包含 ~/.local/bin";

type Guide = (system: InstallSystem, arch: Arch) => string[];

const node: Guide = (system, arch) => {
  const platform = `${system === "macos" ? "darwin" : "linux"}-${arch}`;
  return [
    "NODE_DIST=https://nodejs.org/dist/latest-v24.x",
    `NODE_PKG=$(curl -fsSL "$NODE_DIST/SHASUMS256.txt" | grep -o 'node-v[0-9.]*-${platform}\\.tar\\.xz' | head -n 1)`,
    LOCAL,
    'curl -fsSL "$NODE_DIST/$NODE_PKG" | tar -xJ -C ~/.local/opt',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion.
    'ln -sf ~/.local/opt/"${NODE_PKG%.tar.xz}"/bin/* ~/.local/bin/',
    "node --version",
  ];
};

const GODOT = "4.5-stable";
const godot: Guide = (system, arch) => {
  const release = `https://github.com/godotengine/godot/releases/download/${GODOT}`;
  if (system === "macos")
    return [
      LOCAL,
      `curl -fsSLo "$TMPDIR/godot.zip" ${release}/Godot_v${GODOT}_macos.universal.zip`,
      'ditto -x -k "$TMPDIR/godot.zip" ~/.local/opt/godot',
      "ln -sf ~/.local/opt/godot/Godot.app/Contents/MacOS/Godot ~/.local/bin/godot",
      "godot --version",
    ];
  const file = `Godot_v${GODOT}_linux.${arch === "arm64" ? "arm64" : "x86_64"}`;
  return [
    `${LOCAL} ~/.local/opt/godot`,
    `curl -fsSLo ~/.local/opt/godot/godot.zip ${release}/${file}.zip`,
    "python3 -m zipfile -e ~/.local/opt/godot/godot.zip ~/.local/opt/godot",
    `chmod +x ~/.local/opt/godot/${file}`,
    `ln -sf ~/.local/opt/godot/${file} ~/.local/bin/godot`,
    "godot --version",
  ];
};

const BLENDER = "4.5.3";
const blender: Guide = (system, arch) => {
  const release = `https://download.blender.org/release/Blender${BLENDER.split(".").slice(0, 2).join(".")}`;
  if (system === "macos")
    return [
      LOCAL,
      `curl -fsSLo "$TMPDIR/blender.dmg" ${release}/blender-${BLENDER}-macos-${arch}.dmg`,
      'hdiutil attach -nobrowse -readonly -mountpoint "$TMPDIR/blender" "$TMPDIR/blender.dmg"',
      'cp -R "$TMPDIR/blender/Blender.app" ~/.local/opt/',
      'hdiutil detach "$TMPDIR/blender"',
      "ln -sf ~/.local/opt/Blender.app/Contents/MacOS/Blender ~/.local/bin/blender",
      "blender --version",
    ];
  if (arch === "arm64")
    return [
      "# Blender 官方没有 Linux arm64 版本，改用发行版软件包（需管理员）",
      "# sudo apt-get install -y blender",
      "blender --version",
    ];
  return [
    ...(system === "linux"
      ? [
          "# 没有桌面环境的 Debian/Ubuntu 先由管理员装运行库：",
          "# sudo apt-get install -y libgl1 libxi6 libxrender1 libxkbcommon0 libsm6",
        ]
      : []),
    LOCAL,
    `curl -fsSL ${release}/blender-${BLENDER}-linux-x64.tar.xz | tar -xJ -C ~/.local/opt`,
    `ln -sf ~/.local/opt/blender-${BLENDER}-linux-x64/blender ~/.local/bin/blender`,
    "blender --version",
  ];
};

const SDK = "~/Android/Sdk";
const unzip = (system: InstallSystem, file: string, into: string) =>
  system === "macos"
    ? `ditto -x -k ${file} ${into}`
    : `python3 -m zipfile -e ${file} ${into}`;

const androidSdk: Guide = (system) => {
  const os = system === "macos" ? "darwin" : "linux";
  return [
    `mkdir -p ${SDK} ~/.local/bin`,
    `curl -fsSLo ${SDK}/platform-tools.zip https://dl.google.com/android/repository/platform-tools-latest-${os}.zip`,
    unzip(system, `${SDK}/platform-tools.zip`, SDK),
    `chmod +x ${SDK}/platform-tools/adb`,
    `ln -sf ${SDK}/platform-tools/adb ~/.local/bin/adb`,
    "adb version",
  ];
};

const CMDLINE_TOOLS = "11076708";
const androidEmulator: Guide = (system, arch) => {
  const mac = system === "macos";
  const jre = `https://api.adoptium.net/v3/binary/latest/17/ga/${mac ? "mac" : "linux"}/${arch === "arm64" ? "aarch64" : "x64"}/jre/hotspot/normal/eclipse`;
  const tools = `https://dl.google.com/android/repository/commandlinetools-${mac ? "mac" : "linux"}-${CMDLINE_TOOLS}_latest.zip`;
  return [
    `${LOCAL} ${SDK}/cmdline-tools`,
    `curl -fsSL ${jre} | tar -xz -C ~/.local/opt`,
    `export JAVA_HOME=$(ls -d ~/.local/opt/jdk-17*-jre | tail -n 1)${mac ? "/Contents/Home" : ""}`,
    `curl -fsSLo ${SDK}/cmdline-tools/tools.zip ${tools}`,
    unzip(system, `${SDK}/cmdline-tools/tools.zip`, `${SDK}/cmdline-tools`),
    `mv ${SDK}/cmdline-tools/cmdline-tools ${SDK}/cmdline-tools/latest`,
    `chmod +x ${SDK}/cmdline-tools/latest/bin/*`,
    "# 按提示阅读并接受 Android SDK 许可",
    `${SDK}/cmdline-tools/latest/bin/sdkmanager --sdk_root="$HOME/Android/Sdk" --licenses`,
    `${SDK}/cmdline-tools/latest/bin/sdkmanager --sdk_root="$HOME/Android/Sdk" emulator`,
    `printf '#!/bin/sh\\nexec "$HOME/Android/Sdk/emulator/emulator" "$@"\\n' > ~/.local/bin/emulator`,
    "chmod +x ~/.local/bin/emulator",
    "emulator -version",
    ...(mac
      ? []
      : system === "linux"
        ? [
            "# 运行模拟器需要 /dev/kvm 读写权限，由管理员把 worker 账号加入 kvm 组：",
            "# sudo usermod -aG kvm <worker 账号>",
          ]
        : ["# 运行模拟器需要 /dev/kvm 读写权限：ls -l /dev/kvm"]),
  ];
};

const chromium: Guide = (system) => [
  "# 需要先装好 node；浏览器装在 Playwright 缓存目录",
  "npx -y playwright install chromium",
  ...(system === "linux"
    ? [
        "# 缺系统库时由管理员执行：",
        "# sudo npx -y playwright install-deps chromium",
      ]
    : []),
];

const GUIDES: Readonly<Record<string, Guide>> = {
  node,
  godot,
  blender,
  "android.sdk": androidSdk,
  "android.emulator": androidEmulator,
  "browser.chromium": chromium,
};

/** Keys of the catalog that have install commands (the first batch). */
export const INSTALLABLE_CAPABILITIES: readonly string[] = Object.keys(GUIDES);
export const hasInstallGuide = (key: string) => Object.hasOwn(GUIDES, key);

/** The commands for one tool on one system, or undefined outside the first batch. */
export function installCommands(
  key: string,
  system: InstallSystem,
  arch: string | undefined,
): string | undefined {
  if (!hasInstallGuide(key)) return undefined;
  const guide = GUIDES[key] as Guide;
  return [header(system), ...guide(system, archOf(arch))].join("\n");
}

const SAFE_ARG = /^[A-Za-z0-9_./:=@%+,-]+$/u;
/** The host's probe as a person reads it: a shell-quoted command, or where the search looks. */
export function probeText(probe: MachineCapabilityView["probe"]): string[] {
  if (!probe) return [];
  if (probe.kind === "search") return [...probe.locations];
  return [
    probe.argv
      .map((arg) =>
        SAFE_ARG.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`,
      )
      .join(" "),
  ];
}
