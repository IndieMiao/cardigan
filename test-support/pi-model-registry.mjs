// Optional offline compatibility check. Pass the root of an installed Pi 1.4.0
// SDK; no project dependency, user config, model request or harness login.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compileAssignmentLaunch,
  compileLaunch,
  parseLaunchConfig,
} from "../packages/roles/dist/index.js";

if (!process.argv[2]) throw new Error("Pass the Pi 1.4.0 package directory");
const sdk = resolve(process.argv[2]);
const pkg = JSON.parse(await readFile(join(sdk, "package.json"), "utf8"));
assert.equal(pkg.name, "@earendil-works/pi-coding-agent");
assert.equal(pkg.version, "1.4.0");
const root = await mkdtemp(join(tmpdir(), "lp1-pi-registry-"));
try {
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = root;
  const load = (file) =>
    import(pathToFileURL(join(sdk, "dist/core", file)).href);
  const { ModelConfig } = await load("model-config.js");
  const { composeModelProvider } = await load("provider-composer.js");
  const base = "https://relay.example.invalid/v1";
  const config = parseLaunchConfig({
    providers: {
      relay: {
        api: "openai-responses",
        base_url: base,
        secret_env: { RELAY_KEY: "FIXTURE" },
      },
    },
    models: {
      active: { id: "concrete-model", provider: "relay", context_window: 8192 },
    },
    profiles: {
      p: { harness: "pi", model: "active", provider_flag: "private-pi" },
    },
  });
  const secrets = { FIXTURE: "fixture-only-value" };
  for (const launch of [
    compileLaunch({ config, profile: "p", runtimeDir: root, secrets }),
    compileAssignmentLaunch({
      assignment: {
        assignment_id: "A-1",
        run_id: "R-1",
        card_id: "C-1",
        work_item_id: "W-1",
        project_id: "fixture",
      },
      role: {
        role_id: "coder",
        harness: "pi",
        launch_profile: "p",
        worktree: "write",
        allowed_tools: [],
      },
      launch: config,
      mcp: { url: "https://fixture.invalid/mcp" },
      run_dir: join(root, "run"),
      work_dir: root,
      first_prompt: "fixture",
      secrets,
    }),
  ]) {
    const path = join(launch.env.PI_CODING_AGENT_DIR, "models.json");
    const file = launch.files.find((f) => f.path === path);
    assert.ok(file && !file.content.includes(secrets.FIXTURE));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.content, { mode: file.mode, flag: "wx" });
    const config = await ModelConfig.load(path);
    assert.equal(config.getError(), undefined);
    const flag = (name) => launch.args[launch.args.indexOf(name) + 1];
    const provider = composeModelProvider(
      flag("--provider"),
      undefined,
      config,
      undefined,
    );
    const model = provider.getModels().find((m) => m.id === flag("--model"));
    assert.deepEqual(
      [model?.provider, model?.id, model?.baseUrl, model?.contextWindow],
      ["private-pi", "concrete-model", base, 8192],
    );
    const env = { ...launch.env, ...launch.secret_env };
    const auth = await provider.auth.apiKey.resolve({
      ctx: { env: async (name) => env[name] },
    });
    assert.equal(auth.auth.apiKey, secrets.FIXTURE);
  }
  console.log(
    "Pi 1.4.0: direct and Assignment model registry and credential-reference checks passed (offline).",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
