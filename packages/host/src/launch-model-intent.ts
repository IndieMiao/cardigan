import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LaunchConfigError } from "@cardigan/roles";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { launchFilesStamp } from "./launch-files-stamp.js";
import { recordLaunchNotice } from "./launch-notice.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const changed = () =>
  new LaunchConfigError("invalid_config", "启动配置已变化，请重新预检");
export interface LaunchFence {
  catalogFile: string;
  files: string;
  revision: number;
}
export function launchRevision(store: Store) {
  return Number(
    store.database
      .prepare(
        "SELECT revision FROM launch_catalog_generation WHERE singleton=1",
      )
      .get()?.revision ?? 0,
  );
}
/** A completed filesystem rename is visible before the SQLite commit. During that
 * narrow recovery window no reference may be authorized from stale process memory.
 * An abandoned reservation before rename does not invalidate the accepted config. */
export function isAcceptedLaunchRevision(
  store: Store,
  dir: string,
  revision: number | undefined,
) {
  if (revision !== launchRevision(store)) return false;
  const intents = store.database
    .prepare("SELECT path,before_hash FROM launch_model_intents")
    .all();
  if (!intents.length) return true;
  try {
    const path = join(realpathSync(dir), "launch.yaml");
    const pending = intents.find((i) => i.path === path);
    return !pending || hash(readFileSync(path, "utf8")) === pending.before_hash;
  } catch {
    return false;
  }
}
// Fence a cache-only refresh even if its process died between rename and SQL COMMIT.
function catalogStamp(dataDir: string) {
  const s = lstatSync(join(dataDir, "models-dev.json"), {
    bigint: true,
    throwIfNoEntry: false,
  });
  return s ? `${s.dev}:${s.ino}:${s.ctimeNs}:${s.size}` : "";
}
function accept(store: Store, dir: string) {
  store.database
    .prepare(
      `INSERT INTO launch_catalog_generation VALUES (1,1,?) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1,files=excluded.files`,
    )
    .run(launchFilesStamp(dir));
  return launchRevision(store);
}

// The only production writer of the shared projection. Always invoked under BEGIN IMMEDIATE.
function installCatalog(dataDir: string, text: string) {
  const target = join(dataDir, "models-dev.json");
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

// A process can die after the YAML rename but before SQLite commits. Roll forward the
// exact catalog that validated that YAML *before* attesting the receipt, even on GET.
function settle(
  store: Store,
  tx: StoreTransactionContext,
  path: string,
  dataDir: string,
  retire: boolean,
) {
  const intent = store.database
    .prepare("SELECT * FROM launch_model_intents WHERE path=?")
    .get(path);
  if (!intent) return;
  const digest = hash(readFileSync(path, "utf8"));
  const installed = digest === intent.after_hash;
  if (installed) {
    if (typeof intent.catalog === "string")
      installCatalog(dataDir, intent.catalog);
    accept(store, dirname(path));
    recordLaunchNotice(
      store,
      tx,
      "launch_model_changed",
      String(intent.notice),
    );
  } else {
    if (digest !== intent.before_hash) throw changed();
    if (!retire) return; // another process may be about to enter its install transaction
  }
  if (installed)
    store.database
      .prepare("UPDATE launch_web_changes SET installed=1 WHERE operation=?")
      .run(String(intent.operation));
  else
    store.database
      .prepare(
        "DELETE FROM launch_web_changes WHERE operation=? AND installed=0",
      )
      .run(String(intent.operation));
  store.database
    .prepare("DELETE FROM launch_model_intents WHERE path=?")
    .run(path);
}
export function withLaunchSnapshot<T>(
  store: Store,
  dir: string,
  dataDir: string,
  read: (fence: LaunchFence) => T,
) {
  return store.uow.run((tx) => {
    // The common case does not open a missing/unsafe YAML just to check for recovery.
    const path = join(realpathSync(dir), "launch.yaml");
    settle(store, tx, path, dataDir, false);
    return read({
      catalogFile: catalogStamp(dataDir),
      files: launchFilesStamp(dir),
      revision: launchRevision(store),
    });
  });
}

function commitGeneration<T>(
  store: Store,
  dir: string,
  fence: LaunchFence,
  dataDir: string,
  install: (tx: StoreTransactionContext) => T,
) {
  return store.uow.run((tx) => {
    if (
      fence.files !== launchFilesStamp(dir) ||
      fence.catalogFile !== catalogStamp(dataDir) ||
      fence.revision !== launchRevision(store)
    )
      throw changed();
    return install(tx);
  });
}
export function publishLaunchRefresh(
  store: Store,
  dir: string,
  dataDir: string,
  fence: LaunchFence,
  catalog?: string,
  reload = false,
) {
  return commitGeneration(store, dir, fence, dataDir, () => {
    if (catalog !== undefined) installCatalog(dataDir, catalog);
    if (reload) {
      const now = new Date();
      utimesSync(join(dir, "launch.yaml"), now, now);
    }
    const accepted = store.database
      .prepare("SELECT files FROM launch_catalog_generation WHERE singleton=1")
      .get();
    return reload || catalog !== undefined || accepted?.files !== fence.files
      ? accept(store, dir)
      : fence.revision;
  });
}
export function publishModelFile(
  store: Store,
  path: string,
  temp: string,
  operation: string,
  original: string,
  candidate: string,
  dataDir: string,
  fence: LaunchFence,
  catalog: string | undefined,
  notice: string,
  web?: {
    reserve: () => void;
    checkReferences: (tx: StoreTransactionContext) => void;
  },
) {
  const dir = dirname(path);
  commitGeneration(store, dir, fence, dataDir, (tx) => {
    if (readFileSync(path, "utf8") !== original || candidate === original)
      throw changed();
    settle(store, tx, path, dataDir, true);
    if (!web && !store.listProjects().length)
      throw new LaunchConfigError("invalid_config", "没有可记录换模知会的项目");
    web?.checkReferences(tx);
    web?.reserve();
    store.database
      .prepare(
        "INSERT INTO launch_model_intents(path,operation,before_hash,after_hash,notice,catalog) VALUES (?,?,?,?,?,?)",
      )
      .run(
        path,
        operation,
        hash(original),
        hash(candidate),
        notice,
        catalog ?? null,
      );
  });
  try {
    return commitGeneration(store, dir, fence, dataDir, (tx) => {
      const owner = store.database
        .prepare("SELECT operation FROM launch_model_intents WHERE path=?")
        .get(path);
      if (
        owner?.operation !== operation ||
        readFileSync(path, "utf8") !== original
      )
        throw changed();
      web?.checkReferences(tx);
      renameSync(temp, path);
      settle(store, tx, path, dataDir, true);
      return launchRevision(store);
    });
  } catch (error) {
    // Retire only *our* uninstalled reservation. Never erase crash-recovery evidence
    // after the rename or another writer's intent. Throw outside this cleanup UoW.
    store.uow.run((tx) => {
      const own = store.database
        .prepare("SELECT operation FROM launch_model_intents WHERE path=?")
        .get(path);
      if (
        own?.operation === operation &&
        readFileSync(path, "utf8") === original
      )
        settle(store, tx, path, dataDir, true);
    });
    throw error;
  }
}
