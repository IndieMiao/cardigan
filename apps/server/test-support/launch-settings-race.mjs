// Independent process: same private YAML, catalog and SQLite writer as the HTTP fixture.

import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mock } from "node:test";
import { Store } from "@cardigan/store";
import { loadConfig } from "../../cli/dist/config.js";
import { main } from "../../cli/dist/index.js";
import { reload, setModel } from "../../cli/dist/launch-manage.js";
import { resolveLaunchPaths } from "../../cli/dist/paths.js";
import { loadLaunchFiles } from "../dist/host.js";
import { LaunchSettings } from "../dist/web/launch-settings.js";

const [dir, dataDir, mode, publicationTime] = process.argv.slice(2);
// Recovery uses the parent clock: no file edits or sleeps to expire an installed projection.
if (publicationTime)
  mock.timers.enable({ apis: ["Date"], now: Number(publicationTime) });
const paths = resolveLaunchPaths({
  CARDIGAN_CONFIG_DIR: dir,
  CARDIGAN_DATA_DIR: dataDir,
});
const io = {
  env: { CARDIGAN_CONFIG_DIR: dir, CARDIGAN_DATA_DIR: dataDir },
  cwd: dir,
  platform: process.platform,
  stdout() {},
  stderr() {},
};
const store = Store.open({ dataDir });
const rename = fs.renameSync;
fs.renameSync = (src, dest) => {
  if (mode === "locked" && dest === join(dataDir, "models-dev.json")) {
    process.send("locked");
    fs.readFileSync(join(dir, "release.fifo")); // synchronous barrier while holding the actual SQLite write lock
  }
  rename(src, dest);
  if (mode === "crash" && dest === paths.launchFile) process.exit(73);
  if (
    ["catalog-crash", "reload-crash"].includes(mode) &&
    dest === join(dataDir, "models-dev.json")
  )
    process.exit(73);
};
syncBuiltinESMExports();
globalThis.fetch = async (url) => {
  if (url !== "https://models.dev/api.json")
    throw new Error("unexpected fixture request");
  if (mode === "removed-reload")
    return Response.json({
      gateway: { models: { other: { limit: { context: 4096 } } } },
    });
  if (mode.startsWith("employee-"))
    throw Error("hosted employee lookup must not fetch");
  if (
    !["locked", "crash", "delete", "catalog-crash", "reload-crash"].includes(
      mode,
    )
  ) {
    const resume = once(process, "message");
    process.send("fetching");
    await resume;
  }
  const id = mode === "set-model" ? "cli" : mode === "crash" ? "new" : "first";
  const models = Object.fromEntries(
    (mode === "locked" ? ["first", "new"] : [id]).map((key) => [
      key,
      { limit: { context: 12800 } },
    ]),
  );
  return Response.json({ gateway: { models } });
};
try {
  if (mode === "set-model") await setModel(paths, io, "primary", "cli");
  else if (mode === "removed-reload") {
    const errors = [];
    process.exitCode = await main(["launch", "reload"], {
      ...io,
      stderr: (text) => errors.push(text),
    });
    assert.match(errors.join("\n"), /models\.primary\.context_window/u);
  } else if (mode.startsWith("employee-")) {
    process.exitCode = await main(
      [
        "employee",
        "add",
        "--name",
        "Fixture",
        "--title",
        "Dev",
        "--role",
        "coder",
        "--launch-profile",
        mode.slice("employee-".length),
      ],
      io,
    );
  } else if (["reload", "reload-crash"].includes(mode)) await reload(paths, io);
  else if (mode === "read") await loadConfig(paths);
  else if (["crash", "delete", "late-delete"].includes(mode)) {
    const manager = new LaunchSettings(
      store,
      dir,
      dataDir,
      () => {},
      () => {},
    );
    const { version } = await manager.read();
    const preview = manager.preview(
      {
        version,
        change:
          mode === "crash"
            ? { op: "set_model", name: "primary", id: "new" }
            : { op: "delete_profile", name: "b" },
      },
      "test-session",
    );
    await manager.confirm(
      { version, preview_id: preview.preview_id },
      "fixture",
      "test-session",
      () => ({}),
    );
  } else await loadLaunchFiles(dir, () => {}, dataDir, store);
} catch (e) {
  if (mode === "late-delete" && e.code === "profile_in_use")
    process.exitCode = 43;
  else if (
    !["poll", "reload", "set-model"].includes(mode) ||
    !e.message.includes("重新预检")
  )
    throw e;
  else process.exitCode = 42;
} finally {
  store.close();
  process.disconnect();
}
