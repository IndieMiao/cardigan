import { constants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "@cardigan/domain";
import { PublicationError } from "@cardigan/mcp-server";
import {
  ossEnvironment,
  type PublishTarget,
  publicationTarget,
} from "./publication-target.js";
import {
  type Execute,
  ossApi,
  run,
  signedOnlyBy,
  stageApk,
  versioningOff,
} from "./publish-artifact.js";

export type PrecheckStep =
  | "configuration"
  | "url"
  | "apksigner"
  | "apkanalyzer"
  | "ossutil"
  | "credentials"
  | "get_bucket_versioning"
  | "list_objects"
  | "artifact"
  | "signature"
  | "manifest"
  | "target_prefix";
export interface PrecheckResult {
  readonly step: PrecheckStep;
  readonly ok: boolean | "skipped";
  /** Fixed wording only: never tool output, paths or configuration values. */
  readonly detail?: string;
}
/**
 * C-754: the APK a publish approval is about. Either the final URL (from the
 * publish option) or the version (host command) names where it would go.
 */
export interface PrecheckArtifact {
  readonly sha256: string;
  /** Copy the exact bytes to `dest` (mode 0600), failing on any mismatch. */
  readonly stage: (dest: string) => Promise<unknown>;
  readonly url?: string;
  readonly version?: string;
}

/** What a failing step means when the check itself has nothing more specific. */
const FALLBACK: Record<PrecheckStep, string> = {
  configuration: "配置不可读",
  url: "发布地址与配置不符",
  apksigner: "不可执行或无法运行",
  apkanalyzer: "不可执行",
  ossutil: "不可执行或无法运行",
  credentials: "凭据文件不可读",
  get_bucket_versioning: "调用失败（权限或网络）",
  list_objects: "调用失败（权限或网络）",
  artifact: "附件读取失败或与登记的 SHA-256 不符",
  signature: "签名无效或无法校验",
  manifest: "无法读取 APK 包名和版本",
  target_prefix: "调用失败（权限或网络）",
};
const LABEL: Record<PrecheckStep, string> = {
  configuration: "发布配置",
  url: "发布地址",
  apksigner: "apksigner",
  apkanalyzer: "apkanalyzer",
  ossutil: "ossutil",
  credentials: "凭据文件",
  get_bucket_versioning: "OSS 版本控制检查",
  list_objects: "OSS 列目录",
  artifact: "附件",
  signature: "APK 签名",
  manifest: "APK 包名和版本",
  target_prefix: "目标目录",
};
const VERSION = "[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}";
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

async function executable(path: string) {
  const s = await stat(path);
  if (!s.isFile()) throw Error();
  await access(path, constants.X_OK);
}

/** The release directory and version a URL names under `t`, or a fixed-wording refusal. */
export function releaseLocation(
  t: PublishTarget,
  sha256: string,
  where: { readonly url?: string; readonly version?: string },
): { prefix: string; version: string } | string {
  const sha12 = sha256.slice(0, 12);
  const [head, tail] = t.prefix_template.split("<version>") as [string, string];
  const expected = `${t.origin}/${head}<version>${tail.replace("<sha12>", sha12)}app.apk`;
  const version =
    where.version ??
    new RegExp(
      `^${literal(`${t.origin}/${head}`)}(${VERSION})${literal(`${tail.replace("<sha12>", sha12)}app.apk`)}$`,
      "u",
    ).exec(where.url ?? "")?.[1];
  if (!version || !new RegExp(`^${VERSION}$`, "u").test(version))
    return `须为 ${expected}`;
  return {
    version,
    prefix: t.prefix_template
      .replace("<version>", version)
      .replace("<sha12>", sha12),
  };
}

/**
 * Read-only readiness check for one project's publish target, in the same order and
 * with the same configuration, credential and OSS calls as a real publication, before
 * a publish approval is raised. With `artifact` (C-754) it also checks that APK's
 * signature, package name and version and that its release directory is still empty.
 * Never writes OSS objects or touches cards.
 */
export async function publicationPrecheck(
  project: string,
  root = join(homedir(), ".config", "cardigan"),
  execute: Execute = run,
  options: {
    readonly artifact?: PrecheckArtifact;
    /** Where the APK is staged; the data directory for attachments. */
    readonly workRoot?: string;
  } = {},
): Promise<PrecheckResult[]> {
  const results: PrecheckResult[] = [];
  /** Runs `check` only when its input is available; a thrown error is a step failure. */
  const step = async <T>(
    name: PrecheckStep,
    input: T | undefined,
    check: (input: T) => Promise<string | undefined>,
  ) => {
    if (input === undefined) {
      results.push({ step: name, ok: "skipped" });
      return false;
    }
    let failure: string | undefined;
    try {
      failure = await check(input);
    } catch (e) {
      failure =
        e instanceof PublicationError && e.reason ? e.reason : FALLBACK[name];
    }
    results.push(
      failure === undefined
        ? { step: name, ok: true }
        : { step: name, ok: false, detail: failure },
    );
    return failure === undefined;
  };
  const { artifact } = options;
  let t: PublishTarget | undefined;
  let credentials: Record<string, string> | undefined;
  let location: { prefix: string; version: string } | undefined;
  const dir = await mkdtemp(
    join(options.workRoot ?? tmpdir(), "publish-precheck-"),
  );
  try {
    await step("configuration", project, async (p) => {
      t = await publicationTarget(root, p);
      return undefined;
    });
    if (artifact)
      await step("url", t, async (target) => {
        const where = releaseLocation(target, artifact.sha256, artifact);
        if (typeof where === "string") return where;
        location = where;
        return undefined;
      });
    const signer = await step("apksigner", t, async ({ apksigner }) => {
      await executable(apksigner);
      await execute(apksigner, ["--version"], dir);
      return undefined;
    });
    const analyzer = await step("apkanalyzer", t, async ({ apkanalyzer }) => {
      await executable(apkanalyzer);
      return undefined;
    });
    const ossutil = await step("ossutil", t, async (target) => {
      await executable(target.ossutil);
      await execute(target.ossutil, ["version"], dir);
      return undefined;
    });
    await step("credentials", t, async (target) => {
      credentials = await ossEnvironment(root, target);
      return undefined;
    });
    const oss =
      t && credentials && ossutil
        ? { api: ossApi(execute, t, dir, credentials), target: t }
        : undefined;
    await step("get_bucket_versioning", oss, async ({ api }) =>
      versioningOff(
        await api("get-bucket-versioning", "--output-format", "raw"),
      )
        ? undefined
        : "版本控制已开启或暂停，无法保证目录不可变",
    );
    await step("list_objects", oss, async ({ api, target }) => {
      const template = target.prefix_template;
      const listed = JSON.parse(
        await api(
          "list-objects-v2",
          "--prefix",
          template.slice(0, template.indexOf("<version>")),
          "--max-keys",
          "1",
          "--output-format",
          "json",
        ),
      );
      return listed && typeof listed === "object" ? undefined : "返回无法解析";
    });
    if (!artifact) return results;
    const apk = join(dir, "app.apk");
    const staged = await step("artifact", artifact, async (a) => {
      await a.stage(apk);
      return undefined;
    });
    const ready = staged && t ? t : undefined;
    await step("signature", signer ? ready : undefined, async (target) =>
      signedOnlyBy(
        await execute(
          target.apksigner,
          ["verify", "--verbose", "--print-certs", apk],
          dir,
        ),
        target.test_certificate_sha256,
      )
        ? undefined
        : "签名证书与配置的 test_certificate_sha256 不符，或签名无效",
    );
    await step(
      "manifest",
      analyzer && ready && location
        ? { target: ready, version: location.version }
        : undefined,
      async ({ target, version }) => {
        const read = async (field: string) =>
          (
            await execute(target.apkanalyzer, ["manifest", field, apk], dir)
          ).replace(/\r?\n$/u, "");
        const problems = [
          (await read("application-id")) !== target.package_name &&
            "APK 包名与配置的 package_name 不符",
          (await read("version-name")) !== version &&
            "APK 版本名与发布地址中的版本不符",
        ].filter((m): m is string => typeof m === "string");
        return problems.length ? problems.join("，") : undefined;
      },
    );
    await step(
      "target_prefix",
      oss && location ? { ...oss, prefix: location.prefix } : undefined,
      async ({ api, prefix }) => {
        const listed = JSON.parse(
          await api(
            "list-objects-v2",
            "--prefix",
            prefix,
            "--max-keys",
            "1",
            "--output-format",
            "json",
          ),
        );
        if (!listed || typeof listed !== "object") return "返回无法解析";
        return Number(listed.KeyCount) === 0
          ? undefined
          : "这个版本的发布目录已有对象，不能用新拍板再发";
      },
    );
    return results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One line per failed step, for a refusal or an operator item. */
export function precheckFailures(results: readonly PrecheckResult[]) {
  return results
    .filter((r) => r.ok === false)
    .map((r) => `${LABEL[r.step]}：${r.detail ?? FALLBACK[r.step]}`);
}

/**
 * C-754: the precheck a publish approval runs when raised, for the attachment
 * it names and the URL of its publish option.
 */
export function approvalPrecheck(
  dataDir: string,
  root = join(homedir(), ".config", "cardigan"),
  execute: Execute = run,
) {
  // One precheck per project at a time: each stages a whole APK and calls OSS.
  const queues = new Map<string, Promise<unknown>>();
  return (project: string, a: Attachment, url: string) => {
    const next = (queues.get(project) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () =>
        precheckFailures(
          await publicationPrecheck(project, root, execute, {
            workRoot: dataDir,
            artifact: {
              sha256: a.sha256,
              url,
              stage: (dest) => stageApk(dataDir, a, dest),
            },
          }),
        ),
      );
    queues.set(project, next);
    void next.finally(() => {
      if (queues.get(project) === next) queues.delete(project);
    });
    return next;
  };
}

export function formatPrecheck(results: readonly PrecheckResult[]) {
  return results
    .map(
      (r) =>
        `${r.ok === "skipped" ? "skip" : r.ok ? "ok  " : "FAIL"} ${r.step}${r.detail ? ` · ${r.detail}` : ""}`,
    )
    .join("\n");
}
