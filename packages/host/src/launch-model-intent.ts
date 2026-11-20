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
  readonly canAdoptCatalog: boolean;
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
  const current = store.database
    .prepare(
      "SELECT revision, pending_catalog IS NOT NULL AS pending FROM launch_catalog_generation WHERE singleton=1",
    )
    .get();
  if (revision !== Number(current?.revision ?? 0) || current?.pending)
    return false;
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
// Only accepted, selectable names leave the host process, never profiles or secrets.
function recordHostProfiles(
  store: Store,
  dir: string,
  revision: number,
  names: string,
) {
  store.database
    .prepare(
      `INSERT OR REPLACE INTO launch_host_profiles(singleton,revision,directory,names) VALUES (1,?,?,?)`,
    )
    .run(revision, realpathSync(dir), names);
}
/** Called again under the employee write lock. Undefined means no host has ever
 * adopted a generation in this store; an empty list must NOT fall back to disk. */
export function acceptedHostProfiles(store: Store): string[] | undefined {
  const row = store.database
    .prepare(
      "SELECT revision,directory,names FROM launch_host_profiles WHERE singleton=1",
    )
    .get();
  if (!row) return undefined;
  return isAcceptedLaunchRevision(
    store,
    String(row.directory),
    Number(row.revision),
  )
    ? (JSON.parse(String(row.names)) as string[])
    : [];
}
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
      `INSERT INTO launch_catalog_generation(singleton,revision,files) VALUES (1,1,?) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1,files=excluded.files,installed_catalog_file=NULL`,
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

// SQLite is authoritative. A crash on either side of rename leaves this same
// bounded projection pending. Retrying it never advances the revision twice.
function settleCatalog(store: Store, dataDir: string) {
  const pending = store.database
    .prepare(
      "SELECT pending_catalog FROM launch_catalog_generation WHERE singleton=1",
    )
    .get()?.pending_catalog;
  if (typeof pending !== "string") return;
  installCatalog(dataDir, pending);
  store.database
    .prepare(
      "UPDATE launch_catalog_generation SET pending_catalog=NULL,installed_catalog_file=? WHERE singleton=1",
    )
    .run(catalogStamp(dataDir));
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
    const revision = accept(store, dirname(path));
    if (typeof intent.host_profiles === "string")
      recordHostProfiles(store, dirname(path), revision, intent.host_profiles);
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
    settleCatalog(store, dataDir);
    settle(store, tx, path, dataDir, false);
    const accepted = store.database
      .prepare(
        "SELECT revision,files,installed_catalog_file FROM launch_catalog_generation WHERE singleton=1",
      )
      .get();
    const catalogFile = catalogStamp(dataDir),
      files = launchFilesStamp(dir);
    return read({
      canAdoptCatalog:
        catalogFile !== "" &&
        accepted?.files === files &&
        accepted.installed_catalog_file === catalogFile,
      catalogFile,
      files,
      revision: Number(accepted?.revision ?? 0),
    });
  });
}

export function assertLaunchFence(
  store: Store,
  dir: string,
  dataDir: string,
  fence: LaunchFence,
) {
  if (
    fence.files !== launchFilesStamp(dir) ||
    fence.catalogFile !== catalogStamp(dataDir) ||
    fence.revision !== launchRevision(store)
  )
    throw changed();
}

function commitGeneration<T>(
  store: Store,
  dir: string,
  fence: LaunchFence,
  dataDir: string,
  install: (tx: StoreTransactionContext) => T,
) {
  return store.uow.run((tx) => {
    assertLaunchFence(store, dir, dataDir, fence);
    return install(tx);
  });
}
/** Adopt a previously installed projection, without treating it as a refresh candidate. */
export function adoptInstalledCatalog(
  store: Store,
  dir: string,
  dataDir: string,
  fence: LaunchFence,
  hostProfiles: string[],
) {
  if (!fence.canAdoptCatalog) throw changed();
  return commitGeneration(store, dir, fence, dataDir, () => {
    recordHostProfiles(
      store,
      dir,
      fence.revision,
      JSON.stringify(hostProfiles),
    );
    return fence.revision;
  });
}
export function publishLaunchRefresh(
  store: Store,
  dir: string,
  dataDir: string,
  fence: LaunchFence,
  {
    catalog,
    reload,
    hostProfiles,
  }: {
    catalog?: string | undefined;
    reload?: boolean;
    hostProfiles?: string[];
  },
) {
  const revision = commitGeneration(store, dir, fence, dataDir, () => {
    if (reload) {
      const now = new Date();
      utimesSync(join(dir, "launch.yaml"), now, now);
    }
    const accepted = store.database
      .prepare(
        "SELECT files,installed_catalog_file FROM launch_catalog_generation WHERE singleton=1",
      )
      .get();
    const next =
      reload ||
      catalog !== undefined ||
      accepted?.files !== fence.files ||
      (accepted.installed_catalog_file !== null &&
        accepted.installed_catalog_file !== fence.catalogFile)
        ? accept(store, dir)
        : fence.revision;
    if (catalog !== undefined)
      store.database
        .prepare(
          "UPDATE launch_catalog_generation SET pending_catalog=? WHERE singleton=1",
        )
        .run(catalog);
    if (hostProfiles)
      recordHostProfiles(store, dir, next, JSON.stringify(hostProfiles));
    return next;
  });
  if (catalog !== undefined)
    store.uow.run(() => {
      if (launchRevision(store) !== revision) throw changed();
      settleCatalog(store, dataDir);
    });
  return revision;
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
    hostProfiles: string[];
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
        "INSERT INTO launch_model_intents(path,operation,before_hash,after_hash,notice,catalog,host_profiles) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        path,
        operation,
        hash(original),
        hash(candidate),
        notice,
        catalog ?? null,
        web ? JSON.stringify(web.hostProfiles) : null,
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
