import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PublicationError } from "@cardigan/mcp-server";
import { z } from "zod";

const absoluteTool = z.string().min(1).refine(isAbsolute);
const targetSchema = z
  .object({
    type: z.literal("aliyun-oss"),
    credential_file: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/u),
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
/** The private directory is fixed by the host; project ids are lookup keys, not paths. */
export async function publicationTarget(root: string, project: string) {
  try {
    const dir = await lstat(root);
    if (
      !dir.isDirectory() ||
      (await realpath(root)) !== root ||
      dir.uid !== process.getuid?.() ||
      (dir.mode & 0o777) !== 0o700
    )
      throw Error();
    const f = await privateFile(join(root, "publish-targets.json"));
    let target: PublishTarget;
    try {
      const all = JSON.parse(await f.readFile("utf8"));
      if (!Object.hasOwn(all, project)) throw Error();
      target = targetSchema.parse(all[project]);
    } finally {
      await f.close();
    }
    await (await privateFile(join(root, target.credential_file))).close();
    return target;
  } catch {
    throw new PublicationError("configuration");
  }
}
