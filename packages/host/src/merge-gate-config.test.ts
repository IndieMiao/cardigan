import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadMergeGateConfig } from "./merge-gate-config.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(source?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "cg-gate-config-"));
  roots.push(root);
  const file = join(root, "merge-gate.yaml");
  if (source !== undefined)
    await writeFile(
      file,
      typeof source === "string" ? source : JSON.stringify(source),
      { mode: 0o600 },
    );
  const load = () =>
    loadMergeGateConfig({
      env: { CARDIGAN_CONFIG_DIR: root },
      projectIds: ["p", "q"],
    });
  return { root, file, load };
}
const valid = { checks: [{ name: "test", run: "pnpm test" }] };
test("missing configuration preserves legacy behavior; enabled projects get bounded defaults and explicit env", async () => {
  const f = await fixture();
  expect((await f.load()).forProject("p")).toEqual({ status: "disabled" });
  await writeFile(
    f.file,
    JSON.stringify({
      projects: {
        p: { ...valid, env: { CI: "yes" } },
        q: {
          checks: [{ name: "build", run: "pnpm build", timeout_minutes: 2 }],
          total_timeout_minutes: 5,
        },
      },
    }),
    { mode: 0o600 },
  );
  const config = await f.load();
  expect(config.errors).toEqual([]);
  expect(config.forProject("p")).toEqual({
    status: "enabled",
    checks: [{ name: "test", run: "pnpm test", timeoutMs: 1800000 }],
    env: { CI: "yes" },
    totalTimeoutMs: 3600000,
  });
  expect(config.forProject("q")).toMatchObject({
    totalTimeoutMs: 300000,
    checks: [{ timeoutMs: 120000 }],
  });
  expect(config.forProject("unconfigured")).toEqual({ status: "disabled" });
});
test.each([
  { checks: [] },
  { checks: [{ name: "test", run: " " }] },
  { checks: [{ name: "test", run: "true", timeout_minutes: 0 }] },
  { checks: [{ name: "test", run: "true", timeout_minutes: 1.5 }] },
  { ...valid, total_timeout_minutes: "60" },
  { ...valid, total_timeout_minutes: 100000000 },
  { checks: [valid.checks[0], valid.checks[0]] },
  { ...valid, push: { remote: "ignored" } },
  { ...valid, env: { SECRET: false } },
  { ...valid, env: { HOME: "/host" } },
  { ...valid, env: { TMPDIR: "/outside" } },
  { ...valid, env: { HC_SESSION: "production" } },
  { ...valid, env: { CARDIGAN_TOKEN: "sensitive-value" } },
])(
  "invalid project config stays blocked without disabling other projects: %j",
  async (bad) => {
    const f = await fixture({ projects: { p: bad, q: valid } }),
      config = await f.load();
    expect(config.forProject("p").status).toBe("invalid");
    expect(config.forProject("q").status).toBe("enabled");
    expect(config.forProject("absent").status).toBe("disabled");
    expect(config.errors.join(" ")).not.toContain("sensitive-value");
  },
);
test.each([
  "projects: [",
  "projects: {}\nprojects: {}",
  "projects: !unknown-tag {p: secret-value}",
  "not_projects: {}",
  "projects: &a {p: *a}",
  "projects: !!set {p: null}",
])(
  "invalid document fails closed, including future projects, without echoing source: %s",
  async (source) => {
    const f = await fixture(source),
      config = await f.load();
    expect(config.forProject("p").status).toBe("invalid");
    expect(config.forProject("future").status).toBe("invalid");
    expect(config.errors.join(" ")).not.toContain("secret-value");
  },
);
test("unknown projects report invalid configuration; symlink or writable configuration fails closed", async () => {
  const f = await fixture({ projects: { missing: valid, p: valid } });
  expect((await f.load()).forProject("missing").status).toBe("invalid");
  await chmod(f.file, 0o666);
  expect((await f.load()).forProject("p").status).toBe("invalid");
  await rm(f.file);
  const other = join(f.root, "other");
  await mkdir(other);
  await writeFile(
    join(other, "config"),
    JSON.stringify({ projects: { p: valid } }),
  );
  await symlink(join(other, "config"), f.file);
  expect((await f.load()).forProject("p").status).toBe("invalid");
});
