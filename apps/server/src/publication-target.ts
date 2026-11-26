import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { PublicationError } from "@cardigan/mcp-server";
import { z } from "zod";

const absoluteTool = z.string().min(1).refine(isAbsolute);
const targetSchema = z
  .object({
    type: z.literal("aliyun-oss"),
    credential_file: z
      .string()
      .regex(/^publish\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/aliyun-config\.json$/u),
    profile: z.string().regex(/^[\w-]+$/u),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/u),
    region: z.string().regex(/^[a-z0-9-]+$/u),
    origin: z.string().regex(/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u),
    prefix_template: z
      .string()
      .max(500)
      .regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)+<version>-<sha12>\/$/u),
    package_name: z.string().regex(/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/u),
    test_certificate_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    ossutil: absoluteTool,
    apksigner: absoluteTool,
    apkanalyzer: absoluteTool,
  })
  .strict();
export type PublishTarget = z.infer<typeof targetSchema>;

async function privateFile(path: string) {
  const f = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await f.stat();
    if (
      !s.isFile() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o777) !== 0o600 ||
      s.size > 65536 ||
      s.size === 0
    )
      throw Error();
    return f;
  } catch (e) {
    await f.close();
    throw e;
  }
}
async function privateDirectory(path: string, reason: string) {
  try {
    const dir = await lstat(path);
    if (
      !dir.isDirectory() ||
      (await realpath(path)) !== path ||
      dir.uid !== process.getuid?.() ||
      (dir.mode & 0o777) !== 0o700
    )
      throw Error();
  } catch {
    throw new PublicationError("configuration", reason);
  }
}
/** Fixed-wording sub-reasons (C-754): names fields and counts, never values. */
const fail = (reason: string): never => {
  throw new PublicationError("configuration", reason);
};
const configurationError = (e: unknown, reason: string) =>
  e instanceof PublicationError
    ? e
    : new PublicationError("configuration", reason);
async function readJson(path: string, name: string) {
  let f: Awaited<ReturnType<typeof privateFile>>;
  try {
    f = await privateFile(path);
  } catch {
    return fail(`${name} 不存在、不是普通文件或不是服务用户独占 0600`);
  }
  try {
    return JSON.parse(await f.readFile("utf8")) as unknown;
  } catch {
    return fail(`${name} 不是合法 JSON`);
  } finally {
    await f.close();
  }
}
/** The private directory is fixed by the host; project ids are lookup keys, not paths. */
export async function publicationTarget(root: string, project: string) {
  try {
    await privateDirectory(root, "配置目录不存在或不是服务用户独占 0700");
    const all = await readJson(
      join(root, "publish-targets.json"),
      "publish-targets.json",
    );
    if (!all || typeof all !== "object" || !Object.hasOwn(all, project))
      fail("publish-targets.json 没有本项目");
    const parsed = targetSchema.safeParse(
      (all as Record<string, unknown>)[project],
    );
    if (!parsed.success)
      return fail(
        `本项目发布配置字段不合格：${[...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "(整体)")))].join("、")}`,
      );
    if (parsed.data.credential_file !== `publish/${project}/aliyun-config.json`)
      fail("credential_file 与项目不符");
    return parsed.data;
  } catch (e) {
    throw configurationError(e, "配置不可读");
  }
}

/** Read only the administrator-provisioned, single-profile AK file. No conversion on disk,
 * credential subprocess, inherited user CLI config, or credentials in argv. */
export async function ossEnvironment(root: string, t: PublishTarget) {
  try {
    const path = join(root, t.credential_file);
    await privateDirectory(
      join(root, "publish"),
      "凭据目录 publish 不存在或不是服务用户独占 0700",
    );
    await privateDirectory(
      dirname(path),
      "本项目凭据目录不存在或不是服务用户独占 0700",
    );
    const { profiles } = ((await readJson(path, "凭据文件")) ?? {}) as {
      profiles?: unknown;
    };
    if (!Array.isArray(profiles)) return fail("凭据文件没有 profiles 列表");
    if (profiles.length !== 1)
      fail(`凭据文件须只有 1 个 profile（当前 ${profiles.length} 个）`);
    const p = profiles[0] ?? {};
    if (p.name !== t.profile) fail("凭据 profile 名称与配置不符");
    if (p.mode !== "AK") fail("凭据 profile 模式不是 AK");
    if (p.region_id !== t.region) fail("凭据 profile 地域与配置不符");
    if (
      typeof p.access_key_id !== "string" ||
      !p.access_key_id ||
      typeof p.access_key_secret !== "string" ||
      !p.access_key_secret
    )
      fail("凭据 profile 缺少 AccessKey");
    return {
      OSS_ACCESS_KEY_ID: p.access_key_id as string,
      OSS_ACCESS_KEY_SECRET: p.access_key_secret as string,
    };
  } catch (e) {
    throw configurationError(e, "凭据文件不可读");
  }
}
