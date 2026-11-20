import { createHash } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { LaunchConfigError } from "@cardigan/roles";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { recordLaunchNotice } from "./launch-notice.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const changed = () =>
  new LaunchConfigError("invalid_config", "启动配置已变化，请重新预检");

/** Called under BEGIN IMMEDIATE, including on a same-ID retry. Only attest the exact installed file. */
function settle(
  store: Store,
  tx: StoreTransactionContext,
  path: string,
  disk: string,
) {
  const intent = store.database
    .prepare("SELECT * FROM launch_model_intents WHERE path=?")
    .get(path);
  if (!intent) return;
  const digest = hash(disk);
  if (digest === intent.after_hash) {
    recordLaunchNotice(
      store,
      tx,
      "launch_model_changed",
      String(intent.notice),
    );
  } else if (digest !== intent.before_hash) {
    throw new LaunchConfigError(
      "invalid_config",
      "换模中断后文件又被修改，无法核对知会；请先核对并恢复原备份或已预检版本",
    );
  }
  store.database
    .prepare("UPDATE launch_web_changes SET installed=? WHERE operation=?")
    .run(digest === intent.after_hash ? 1 : 0, String(intent.operation));
  store.database
    .prepare("DELETE FROM launch_model_intents WHERE path=?")
    .run(path);
}

export function readSettledModelFile(store: Store, path: string) {
  return store.uow.run((tx) => {
    const disk = readFileSync(path, "utf8");
    settle(store, tx, path, disk);
    return disk;
  });
}

export function publishModelFile(
  store: Store,
  path: string,
  temp: string,
  operation: string,
  original: string,
  candidate: string,
  secretsStillCurrent: () => boolean,
  notice: string,
  web?: {
    reserve: () => void;
    checkReferences: (tx: StoreTransactionContext) => void;
  },
) {
  // Commit a recoverable intent *before* replacing the file. A competing CLI
  // may retire an uninstalled intent; its original owner must then abort.
  store.uow.run((tx) => {
    const disk = readFileSync(path, "utf8");
    if (disk !== original) throw changed();
    settle(store, tx, path, disk);
    if (!web && !store.listProjects().length)
      throw new LaunchConfigError("invalid_config", "没有可记录换模知会的项目");
    web?.reserve();
    store.database
      .prepare(
        "INSERT INTO launch_model_intents(path, operation, before_hash, after_hash, notice) VALUES (?,?,?,?,?)",
      )
      .run(path, operation, hash(original), hash(candidate), notice);
  });
  const installed = store.uow.run((tx) => {
    const owner = store.database
      .prepare("SELECT operation FROM launch_model_intents WHERE path=?")
      .get(path);
    if (
      owner?.operation !== operation ||
      readFileSync(path, "utf8") !== original
    )
      throw changed();
    // Recheck the exact secret file validated by preflight immediately before rename.
    // No file was installed on mismatch: retire our own intent without a success notice.
    if (!secretsStillCurrent()) {
      store.database
        .prepare(
          "DELETE FROM launch_model_intents WHERE path=? AND operation=?",
        )
        .run(path, operation);
      return false;
    }
    web?.checkReferences(tx);
    renameSync(temp, path);
    settle(store, tx, path, candidate);
    return true;
  });
  if (!installed) throw changed();
}
