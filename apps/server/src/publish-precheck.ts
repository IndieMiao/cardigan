import { constants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ossEnvironment,
  type PublishTarget,
  publicationTarget,
} from "./publication-target.js";
import {
  type Execute,
  ossApi,
  run,
  versioningOff,
} from "./publish-artifact.js";

export type PrecheckStep =
  | "configuration"
  | "apksigner"
  | "apkanalyzer"
  | "ossutil"
  | "credentials"
  | "get_bucket_versioning"
  | "list_objects";
export interface PrecheckResult {
  readonly step: PrecheckStep;
  readonly ok: boolean | "skipped";
  /** Fixed wording only: never tool output, paths or configuration values. */
  readonly detail?: string;
}

async function executable(path: string) {
  const s = await stat(path);
  if (!s.isFile()) throw Error();
  await access(path, constants.X_OK);
}

/**
 * Read-only readiness check for one project's publish target, in the same order and
 * with the same configuration, credential and OSS calls as a real publication, before
 * a publish approval is raised. Never writes OSS objects or touches cards.
 */
export async function publicationPrecheck(
  project: string,
  root = join(homedir(), ".config", "cardigan"),
  execute: Execute = run,
): Promise<PrecheckResult[]> {
  const results: PrecheckResult[] = [];
  /** Runs `check` only when its input is available; a thrown error is a bare failure. */
  const step = async <T>(
    name: PrecheckStep,
    input: T | undefined,
    check: (input: T) => Promise<string | undefined>,
  ) => {
    if (input === undefined) {
      results.push({ step: name, ok: "skipped" });
      return false;
    }
    try {
      const failure = await check(input);
      results.push(
        failure === undefined
          ? { step: name, ok: true }
          : { step: name, ok: false, detail: failure },
      );
      return failure === undefined;
    } catch {
      results.push({ step: name, ok: false });
      return false;
    }
  };
  let t: PublishTarget | undefined;
  let credentials: Record<string, string> | undefined;
  const dir = await mkdtemp(join(tmpdir(), "publish-precheck-"));
  try {
    await step("configuration", project, async (p) => {
      t = await publicationTarget(root, p);
      return undefined;
    });
    await step("apksigner", t, async ({ apksigner }) => {
      await executable(apksigner);
      await execute(apksigner, ["--version"], dir);
      return undefined;
    });
    await step("apkanalyzer", t, async ({ apkanalyzer }) => {
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
    return results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function formatPrecheck(results: readonly PrecheckResult[]) {
  return results
    .map(
      (r) =>
        `${r.ok === "skipped" ? "skip" : r.ok ? "ok  " : "FAIL"} ${r.step}${r.detail ? ` · ${r.detail}` : ""}`,
    )
    .join("\n");
}
