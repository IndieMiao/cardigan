// C-549 state matrix (C-549#263/#264/#267): one secrets confirmation in an
// independent process that exits (or pauses) at a chosen point, so recovery
// runs in another process against what is actually on disk and in SQLite.
// Synthetic values only; the directory and database are the test's own.

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Store } from "@cardigan/store";
import { LaunchSettings } from "../dist/web/launch-settings.js";

const [dir, dataDir, mode, changeJson, valuesJson, replayJson] =
  process.argv.slice(2);
const store = Store.open({ dataDir });
const crash = () => process.exit(73);
const isStaging = (path) => String(path).includes("/.secrets-staging/");
const secretsTarget = (path) => String(path).endsWith("/secrets.env");
const yamlBackup = (path) => /\/launch\.yaml\.[^/]+\.bak$/u.test(String(path));

const { mkdirSync, writeFileSync, renameSync, readFileSync, rmSync } = fs;
const ownStagingDir = (path) =>
  /\/\.secrets-staging\/[^/]+$/u.test(String(path));
fs.mkdirSync = (path, opts) => {
  const own = isStaging(path) && !String(path).endsWith(".secrets-staging");
  if (own && mode === "exit-before-mkdir") crash();
  try {
    const result = mkdirSync(path, opts);
    if (own && mode === "exit-after-mkdir") crash();
    return result;
  } catch (error) {
    if (own && mode === "occupied-exit") crash();
    throw error;
  }
};
fs.writeFileSync = (path, data, opts) => {
  const p = String(path);
  if (
    (mode === "short-temp" && isStaging(p) && p.endsWith("/secrets.env")) ||
    (mode === "short-backup" && isStaging(p) && p.endsWith("/backup"))
  ) {
    writeFileSync(path, String(data).slice(0, 7), opts);
    crash();
  }
  if (
    mode === "short-temp-exit-at-drop" &&
    isStaging(p) &&
    p.endsWith("/secrets.env")
  ) {
    writeFileSync(path, String(data).slice(0, 7), opts);
    throw Object.assign(new Error("fixture: ENOSPC"), { code: "ENOSPC" });
  }
  if (mode === "exit-at-cleanup" && isStaging(p) && p.endsWith("/cleanup")) {
    writeFileSync(path, data, opts);
    crash();
  }
  if (yamlBackup(p) && mode === "exit-before-yaml") crash();
  if (yamlBackup(p) && mode === "pause-before-yaml") {
    process.send({ paused: true });
    readFileSync(`${dir}/release.fifo`); // synchronous barrier, no lock held
  }
  return writeFileSync(path, data, opts);
};
fs.renameSync = (from, to) => {
  if (secretsTarget(to) && isStaging(from) && mode === "exit-before-rename")
    crash();
  const result = renameSync(from, to);
  if (secretsTarget(to) && isStaging(from) && mode === "exit-after-rename")
    crash();
  return result;
};
fs.rmSync = (path, opts) => {
  if (mode === "short-temp-exit-at-drop" && ownStagingDir(path)) crash();
  return rmSync(path, opts);
};
syncBuiltinESMExports();
globalThis.fetch = async () => {
  throw new Error("fixture: no network");
};

const manager = new LaunchSettings(
  store,
  dir,
  dataDir,
  () => ({}),
  () => {},
);
const owner = "child-session";
try {
  if (mode === "replay") {
    const { preview_id, version, key, session } = JSON.parse(replayJson);
    try {
      await manager.confirm(
        { version, preview_id },
        key,
        session ?? owner,
        () => ({}),
      );
      process.send({ ok: true });
    } catch (error) {
      process.send({ code: error.code ?? "error" });
    }
  } else {
    const { version } = await manager.read();
    const preview = manager.preview(
      { version, change: JSON.parse(changeJson) },
      owner,
    );
    // Delivered before any exit point can be reached.
    await new Promise((resolve) =>
      process.send({ preview_id: preview.preview_id, version }, resolve),
    );
    if (mode === "occupied-exit") {
      const staging = `${fs.realpathSync(dir)}/.secrets-staging`;
      mkdirSync(`${staging}/${preview.preview_id}`, { recursive: true });
      writeFileSync(`${staging}/${preview.preview_id}/keep.txt`, "keep");
    }
    try {
      await manager.confirm(
        {
          version,
          preview_id: preview.preview_id,
          secrets: JSON.parse(valuesJson),
        },
        "child-key",
        owner,
        () => ({}),
      );
      process.send({ ok: true });
    } catch (error) {
      process.send({ code: error.code ?? "error" });
    }
  }
} finally {
  store.close();
  process.disconnect();
}
