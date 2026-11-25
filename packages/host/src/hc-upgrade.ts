import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { HC_RELEASE } from "@cardigan/runtime-herdr";
import type { HcLinkState } from "./deployment-maintenance.js";
import {
  type MaintenanceDriver,
  type MaintenanceWork,
  shellQuote,
} from "./maintenance.js";
import type {
  MaintenanceConfig,
  MaintenanceHcTarget,
} from "./maintenance-config.js";

/** Works from src and dist, like the retention helper. */
const HELPER = readFileSync(
  new URL("../src/hc-target-helper.py", import.meta.url),
  "utf8",
);
const BOOT =
  "import sys,base64,zlib;exec(zlib.decompress(base64.b64decode(sys.stdin.buffer.readline())))";
const PYTHON = "/usr/bin/python3";

export interface HcRelease {
  readonly version: string;
  readonly targets: Readonly<
    Record<string, { readonly url: string; readonly sha256: string }>
  >;
}

export type FetchArchive = (url: string) => Promise<Uint8Array>;

export async function fetchHcArchive(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        (HC_RELEASE as { download_user_agent?: string }).download_user_agent ??
        "cardigan-hc-download/1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`下载 hc 失败：HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** One helper call on a target; the helper prints one JSON line. */
export async function hcHelper(
  driver: MaintenanceDriver,
  target: MaintenanceHcTarget,
  request: Record<string, unknown>,
  archive?: Uint8Array,
): Promise<Record<string, unknown>> {
  const script = `${deflateSync(Buffer.from(HELPER)).toString("base64")}\n`;
  const input = Buffer.concat([
    Buffer.from(script),
    Buffer.from(`${JSON.stringify(request)}\n`),
    ...(archive ? [Buffer.from(archive)] : []),
  ]);
  const argv = [
    ...target.via,
    PYTHON,
    "-I",
    "-c",
    target.via_shell ? shellQuote(BOOT) : BOOT,
  ];
  const result = await driver.run(argv, { input });
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    parsed = undefined;
  }
  if (result.code !== 0 || parsed?.ok !== true)
    throw new Error(
      `hc 目标 ${target.id} ${String(request.op)} 失败：${typeof parsed?.error === "string" ? parsed.error : `退出码 ${result.code}`}`,
    );
  return parsed;
}

export interface HcUpgradePlan {
  readonly version: string;
  readonly targets: readonly MaintenanceHcTarget[];
  /** Path of the staged `hc` per target. */
  readonly staged: Readonly<Record<string, string>>;
  readonly work: MaintenanceWork;
}

/**
 * C-390: everything that can fail without touching a running service happens
 * here, before the maintenance window opens: the version is the one the human
 * named and the repository manifest pins, each archive matches its SHA-256 and
 * every target has the new version staged in its own directory.
 */
export async function prepareHcUpgrade(options: {
  readonly config: MaintenanceConfig;
  readonly version: string;
  readonly release?: HcRelease;
  readonly targetIds?: readonly string[];
  readonly driver: MaintenanceDriver;
  readonly fetchArchive?: FetchArchive;
}): Promise<HcUpgradePlan> {
  const release = options.release ?? HC_RELEASE;
  if (options.version !== release.version)
    throw new Error(
      `deploy/hc-version.json 锁定的版本是 ${release.version}，与指定的 ${options.version} 不一致；换版本需先改清单并合并`,
    );
  const targets = options.config.hc_targets.filter(
    (t) => t.link && (!options.targetIds || options.targetIds.includes(t.id)),
  );
  for (const id of options.targetIds ?? [])
    if (!targets.some((t) => t.id === id))
      throw new Error(`hc 目标 ${id} 不存在或没有配置 link/install_root`);
  if (!targets.length)
    throw new Error(
      "maintenance.yaml 没有可升级的 hc 目标（需要 link 和 install_root）",
    );
  const archives = new Map<string, Uint8Array>();
  const staged: Record<string, string> = {};
  for (const t of targets) {
    const platform = t.platform as string;
    const pinned = release.targets[platform];
    if (!pinned) throw new Error(`hc 清单没有平台 ${platform}`);
    if (
      pinned.url !==
      `https://releases.herdr.dev/core/${release.version}/herdr-core-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`
    )
      throw new Error(`hc 清单中 ${platform} 的下载地址不是官方版本化地址`);
    let archive = archives.get(platform);
    if (!archive) {
      archive = await (options.fetchArchive ?? fetchHcArchive)(pinned.url);
      if (createHash("sha256").update(archive).digest("hex") !== pinned.sha256)
        throw new Error(`hc ${platform} 归档 SHA-256 不符，未做任何切换`);
      archives.set(platform, archive);
    }
    const result = await hcHelper(
      options.driver,
      t,
      {
        op: "stage",
        install_root: t.install_root,
        version: release.version,
        sha256: pinned.sha256,
        platform,
      },
      archive,
    );
    staged[t.id] = String(result.hc);
    const current = await hcHelper(options.driver, t, {
      op: "inspect",
      link: t.link,
    });
    if (current.kind === "missing")
      throw new Error(`hc 目标 ${t.id} 的 ${t.link} 不存在，不新建布局`);
  }
  const version = release.version;
  const work: MaintenanceWork = {
    rollback_scope:
      "hc 升级：失败时把每个已切换目标的 hc 入口恢复为维护前的软链或文件备份，重新启动服务并核对旧版本；新版本目录保留不删",
    expected_hc: Object.fromEntries(targets.map((t) => [t.id, version])),
    async apply({ record, save, driver }) {
      for (const t of targets) {
        const dest = staged[t.id] as string;
        const known = record().steps.switched?.[t.id];
        let previous: HcLinkState | undefined = known;
        if (!previous) {
          const current = await hcHelper(driver, t, {
            op: "inspect",
            link: t.link,
          });
          if (current.kind === "symlink" && current.target === dest) continue;
          previous =
            current.kind === "symlink"
              ? { kind: "symlink", target: String(current.target) }
              : {
                  kind: "file",
                  backup: `${t.install_root}/backup-${record().id}/hc`,
                };
          const recorded = previous;
          // The recovery point is durable before the link changes.
          save((r) => ({
            ...r,
            steps: {
              ...r.steps,
              switched: { ...r.steps.switched, [t.id]: recorded },
            },
          }));
        }
        await hcHelper(driver, t, {
          op: "switch",
          link: t.link,
          dest,
          previous,
        });
      }
    },
    async rollback({ record, driver }) {
      for (const [id, previous] of Object.entries(
        record().steps.switched ?? {},
      )) {
        const t = targets.find((x) => x.id === id);
        if (!t) throw new Error(`hc 目标 ${id} 已不在配置中，无法回退`);
        await hcHelper(driver, t, { op: "restore", link: t.link, previous });
      }
    },
  };
  return { version, targets, staged, work };
}
