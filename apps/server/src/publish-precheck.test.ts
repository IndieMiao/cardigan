import { randomUUID } from "node:crypto";
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
import { afterEach, expect, test, vi } from "vitest";
import { formatPrecheck, publicationPrecheck } from "./publish-precheck.js";

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
  const flags = { versioning: "<VersioningConfiguration/>", denied: "" };
  const execute = vi.fn(
    async (
      tool: string,
      args: string[],
      _cwd: string,
      environment?: Record<string, string>,
    ) => {
      expect(args.join(" ")).not.toContain(secret);
      if (tool !== target.ossutil) expect(environment).toBeUndefined();
      if (args[0] !== "api") return "version\n";
      expect(environment?.OSS_ACCESS_KEY_SECRET === secret).toBe(true);
      if (args[1] === flags.denied) throw Error("AccessDenied private detail");
      if (args[1] === "get-bucket-versioning")
        return `${flags.versioning}\n0.1(s) elapsed\n`;
      if (args[1] === "list-objects-v2") {
        expect(args[args.indexOf("--prefix") + 1]).toBe("fixture/test/");
        return JSON.stringify({ KeyCount: "0", IsTruncated: "false" });
      }
      throw Error(`unexpected ${args[1]}`);
    },
  );
  return { root, target, flags, execute };
}

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
    results
      .filter((r) => r.ok === false)
      .map((r) => [r.step, r.detail !== undefined]),
  ).toEqual([
    ["get_bucket_versioning", true],
    ["list_objects", false],
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
  expect(none[0]).toEqual({ step: "configuration", ok: false });
  expect(none.slice(1).every((r) => r.ok === "skipped")).toBe(true);
  expect(f.execute.mock.calls.some(([, args]) => args[0] === "api")).toBe(
    false,
  );
});
