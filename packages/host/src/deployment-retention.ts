import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import { requireHostDirectory } from "./deployment-config.js";
import { ReleaseSurvey } from "./deployment-release-inventory.js";
import {
  type Item,
  localCommand,
  localRunTarget,
  type Scan,
  scan,
  single,
} from "./deployment-retention-io.js";
import {
  approved,
  eligibleRuns,
  type RetentionPolicy,
} from "./deployment-retention-policy.js";
import { previewDeploymentSnapshots } from "./deployment-snapshot-retention.js";

const project = "cardigan";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const key = (i: Item) => `${i.kind}/${i.name}`;
const same = (a: Item, b: Item) =>
  a.device === b.device &&
  a.inode === b.inode &&
  a.stamp === b.stamp &&
  a.size_bytes === b.size_bytes;
type Target = Awaited<ReturnType<typeof localRunTarget>>;
interface Ready {
  stillReady: () => Promise<boolean>;
  keep: readonly string[];
  backup?: string;
  attempt: string;
  deployed_at: string;
}
interface Inventory {
  candidates: Item[];
  skipped: string[];
  skip_reasons: NonNullable<Scan["skip_reasons"]>;
  namespace: Record<string, string>;
  retained_releases: {
    name: string;
    reason: string;
    size_bytes: number | null;
  }[];
  total_bytes: number;
}
interface Report extends Inventory {
  version: 4;
  captured_at: string;
  scope: string;
  policy: Omit<RetentionPolicy, "approval">;
  authorization_scope: string;
}

export function releaseKeep(directory: string, paths: readonly string[]) {
  const keep = new Set<string>();
  for (const value of paths) {
    if (!value || resolve(value) !== value)
      throw new Error("Unknown deployment reference");
    const prefix = `${directory}/`;
    if (value.startsWith(prefix))
      keep.add(value.slice(prefix.length).split("/")[0] ?? "");
  }
  return [...keep];
}

export class DeploymentRetention {
  private readonly releases = new ReleaseSurvey();
  private next = 0;
  private attempt = "";
  private queue: Item[] = [];
  constructor(
    private readonly store: Store,
    private readonly dir: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly policy: RetentionPolicy,
    private readonly target = localRunTarget,
  ) {}
  private state() {
    return this.store.uow.read((tx) => loadCommandState(tx, project));
  }
  private audit(
    status: string,
    details: {
      name?: string;
      kind?: string;
      size_bytes?: number;
      reason?: string;
      sha256?: string;
    },
  ) {
    this.store.uow.run((tx) =>
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project),
        type: "host_retention_recorded",
        actor: { kind: "system", project_id: project },
        created_at: new Date().toISOString(),
        payload: { status, ...details },
      }),
    );
  }
  private async snapshots(ready: Ready) {
    const s = await previewDeploymentSnapshots(this.dir, ready.backup, {
      latest: this.policy.snapshots,
      days: this.policy.daily_days,
    });
    return {
      ...s,
      candidates: s.candidates.map<Item>(
        ({ name, device, inode, size_bytes, stamp }) => ({
          kind: "snapshot",
          name,
          device,
          inode,
          size_bytes,
          stamp,
        }),
      ),
    };
  }
  private releaseInput(ready: Ready) {
    return {
      root: this.dir,
      uid: process.getuid?.(),
      keep: releaseKeep(this.dir, ready.keep),
      latest: this.policy.releases,
    };
  }
  private async inventory(
    ready: Ready,
    t: Target,
    scope: string,
    preview: boolean,
  ): Promise<Inventory | undefined> {
    const releases = preview
      ? await this.releases.poll(scope, this.releaseInput(ready))
      : [];
    if (!releases) return;
    const snapshots = await this.snapshots(ready);
    const candidates = snapshots.candidates;
    const skipped = [...snapshots.skipped];
    const skip_reasons: Inventory["skip_reasons"] = {};
    const namespace: Record<string, string> = {
      ...snapshots.namespace,
    };
    if (t) {
      // Record only the host-owned namespace bindings, not the content of live runs.
      // An old but still-protected assignment may legitimately age out later.
      const parent = join(t.root, "runs", project);
      await requireHostDirectory(parent);
      const state = this.state();
      const owners = new Map<string, boolean>(
        state.assignments.map((a) => [
          a.id,
          a.machine_id === "local" && t.ownsRef(a.runtime_ref),
        ]),
      );
      for (const name of await readdir(parent)) {
        if (!/^A-[1-9][0-9]*$/u.test(name)) continue;
        const st = await lstat(join(parent, name), { bigint: true }).catch(
          () => undefined,
        );
        if (
          owners.get(name) &&
          st?.isDirectory() &&
          Number(st.uid) === process.getuid?.() &&
          Number(st.gid) === t.gid &&
          (st.mode & 0o7777n) === 0o2770n
        )
          namespace[name] = `${st.dev}:${st.ino}`;
        else skipped.push(name);
      }
      const names = [
        ...eligibleRuns(
          state,
          this.policy.released_days,
          Date.now(),
          t.ownsRef,
        ).keys(),
      ].filter((n) => Object.hasOwn(namespace, n));
      for (let start = 0; start < names.length; start += 128) {
        const batch = names.slice(start, start + 128);
        try {
          const result = await scan(
            t.inventory,
            { root: t.root, gid: t.gid, uid: process.getuid?.(), names: batch },
            "run",
            new Set(batch),
          );
          for (const item of result.candidates) {
            if (namespace[item.name] === `${item.device}:${item.inode}`)
              candidates.push(item);
            else skipped.push(item.name);
          }
          skipped.push(...result.skipped);
          Object.assign(skip_reasons, result.skip_reasons);
        } catch {
          skipped.push(...batch);
        }
      }
    } else skipped.push("isolated_run_target_unavailable");
    return {
      candidates,
      skipped,
      skip_reasons,
      namespace,
      retained_releases: releases,
      total_bytes: candidates.reduce((n, i) => n + i.size_bytes, 0),
    };
  }
  private async readReport(path: string) {
    let fd: Awaited<ReturnType<typeof open>>;
    try {
      fd = await open(
        path,
        constants.O_NOFOLLOW | constants.O_RDONLY | constants.O_NONBLOCK,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    try {
      const st = await fd.stat();
      if (
        !st.isFile() ||
        st.uid !== process.getuid?.() ||
        st.nlink !== 1 ||
        st.mode & 0o077 ||
        st.size > 16 * 1024 * 1024
      )
        throw new Error("Unsafe retention report");
      return await fd.readFile("utf8");
    } finally {
      await fd.close();
    }
  }
  private async publish(path: string, report: Report) {
    const text = `${JSON.stringify(report, null, 2)}\n`,
      tmp = join(this.dir, `retention-${randomUUID()}.tmp`);
    if (Buffer.byteLength(text) > 16 * 1024 * 1024)
      throw new Error("Inventory too large");
    const fd = await open(tmp, "wx", 0o600);
    try {
      await fd.writeFile(text);
      await fd.sync();
      await link(tmp, path);
    } finally {
      await fd.close();
      await unlink(tmp);
    }
    this.audit("preview", {
      name: basename(path),
      sha256: hash(text),
      size_bytes: report.total_bytes,
    });
  }
  async poll(ready: Ready, now = Date.now()) {
    const { approval, ...policy } = this.policy;
    if (!this.queue.length && now < this.next && ready.attempt === this.attempt)
      return;
    if (ready.attempt !== this.attempt) this.queue = [];
    this.attempt = ready.attempt;
    const path = join(this.dir, `retention-preview-${policy.revision}.json`);
    this.next = now + 3600000;
    const text = await this.readReport(path);
    if (text && !approval) return; // Frozen first inventory; no periodic overwrites while awaiting review.
    if (
      approval &&
      (!text ||
        hash(text) !== approval.sha256 ||
        !approved(this.state(), approval))
    ) {
      this.queue = [];
      this.audit("retained", { reason: "approval_missing_or_changed" });
      return;
    }
    const t = await this.target(this.env, dirname(this.dir));
    const identity = async (p: string) => {
      const stat = await lstat(p, { bigint: true });
      return [String(stat.dev), String(stat.ino)];
    };
    const scope = hash(
      JSON.stringify([
        this.dir,
        await identity(this.dir),
        process.getuid?.(),
        t ? [t.fingerprint, await identity(t.root)] : null,
      ]),
    );
    if (!text) {
      const current = await this.inventory(ready, t, scope, true);
      if (!current) {
        this.next = 0;
        return;
      }
      if (!(await ready.stillReady())) return;
      await this.publish(path, {
        version: 4,
        captured_at: new Date(now).toISOString(),
        scope,
        policy,
        authorization_scope:
          "历史发布仅供盘点，不参与删除或可回收总量。首轮仅处理清单原件。批准持续启用后，后续成功部署按同一策略回收新增或退出保留期的对象。旧清单中跳过或变更的实例仍保留。",
        ...current,
      });
      return;
    }
    if (!approval) return;
    const report = JSON.parse(text) as Report;
    if (
      report.version !== 4 ||
      scope !== report.scope ||
      JSON.stringify(policy) !== JSON.stringify(report.policy)
    ) {
      this.queue = [];
      this.audit("retained", { reason: "scope_or_policy_changed" });
      return;
    }
    if (!this.queue.length) {
      const current = await this.inventory(ready, t, scope, false);
      if (!current) {
        this.next = 0;
        return;
      }
      const originals = new Map(report.candidates.map((i) => [key(i), i]));
      const skipped = new Set(report.skipped);
      const state = this.state();
      const q = state.decisions.find((q) => q.id === approval.data_deletion);
      const first = this.store.uow.run((tx) => {
        const prior = this.store.database
          .prepare(
            `SELECT json_extract(doc,'$.payload.attempt') AS attempt FROM events WHERE project_id=? AND card_id IS NULL AND type='host_retention_activated' AND json_extract(doc,'$.payload.sha256')=? ORDER BY seq LIMIT 1`,
          )
          .get(project, approval.sha256);
        if (prior) return prior.attempt;
        tx.events.append(project, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project),
          type: "host_retention_activated",
          actor: { kind: "system", project_id: project },
          created_at: new Date().toISOString(),
          payload: { sha256: approval.sha256, attempt: ready.attempt },
        });
        return ready.attempt;
      });
      const rollover =
        first !== ready.attempt &&
        Date.parse(ready.deployed_at) > Date.parse(q?.resolution?.at ?? "");
      // A committed intent precedes either destructive phase. Even a crash before the
      // first unlink consumes this name for this approval; only a new preview resets it.
      const attempted = new Set<string>();
      const notified = new Set<string>();
      for (const e of state.events) {
        if (e.type !== "host_retention_recorded") continue;
        const record = e.payload as {
          sha256?: string;
          status?: string;
          name?: string;
          kind?: string;
          reason?: string;
        } | null;
        if (record?.sha256 !== approval.sha256) continue;
        if (record.status === "retained")
          notified.add(`${record.name}/${record.reason}`);
        if (record.status === "removing")
          attempted.add(`${record.kind}/${record.name}`);
      }
      const retained = (name: string, reason: string) => {
        const k = `${name}/${reason}`;
        if (notified.has(k)) return;
        this.audit("retained", { name, reason, sha256: approval.sha256 });
        notified.add(k);
      };
      for (const name of current.skipped)
        retained(name, current.skip_reasons[name] ?? "unverifiable_or_busy");
      const runs =
        t && eligibleRuns(state, policy.released_days, now, t.ownsRef);
      this.queue = current.candidates.filter((i) => {
        if (attempted.has(key(i))) return false;
        const old = originals.get(key(i));
        const permitted = old
          ? same(old, i)
          : rollover &&
            !skipped.has(i.name) &&
            (i.kind === "run"
              ? Object.hasOwn(report.namespace, i.name)
                ? report.namespace[i.name] === `${i.device}:${i.inode}`
                : (runs?.get(i.name) ?? 0) > Date.parse(report.captured_at)
              : !Object.hasOwn(report.namespace, i.name) ||
                report.namespace[i.name] === i.stamp);
        if (!permitted) retained(i.name, "outside_reviewed_inventory");
        return permitted;
      });
    }
    // One operation per supervisor tick; never hold deployment capacity while pruning a backlog.
    const item = this.queue.shift();
    if (!item) return;
    const details = {
      kind: item.kind,
      name: item.name,
      size_bytes: item.size_bytes,
    };
    if (!(await ready.stillReady())) {
      this.queue = [];
      this.audit("retained", { ...details, reason: "deployment_changed" });
      return;
    }
    this.audit("removing", { ...details, sha256: approval.sha256 });
    try {
      if (item.kind === "run" && t) {
        const input = {
          root: t.root,
          uid: process.getuid?.(),
          gid: t.gid,
          names: [item.name],
          item,
        };
        const transact = (op: () => void) =>
          this.store.uow.run((tx) => {
            const fresh = loadCommandState(tx, project);
            if (
              !approved(fresh, approval) ||
              !eligibleRuns(
                fresh,
                policy.released_days,
                Date.now(),
                t.ownsRef,
              ).has(item.name)
            )
              throw new Error("Run protected");
            op();
          });
        // Keep the original inode allocated across both accounts and both DB snapshots:
        // even a remove/recreate between phases cannot reuse its inode number.
        const parent = join(t.root, "runs", project);
        await requireHostDirectory(parent);
        const held = await open(
          join(parent, item.name),
          constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY,
        );
        try {
          const st = await held.stat({ bigint: true });
          if (String(st.dev) !== item.device || String(st.ino) !== item.inode)
            throw new Error("Run directory changed");
          transact(() =>
            single(t.clear, { ...input, deadline_ms: Date.now() + 2200 }, item),
          );
          transact(() => single(localCommand("shell"), input, item));
        } finally {
          await held.close();
        }
      } else if (item.kind === "snapshot") {
        const fresh = (await this.snapshots(ready)).candidates.find(
          (s) => s.name === item.name,
        );
        if (!fresh || !same(fresh, item)) throw new Error("Snapshot retained");
        this.store.uow.run((tx) => {
          if (!approved(loadCommandState(tx, project), approval))
            throw new Error("Approval changed");
          single(
            localCommand("snapshot"),
            { root: this.dir, uid: process.getuid?.(), item },
            item,
          );
        });
      } else throw new Error("No target");
    } catch {
      this.audit("retained", {
        ...details,
        reason: "recheck_or_operation_incomplete",
      });
      return;
    }
    this.audit("removed", details);
  }
}
