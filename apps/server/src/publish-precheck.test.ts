import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "@cardigan/domain";
import { fileAttachmentStore } from "@cardigan/mcp-server";
import { afterEach, expect, test, vi } from "vitest";
import {
  approvalPrecheck,
  formatPrecheck,
  precheckFailures,
  publicationPrecheck,
} from "./publish-precheck.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "apk-precheck-")));
  roots.push(root);
  await chmod(root, 0o700);
  await mkdir(join(root, "publish", "fixture"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(root, "tools"));
  const tool = async (name: string) => {
    const path = join(root, "tools", name);
    await writeFile(path, "#!/bin/sh\n", { mode: 0o755 });
    return path;
  };
  const target = {
    type: "aliyun-oss",
    credential_file: "publish/fixture/aliyun-config.json",
    profile: "fixture",
    bucket: "fixture-test",
    region: "us-west-1",
    origin: "https://download.example.invalid",
    prefix_template: "fixture/test/<version>-<sha12>/",
    package_name: "org.example.test",
    test_certificate_sha256: "b".repeat(64),
    ossutil: await tool("ossutil"),
    apksigner: await tool("apksigner"),
    apkanalyzer: await tool("apkanalyzer"),
  };
  const secret = randomUUID();
  await writeFile(
    join(root, target.credential_file),
    JSON.stringify({
      profiles: [
        {
          name: target.profile,
          mode: "AK",
          region_id: target.region,
          access_key_id: randomUUID(),
          access_key_secret: secret,
        },
      ],
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, "publish-targets.json"),
    JSON.stringify({ fixture: target }),
    { mode: 0o600 },
  );
  const flags = {
    versioning: "<VersioningConfiguration/>",
    denied: "",
    certificate: target.test_certificate_sha256,
    packageName: target.package_name,
    versionName: "1.0.0",
    /** Objects already in the release directory of the checked APK. */
    existing: 0,
  };
  const execute = vi.fn(
    async (
      tool: string,
      args: string[],
      _cwd: string,
      environment?: Record<string, string>,
    ) => {
      expect(args.join(" ")).not.toContain(secret);
      if (tool !== target.ossutil) expect(environment).toBeUndefined();
      if (args[0] === "verify")
        return `Verifies\nNumber of signers: 1\nV3.0 Signer: certificate SHA-256 digest: ${flags.certificate}\n`;
      if (args[0] === "manifest")
        return `${args[1] === "application-id" ? flags.packageName : flags.versionName}\n`;
      if (args[0] !== "api") return "version\n";
      expect(environment?.OSS_ACCESS_KEY_SECRET === secret).toBe(true);
      if (args[1] === flags.denied) throw Error("AccessDenied private detail");
      if (args[1] === "get-bucket-versioning")
        return `${flags.versioning}\n0.1(s) elapsed\n`;
      if (args[1] === "list-objects-v2") {
        const prefix = args[args.indexOf("--prefix") + 1];
        if (prefix === "fixture/test/")
          return JSON.stringify({ KeyCount: "0", IsTruncated: "false" });
        expect(prefix).toBe(`fixture/test/1.0.0-${apkSha.slice(0, 12)}/`);
        return JSON.stringify({
          KeyCount: String(flags.existing),
          IsTruncated: "false",
        });
      }
      throw Error(`unexpected ${args[1]}`);
    },
  );
  return { root, target, flags, execute, secret };
}

const apkBytes = Buffer.from("fake apk");
const apkSha = createHash("sha256").update(apkBytes).digest("hex");
const url = `https://download.example.invalid/fixture/test/1.0.0-${apkSha.slice(0, 12)}/app.apk`;
const artifact = (where: { url?: string; version?: string } = { url }) => ({
  sha256: apkSha,
  ...where,
  stage: (dest: string) => writeFile(dest, apkBytes, { flag: "wx" }),
});

test("a ready target passes every step and writes nothing", async () => {
  const f = await setup();
  const results = await publicationPrecheck("fixture", f.root, f.execute);
  expect(results.map((r) => [r.step, r.ok])).toEqual([
    ["configuration", true],
    ["apksigner", true],
    ["apkanalyzer", true],
    ["ossutil", true],
    ["credentials", true],
    ["get_bucket_versioning", true],
    ["list_objects", true],
  ]);
  const apis = f.execute.mock.calls
    .filter(([, args]) => args[0] === "api")
    .map(([, args]) => args[1]);
  expect(apis).toEqual(["get-bucket-versioning", "list-objects-v2"]);
});

test("missing GetBucketVersioning permission fails before any approval is raised, without tool output", async () => {
  const f = await setup();
  f.flags.denied = "get-bucket-versioning";
  const results = await publicationPrecheck("fixture", f.root, f.execute);
  expect(results.find((r) => r.step === "get_bucket_versioning")?.ok).toBe(
    false,
  );
  expect(results.find((r) => r.step === "list_objects")?.ok).toBe(true);
  expect(formatPrecheck(results)).toContain("FAIL get_bucket_versioning");
  expect(formatPrecheck(results)).not.toContain("private detail");
});

test("enabled versioning and denied prefix listing are reported", async () => {
  const f = await setup();
  f.flags.versioning =
    "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>";
  f.flags.denied = "list-objects-v2";
  const results = await publicationPrecheck("fixture", f.root, f.execute);
  expect(
    results.filter((r) => r.ok === false).map((r) => [r.step, r.detail]),
  ).toEqual([
    ["get_bucket_versioning", "版本控制已开启或暂停，无法保证目录不可变"],
    ["list_objects", "调用失败（权限或网络）"],
  ]);
});

test("a tool that is not executable fails its own step only", async () => {
  const f = await setup();
  await chmod(f.target.apkanalyzer, 0o644);
  await rm(f.target.apksigner);
  const results = await publicationPrecheck("fixture", f.root, f.execute);
  expect(results.filter((r) => r.ok !== true).map((r) => r.step)).toEqual([
    "apksigner",
    "apkanalyzer",
  ]);
});

test("broken credentials skip the OSS calls; an unknown project skips everything", async () => {
  const f = await setup();
  await chmod(join(f.root, f.target.credential_file), 0o644);
  const results = await publicationPrecheck("fixture", f.root, f.execute);
  expect(results.map((r) => [r.step, r.ok]).slice(4)).toEqual([
    ["credentials", false],
    ["get_bucket_versioning", "skipped"],
    ["list_objects", "skipped"],
  ]);
  const none = await publicationPrecheck("other", f.root, f.execute);
  expect(none[0]).toEqual({
    step: "configuration",
    ok: false,
    detail: "publish-targets.json 没有本项目",
  });
  expect(none.slice(1).every((r) => r.ok === "skipped")).toBe(true);
  expect(f.execute.mock.calls.some(([, args]) => args[0] === "api")).toBe(
    false,
  );
});

test("C-754: with an APK, its URL, signature, package, version and empty release directory are checked", async () => {
  const f = await setup();
  const results = await publicationPrecheck("fixture", f.root, f.execute, {
    artifact: artifact(),
  });
  expect(results.map((r) => [r.step, r.ok])).toEqual([
    ["configuration", true],
    ["url", true],
    ["apksigner", true],
    ["apkanalyzer", true],
    ["ossutil", true],
    ["credentials", true],
    ["get_bucket_versioning", true],
    ["list_objects", true],
    ["artifact", true],
    ["signature", true],
    ["manifest", true],
    ["target_prefix", true],
  ]);
  expect(
    f.execute.mock.calls.some(([, args]) => args.includes("put-object")),
  ).toBe(false);
  // The host command names the version instead of the URL.
  const byVersion = await publicationPrecheck("fixture", f.root, f.execute, {
    artifact: artifact({ version: "1.0.0" }),
  });
  expect(byVersion.every((r) => r.ok === true)).toBe(true);
});

test("C-754: an APK that does not match the configuration names each mismatch", async () => {
  const f = await setup();
  f.flags.certificate = "c".repeat(64);
  f.flags.packageName = "org.example.old";
  f.flags.versionName = "0.9.9";
  f.flags.existing = 1;
  const failures = precheckFailures(
    await publicationPrecheck("fixture", f.root, f.execute, {
      artifact: artifact(),
    }),
  );
  expect(failures).toEqual([
    "APK 签名：签名证书与配置的 test_certificate_sha256 不符，或签名无效",
    "APK 包名和版本：APK 包名与配置的 package_name 不符，APK 版本名与发布地址中的版本不符",
    "目标目录：这个版本的发布目录已有对象，不能用新拍板再发",
  ]);
});

test("C-754: a URL outside the configured release layout is refused with the expected form", async () => {
  const f = await setup();
  for (const wrong of [
    "https://other.example.invalid/fixture/test/1.0.0-000000000000/app.apk",
    url.replace(apkSha.slice(0, 12), "0".repeat(12)),
    url.replace("app.apk", "other.apk"),
  ]) {
    const results = await publicationPrecheck("fixture", f.root, f.execute, {
      artifact: artifact({ url: wrong }),
    });
    expect(results.find((r) => r.step === "url")).toEqual({
      step: "url",
      ok: false,
      detail: `须为 https://download.example.invalid/fixture/test/<version>-${apkSha.slice(0, 12)}/app.apk`,
    });
    expect(
      results
        .filter((r) => r.ok === "skipped")
        .map((r) => r.step)
        .sort(),
    ).toEqual(["manifest", "target_prefix"]);
  }
});

test("C-754: a credentials file with several profiles is reported with the count, never values", async () => {
  const f = await setup();
  const profile = {
    name: f.target.profile,
    mode: "AK",
    region_id: f.target.region,
    access_key_id: randomUUID(),
    access_key_secret: f.secret,
  };
  await writeFile(
    join(f.root, f.target.credential_file),
    JSON.stringify({
      profiles: Array.from({ length: 6 }, (_, i) => ({
        ...profile,
        name: i ? `other${i}` : profile.name,
      })),
    }),
  );
  const failures = precheckFailures(
    await publicationPrecheck("fixture", f.root, f.execute),
  );
  expect(failures).toEqual([
    "凭据文件：凭据文件须只有 1 个 profile（当前 6 个）",
  ]);
  for (const [field, value, reason] of [
    ["name", "other", "凭据 profile 名称与配置不符"],
    ["mode", "StsToken", "凭据 profile 模式不是 AK"],
    ["region_id", "cn-hangzhou", "凭据 profile 地域与配置不符"],
    ["access_key_secret", "", "凭据 profile 缺少 AccessKey"],
  ] as const) {
    await writeFile(
      join(f.root, f.target.credential_file),
      JSON.stringify({ profiles: [{ ...profile, [field]: value }] }),
    );
    const results = await publicationPrecheck("fixture", f.root, f.execute);
    expect(results.find((r) => r.step === "credentials")?.detail).toBe(reason);
    expect(JSON.stringify(results)).not.toContain(f.secret);
  }
});

test("C-754: unusable configuration fields are named without their values", async () => {
  const f = await setup();
  await writeFile(
    join(f.root, "publish-targets.json"),
    JSON.stringify({
      fixture: { ...f.target, package_name: "1bad", region: "BAD REGION" },
    }),
  );
  const results = await publicationPrecheck("fixture", f.root, f.execute);
  expect(results[0]).toEqual({
    step: "configuration",
    ok: false,
    detail: "本项目发布配置字段不合格：region、package_name",
  });
  await writeFile(join(f.root, "publish-targets.json"), "{");
  expect(
    (await publicationPrecheck("fixture", f.root, f.execute))[0]?.detail,
  ).toBe("publish-targets.json 不是合法 JSON");
});

test("C-754: the approval precheck stages the attachment's own bytes", async () => {
  const f = await setup();
  await fileAttachmentStore(f.root).put(apkSha, apkBytes);
  const a = {
    id: "attachment-1",
    kind: "evidence",
    card_id: "C-1",
    sha256: apkSha,
    size: apkBytes.length,
    mime: "application/vnd.android.package-archive",
    uploaded_by: "human",
    storage_path: "",
    attach_to: { kind: "timeline_entry", id: "C-1#1" },
  } as Attachment;
  const check = approvalPrecheck(f.root, f.root, f.execute);
  expect(await check("fixture", a, url)).toEqual([]);
  // Concurrent prechecks of one project run one after another, each complete.
  expect(
    await Promise.all([check("fixture", a, url), check("fixture", a, url)]),
  ).toEqual([[], []]);
  expect(await check("fixture", { ...a, size: a.size + 1 }, url)).toEqual([
    "附件：附件读取失败或与登记的 SHA-256 不符",
  ]);
  expect(await check("other", a, url)).toEqual([
    "发布配置：publish-targets.json 没有本项目",
  ]);
});
