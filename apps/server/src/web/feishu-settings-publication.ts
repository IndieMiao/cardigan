import { extFingerprints, loadExtMessageConfig } from "@cardigan/host";
import {
  activateExtChannels,
  extEventWatermark,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import { type FileState, readSettings, stale } from "./feishu-settings-file.js";
import { digest } from "./launch-settings-file.js";

/** A committed intent precedes rename. Only its owner may rename under the DB writer lock.
 * Recovery observes the file, never installs secrets left behind by an interrupted request. */
export class FeishuPublication {
  private scope: string;
  constructor(
    private store: Store,
    private path: string,
  ) {
    this.scope = digest(path);
  }
  private pending() {
    return this.store.database
      .prepare(
        "SELECT request_key, original, publication, watermark FROM feishu_settings_publications WHERE scope=?",
      )
      .get(this.scope);
  }
  private matches(f: FileState, publication: unknown) {
    const id = f.doc.get("settings_publication");
    return (
      typeof id === "string" &&
      !!f.yaml &&
      `${id}:${f.yaml.identity}` === publication
    );
  }
  installed(key: string) {
    const p = this.pending();
    return (
      p?.request_key === key &&
      this.matches(readSettings(this.path), p.publication)
    );
  }
  private finish(key: string, result: string) {
    const db = this.store.database;
    db.prepare(
      "UPDATE feishu_settings_requests SET result=? WHERE request_key=?",
    ).run(result, key);
    db.prepare(
      "DELETE FROM feishu_settings_publications WHERE scope=? AND request_key=?",
    ).run(this.scope, key);
  }
  // A read may settle a published intent; only a competing/replayed confirm may fence an unpublished one.
  settle(tx: StoreTransactionContext, fence: boolean | string) {
    const p = this.pending();
    if (!p) return;
    const f = readSettings(this.path);
    const key = String(p.request_key);
    if (this.matches(f, p.publication)) {
      const c = loadExtMessageConfig(this.path);
      if (
        c.status !== "loaded" ||
        c.publication !== p.publication ||
        readSettings(this.path).version !== f.version
      )
        throw stale();
      activateExtChannels(
        this.store.database,
        tx,
        extFingerprints(c, true),
        new Date().toISOString(),
        c.publication,
      );
      this.finish(key, "applied");
    } else if (fence === true || fence === key) {
      this.finish(
        key,
        f.version === p.original ? "not_applied" : "unconfirmed",
      );
    }
  }
  recover() {
    if (this.pending()) this.store.uow.run((tx) => this.settle(tx, false));
  }
  commit(
    key: string,
    f: FileState,
    publication: string,
    c: ReturnType<typeof loadExtMessageConfig>,
    reserve: () => void,
    authorize: () => void,
    install: () => void,
  ) {
    this.store.uow.run((tx) => {
      this.settle(tx, true);
      if (readSettings(this.path).version !== f.version) throw stale();
      reserve();
      this.store.database
        .prepare(
          "INSERT INTO feishu_settings_publications(scope,request_key,original,publication,watermark) VALUES(?,?,?,?,?)",
        )
        .run(
          this.scope,
          key,
          f.version,
          publication,
          extEventWatermark(this.store.database),
        );
    });
    try {
      this.store.uow.run((tx) => {
        authorize();
        const p = this.pending();
        if (
          p?.publication !== publication ||
          p.watermark !== extEventWatermark(this.store.database)
        )
          throw stale();
        activateExtChannels(
          this.store.database,
          tx,
          extFingerprints(c, true),
          new Date().toISOString(),
          publication,
        );
        this.finish(key, "applied");
        install();
      });
    } catch (e) {
      // A failed COMMIT after rename cannot undo the filesystem. The durable receipt and
      // exact installed inode prove publication, even if DB finalization must be retried.
      if (!this.matches(readSettings(this.path), publication)) {
        this.store.uow.run((tx) => this.settle(tx, key));
        throw e;
      }
      try {
        this.recover();
      } catch {
        /* The intent stays fenced until reconciliation succeeds. */
      }
    }
  }
}
