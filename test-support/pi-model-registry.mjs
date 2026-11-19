// Optional offline compatibility check. Pass the root of an installed Pi 1.4.0
// SDK; no project dependency, user config, model request or harness login.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
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
  const { parseArgs } = await load("../cli/args.js");
  const { getDefaultSessionDir } = await load("session-manager.js");
  const ai = dirname(
    findPackageJSON(
      "@earendil-works/pi-ai",
      pathToFileURL(join(sdk, "package.json")),
    ),
  );
  const { clampThinkingLevel, getSupportedThinkingLevels } = await import(
    pathToFileURL(join(ai, "dist/models.js")).href
  );
  const { deepseekProvider } = await import(
    pathToFileURL(join(ai, "dist/providers/deepseek.js")).href
  );
  const native = deepseekProvider();
  const id = native.getModels()[0].id;
  const base = "https://relay.example.invalid/v1";
  const secrets = { FIXTURE: "fixture-only-value" };
  function config(effort, levels) {
    return parseLaunchConfig({
      providers: {
        relay: {
          api: "openai-responses",
          base_url: base,
          secret_env: { RELAY_KEY: "FIXTURE" },
        },
      },
      models: {
        active: {
          id,
          provider: "relay",
          context_window: 8192,
          reasoning_efforts: levels,
        },
      },
      profiles: {
        p: {
          harness: "pi",
          model: "active",
          provider_flag: "deepseek",
          effort,
        },
      },
    });
  }
  function assignment(launch, run_id) {
    return compileAssignmentLaunch({
      assignment: { assignment_id: "A-1", run_id },
      role: {
        role_id: "coder",
        harness: "pi",
        launch_profile: "p",
        worktree: "write",
        allowed_tools: [],
      },
      launch,
      mcp: { url: "https://fixture.invalid/mcp" },
      run_dir: join(root, "run"),
      work_dir: root,
      first_prompt: "fixture",
      secrets,
    });
  }
  async function publish(launch) {
    // Match local publication: write this launch's files, leave everything else in place.
    for (const f of launch.files) {
      await mkdir(dirname(f.path), { recursive: true, mode: 0o700 });
      await writeFile(f.path, f.content, { mode: f.mode });
    }
    const flags = parseArgs(launch.args);
    assert.deepEqual(flags.diagnostics, []);
    const registry = await ModelConfig.load(
      join(launch.env.PI_CODING_AGENT_DIR, "models.json"),
    );
    assert.equal(registry.getError(), undefined);
    const provider = composeModelProvider(
      flags.provider,
      native,
      registry,
      undefined,
    );
    const model = provider.getModels().find((m) => m.id === flags.model);
    assert.ok(model);
    return { flags, provider, model };
  }
  const nativeConfig = parseLaunchConfig({
    profiles: { p: { harness: "pi", provider_flag: "deepseek", model: id } },
  });
  const legacy = assignment(nativeConfig, "R-3");
  const sessionDir = getDefaultSessionDir(root, legacy.env.PI_CODING_AGENT_DIR);
  const transcript = join(sessionDir, "keep.jsonl");
  await writeFile(transcript, "{}\n");
  for (const [index, [effort, levels]] of [
    ["xhigh", ["low", "high", "xhigh"]],
    ["high", undefined],
  ].entries()) {
    const c = config(effort, levels);
    const run = assignment(c, `R-${index + 1}`);
    assert.equal(run.env.PI_CODING_AGENT_SESSION_DIR, sessionDir);
    for (const launch of [
      compileLaunch({
        config: c,
        profile: "p",
        instanceId: String(index),
        runtimeDir: root,
        secrets,
      }),
      run,
    ]) {
      const file = launch.files.find(
        (f) => f.path === join(launch.env.PI_CODING_AGENT_DIR, "models.json"),
      );
      assert.ok(file && !file.content.includes(secrets.FIXTURE));
      const { flags, provider, model } = await publish(launch);
      assert.deepEqual(
        [
          flags.provider,
          flags.model,
          model.provider,
          model.id,
          model.baseUrl,
          model.contextWindow,
        ],
        ["deepseek", id, "deepseek", id, base, 8192],
      );
      assert.equal(flags.thinking, effort);
      assert.equal(clampThinkingLevel(model, flags.thinking), effort);
      assert.deepEqual(getSupportedThinkingLevels(model), levels ?? [effort]);
      const env = { ...launch.env, ...launch.secret_env };
      const auth = await provider.auth.apiKey.resolve({
        ctx: { env: async (name) => env[name] },
        signal: new AbortController().signal,
      });
      assert.equal(auth.auth.apiKey, secrets.FIXTURE);
    }
  }
  const previous = native.getModels().find((m) => m.id === id);
  assert.equal((await publish(legacy)).model.baseUrl, previous.baseUrl);
  assert.notEqual(previous.baseUrl, base);
  // A maintained registry is neither overwritten on inline startup nor deleted on return.
  const userPath = join(legacy.env.PI_CODING_AGENT_DIR, "models.json");
  const userBase = "https://maintained.example.invalid/v1";
  const userText = JSON.stringify({
    providers: { deepseek: { baseUrl: userBase } },
  });
  await writeFile(userPath, userText);
  await publish(assignment(config("high", ["high"]), "R-4"));
  assert.equal(
    (await publish(assignment(nativeConfig, "R-5"))).model.baseUrl,
    userBase,
  );
  assert.equal(await readFile(userPath, "utf8"), userText);
  assert.equal(await readFile(transcript, "utf8"), "{}\n");
  console.log(
    "Pi 1.4.0 offline: direct and Assignment routes, credentials, effective thinking, native switch-back, maintained registry and history passed.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
