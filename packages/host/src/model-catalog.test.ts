import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  adoptInstalledCatalog,
  publishLaunchRefresh,
  withLaunchSnapshot,
} from "./launch-model-intent.js";
import {
  parseCachedLaunchConfig,
  stageModelLaunchConfig,
} from "./model-catalog.js";

const fixture = {
  native: {
    env: ["not-metadata"],
    models: {
      v1: {
        limit: { context: 8000, output: 500 },
        cost: { input: 0.5, output: 1.5 },
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        extra: "not-metadata",
      },
    },
  },
  other: { models: { v1: { limit: { context: 1000, output: 100 } } } },
};
const config = {
  providers: {
    relay: { harness: "codex", secret_env: { RELAY_KEY: "private-ref" } },
  },
  models: {
    active: { id: "v1", provider: "relay", catalog_provider: "native" },
  },
  profiles: { coder: { harness: "codex", model: "active" } },
};
const now = () => new Date("2026-01-01T00:00:00Z");
const stale = () => new Date("2026-01-03T00:00:00Z");
let dir: string;
let store: Store;
// Exercise the actual publisher; projection/validation by itself is read-only.
async function loadModelLaunchConfig(
  ...args: Parameters<typeof stageModelLaunchConfig>
) {
  const fence = withLaunchSnapshot(store, dir, dir, (f) => f);
  const staged = await stageModelLaunchConfig(...args);
  publishLaunchRefresh(store, dir, dir, fence, { catalog: staged.catalog });
  return staged.config;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "model-catalog-"));
  store = Store.open({ dataDir: dir });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test.each(["launch.yaml", "secrets.env", "models-dev.json"])(
  "replacing %s invalidates both the stored adoption proof and an in-flight adoption",
  async (filename) => {
    await writeFile(join(dir, "launch.yaml"), JSON.stringify(config));
    await writeFile(join(dir, "secrets.env"), "private-ref=fixture", {
      mode: 0o600,
    });
    await loadModelLaunchConfig(config, dir, {
      now,
      fetch: async () => Response.json(fixture),
    });
    const snapshot = () => withLaunchSnapshot(store, dir, dir, (f) => f);
    const installed = snapshot();
    expect(installed.canAdoptCatalog).toBe(true);
    const path = join(dir, filename);
    await writeFile(`${path}.new`, await readFile(path), { mode: 0o600 });
    await rename(`${path}.new`, path);
    expect(snapshot()).toMatchObject({
      revision: installed.revision,
      canAdoptCatalog: false,
    });
    expect(() =>
      adoptInstalledCatalog(store, dir, dir, installed, ["coder"]),
    ).toThrow();
    expect(
      store.database.prepare("SELECT revision FROM launch_host_profiles").all(),
    ).toEqual([]);
  },
);

test("fetches only the public catalog, caches a dated projection, and reuses it offline", async () => {
  const fetch = vi.fn(async () => Response.json(fixture));
  const online = await loadModelLaunchConfig(config, dir, { now, fetch });
  expect(fetch).toHaveBeenCalledWith("https://models.dev/api.json", {
    signal: expect.any(AbortSignal),
    redirect: "error",
    credentials: "omit",
  });
  expect(online.models?.active).toMatchObject({
    cost: { input: 0.5, output: 1.5 },
    context_window: 8000,
    max_output_tokens: 500,
    reasoning_efforts: ["low", "high"],
  });
  const cache = join(dir, "models-dev.json");
  const text = await readFile(cache, "utf8");
  expect(JSON.parse(text).fetched_at).toBe(now().toISOString());
  expect(text).not.toMatch(/not-metadata|private-ref|RELAY_KEY|active/);
  expect((await stat(cache)).mode & 0o777).toBe(0o600);
  const offline = vi.fn(async () => {
    throw new Error("offline");
  });
  await expect(
    loadModelLaunchConfig(config, dir, { now, fetch: offline }),
  ).resolves.toEqual(online);
  expect(offline).not.toHaveBeenCalled();
  await expect(
    loadModelLaunchConfig(config, dir, { now: stale, fetch: offline }),
  ).resolves.toEqual(online);
  expect(offline).toHaveBeenCalledOnce();
  for (const bad of [
    new Response("invalid"),
    Response.json({ error: "bad catalog" }),
    new Response(null, { status: 503 }),
  ]) {
    await expect(
      loadModelLaunchConfig(config, dir, {
        now: stale,
        fetch: async () => bad,
      }),
    ).resolves.toEqual(online);
  }
  const limited = await loadModelLaunchConfig(
    { ...config, model_catalog: { max_bytes: 1 } },
    dir,
    { now: stale, fetch: async () => Response.json(fixture) },
  );
  expect(limited.models).toEqual(online.models);
  expect(await readFile(cache, "utf8")).toBe(text);
  expect(parseCachedLaunchConfig(config, dir)).toEqual(online);
});

test("local fields win independently; cold/offline relay models need their own window", async () => {
  const active = {
    ...config.models.active,
    context_window: 12000,
    reasoning_efforts: ["low"],
  };
  const local = { ...config, models: { active } };
  const loaded = await loadModelLaunchConfig(local, dir, {
    fetch: async () => Response.json(fixture),
  });
  expect(loaded.models?.active).toMatchObject({
    context_window: 12000,
    max_output_tokens: 500,
    reasoning_efforts: ["low"],
  });
  // A model from another upstream must not supply a relay's window by name alone.
  expect(() =>
    parseCachedLaunchConfig(
      { ...config, models: { active: { id: "v1", provider: "relay" } } },
      dir,
    ),
  ).toThrow();
  await writeFile(join(dir, "models-dev.json"), "broken cache");
  const fetch = vi.fn(async () => new Response(null, { status: 503 }));
  await expect(
    loadModelLaunchConfig(config, dir, { fetch }),
  ).rejects.toMatchObject({
    details: [expect.stringContaining("models.active.context_window")],
  });
  expect(
    (await loadModelLaunchConfig(local, dir, { fetch })).models?.active,
  ).toMatchObject(active);
});

test("legacy profiles need neither a model catalog nor a network request", async () => {
  const fetch = vi.fn();
  await loadModelLaunchConfig(
    { profiles: { p: { harness: "pi", model: "raw-id" } } },
    dir,
    { fetch },
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("partial metadata complements local fields and enforces known effort", async () => {
  const local = {
    ...config,
    models: { active: { ...config.models.active, context_window: 12345 } },
  };
  for (const context of [undefined, 0]) {
    const fetch = async () =>
      Response.json({
        native: {
          models: {
            v1: {
              limit: { context, output: 1500 },
              reasoning_options: [{ type: "effort", values: ["low", "high"] }],
            },
          },
        },
      });
    expect(
      (await loadModelLaunchConfig(local, dir, { fetch })).models?.active,
    ).toMatchObject({
      context_window: 12345,
      max_output_tokens: 1500,
      reasoning_efforts: ["low", "high"],
    });
    expect(() =>
      parseCachedLaunchConfig(
        {
          ...local,
          profiles: { coder: { ...config.profiles.coder, effort: "other" } },
        },
        dir,
      ),
    ).toThrow();
  }
});

test("damaged fields recover only from the same row, preserving the good offline cache", async () => {
  const cache = join(dir, "models-dev.json");
  const changed = {
    ...config,
    models: { active: { ...config.models.active, id: "v2" } },
  };
  for (const v1 of [
    { limit: { context: 0, output: 501 } },
    {
      limit: { context: 8000, output: 501 },
      reasoning_options: [{ type: "effort", values: [] }],
    },
  ]) {
    await rm(cache, { force: true });
    await loadModelLaunchConfig(config, dir, {
      now,
      fetch: async () => Response.json(fixture),
    });
    const result = await loadModelLaunchConfig(changed, dir, {
      now: stale,
      fetch: async () =>
        Response.json({
          native: { models: { v1, v2: { limit: { context: 8192 } } } },
        }),
    });
    expect(result.models?.active.context_window).toBe(8192);
    expect(parseCachedLaunchConfig(changed, dir)).toEqual(result);
    expect(JSON.parse(await readFile(cache, "utf8")).fetched_at).toBe(
      now().toISOString(),
    );
    expect(parseCachedLaunchConfig(config, dir).models?.active).toMatchObject({
      context_window: 8000,
      max_output_tokens: 501,
    });
    if ("reasoning_options" in v1)
      expect(
        parseCachedLaunchConfig(config, dir).models?.active.reasoning_efforts,
      ).toEqual(["low", "high"]);
    const offline = vi.fn(async () => new Response(null, { status: 503 }));
    expect(
      await loadModelLaunchConfig(changed, dir, { now: stale, fetch: offline }),
    ).toEqual(result);
    expect(offline).toHaveBeenCalledOnce(); // recovered fields have not become fresh
  }
  const saved = await readFile(cache, "utf8");
  // A healthy response without the model is not a transient damaged row.
  await expect(
    loadModelLaunchConfig(config, dir, {
      now: stale,
      fetch: async () =>
        Response.json({
          native: { models: { v2: { limit: { context: 9000 } } } },
        }),
    }),
  ).rejects.toMatchObject({
    details: [expect.stringContaining("models.active.context_window")],
  });
  expect(await readFile(cache, "utf8")).toBe(saved);
});

test("enforces exact cache bytes independently on projection, publication and both read paths", async () => {
  const online = async () => Response.json(fixture);
  const good = await loadModelLaunchConfig(config, dir, { now, fetch: online });
  const cache = join(dir, "models-dev.json");
  const saved = await readFile(cache, "utf8");
  const localized = {
    ...config,
    models: { active: { ...config.models.active, context_window: 321 } },
  };
  const bounded = (cache_max_bytes: number) => ({
    ...localized,
    model_catalog: { cache_max_bytes },
  });
  const exact = Buffer.byteLength(saved);
  await rm(cache);
  await loadModelLaunchConfig(bounded(exact), dir, { now, fetch: online });
  expect(await readFile(cache, "utf8")).toBe(saved);
  expect(
    parseCachedLaunchConfig(bounded(exact), dir).models?.active
      .max_output_tokens,
  ).toBe(500);
  const expanded = {
    ...fixture,
    ["中".repeat(20)]: {
      models: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [i, { limit: { context: 1 } }]),
      ),
    },
  };
  await loadModelLaunchConfig(bounded(exact), dir, {
    now: stale,
    fetch: async () => Response.json(expanded),
  });
  expect(await readFile(cache, "utf8")).toBe(saved);
  expect(parseCachedLaunchConfig(config, dir)).toEqual(good);
  const offline = vi.fn(async () => new Response(null, { status: 503 }));
  for (const result of [
    parseCachedLaunchConfig(bounded(exact - 1), dir),
    await loadModelLaunchConfig(bounded(exact - 1), dir, {
      now,
      fetch: offline,
    }),
  ]) {
    expect(result.models?.active.context_window).toBe(321);
    expect(result.models?.active.max_output_tokens).toBeUndefined();
  }
  expect(offline).toHaveBeenCalledOnce();
  await rm(cache);
  await loadModelLaunchConfig(bounded(exact - 1), dir, { now, fetch: online });
  await expect(stat(cache)).rejects.toMatchObject({ code: "ENOENT" });
});

test("C-564: the picker reads a fresh cache as is, refreshes a stale one without writing it, and falls back on failure", async () => {
  const { readModelCatalog } = await import("./model-catalog.js");
  const cacheFile = join(dir, "models-dev.json");
  await writeFile(
    cacheFile,
    JSON.stringify({
      fetched_at: now().toISOString(),
      entries: [{ provider: "native", id: "old", context_window: 1 }],
    }),
  );
  const network = vi.fn(async () => Response.json(fixture));
  const fresh = await readModelCatalog(dir, {}, { fetch: network, now });
  expect(fresh).toMatchObject({ fresh: true, entries: [{ id: "old" }] });
  expect(network).not.toHaveBeenCalled();
  const before = await readFile(cacheFile, "utf8");
  const refreshed = await readModelCatalog(
    dir,
    {},
    { fetch: network, now: stale },
  );
  expect(refreshed?.fresh).toBe(true);
  expect(refreshed?.fetched_at).toBe(stale().toISOString());
  expect(refreshed?.entries.map((e) => `${e.provider}/${e.id}`)).toEqual([
    "native/v1",
    "other/v1",
  ]);
  expect(await readFile(cacheFile, "utf8")).toBe(before);
  const failing = vi.fn(async () => new Response("", { status: 503 }));
  expect(
    await readModelCatalog(dir, {}, { fetch: failing, now: stale }),
  ).toMatchObject({ fresh: false, entries: [{ id: "old" }] });
  await rm(cacheFile);
  expect(
    await readModelCatalog(dir, {}, { fetch: failing, now: stale }),
  ).toBeUndefined();
});

test("C-564: a refresh that keeps a field from the older cache is not fresh", async () => {
  const { readModelCatalog } = await import("./model-catalog.js");
  await writeFile(
    join(dir, "models-dev.json"),
    JSON.stringify({
      fetched_at: now().toISOString(),
      entries: [{ provider: "native", id: "v1", context_window: 8000 }],
    }),
  );
  const broken = structuredClone(fixture) as Record<string, unknown>;
  (
    (broken.native as { models: Record<string, { limit: unknown }> }).models
      .v1 as { limit: unknown }
  ).limit = { context: "bad", output: 500 };
  const snapshot = await readModelCatalog(
    dir,
    {},
    { fetch: vi.fn(async () => Response.json(broken)), now: stale },
  );
  expect(snapshot?.fresh).toBe(false);
  expect(snapshot?.fetched_at).toBe(now().toISOString());
  expect(snapshot?.entries.find((e) => e.id === "v1")?.context_window).toBe(
    8000,
  );
});
