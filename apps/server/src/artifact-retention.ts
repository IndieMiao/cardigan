import { type Dirent, lstatSync, unlinkSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AttachmentId,
  type DeliverySubject,
  type ProjectId,
  releaseChainOf,
} from "@cardigan/domain";
import { ARTIFACT_BLOB_ID, artifactPath } from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";

const DAY = 86400000;
type Policy = { days: number; max_bytes: number };
const defaults: Policy = { days: 30, max_bytes: 20 * 1024 ** 3 };
async function readPolicies(dir: string) {
  const policies = new Map<string, Policy>();
  let text: string;
  try {
    text = await readFile(join(dir, "artifact-retention.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return policies;
    throw err;
  }
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    throw Error("Invalid artifact retention configuration");
  for (const [project, p] of Object.entries(obj) as [string, Policy][]) {
    if (
      !p ||
      Object.keys(p).sort().join(",") !== "days,max_bytes" ||
      !Number.isSafeInteger(p.days) ||
      p.days < 1 ||
      !Number.isSafeInteger(p.max_bytes) ||
      p.max_bytes < 1
    )
      throw Error("Invalid artifact retention policy");
    policies.set(project, p);
  }
  return policies;
}
/** Select and tombstone while holding the same write lock used by delivery and decision commands. */
function expire(
  store: Pick<Store, "database">,
  tx: StoreTransactionContext,
  project: ProjectId,
  policy: Policy,
  at: string,
) {
  const records = tx.attachments
    .list(project)
    .flatMap((a) =>
      a.streamed_artifact && !a.streamed_artifact.expired
        ? [{ a, s: a.streamed_artifact }]
        : [],
    );
  const live = new Set<string>();
  if (!records.length) return { live, more: false };
  const pins = new Set<AttachmentId>(),
    hashes = new Set<string>();
  function subject(s: DeliverySubject) {
    if (s.kind === "artifact_sha256") hashes.add(s.value.toLowerCase());
  }
  for (const d of tx.deliveries.list(project)) {
    for (const id of d.attachments) pins.add(id);
    subject(d.subject);
  }
  for (const q of tx.decisions.list(project)) {
    for (const id of q.attachment_ids ?? []) pins.add(id);
    if (q.kind === "approve" && "subject" in q.target)
      subject(q.target.subject);
  }
  for (const r of tx.reviews.list(project))
    for (const id of r.attachments) pins.add(id);
  for (const h of tx.human_actions.list(project))
    for (const id of h.result?.attachments ?? []) pins.add(id);
  // Streamed attachments may be pinned by a completion. Read the type index
  // in this transaction instead of decoding each owning card's entire history.
  for (const row of store.database
    .prepare(
      "SELECT doc FROM events WHERE project_id=? AND type='card_marked_done' AND card_id IS NOT NULL",
    )
    .iterate(project)) {
    const ids = JSON.parse(String(row.doc)).payload?.attachments;
    if (Array.isArray(ids))
      for (const id of ids)
        if (typeof id === "string") pins.add(id as AttachmentId);
  }
  // C-612: a release chain still needs the packages it stored on its approval
  // (unsigned intake, signed intake) until its publication is verified.
  const published = new Set<string>();
  for (const row of store.database
    .prepare(
      "SELECT doc FROM events WHERE project_id=? AND type='artifact_publication_verified' AND card_id IS NOT NULL",
    )
    .iterate(project)) {
    const id = JSON.parse(String(row.doc)).payload?.decision_id;
    if (typeof id === "string") published.add(id);
  }
  const chains = new Set(
    tx.decisions
      .list(project)
      .filter((q) => releaseChainOf(q) && !published.has(q.id))
      .map((q) => q.key as string),
  );
  let changed = 0;
  const until = performance.now() + 250;
  let total = records.reduce((sum, { a }) => sum + a.size, 0);
  for (const { a, s } of records.sort(
    (x, y) =>
      x.s.created_at.localeCompare(y.s.created_at) ||
      x.a.id.localeCompare(y.a.id, "en", { numeric: true }),
  )) {
    const reason =
      Date.parse(at) - Date.parse(s.created_at) >= policy.days * DAY
        ? "age"
        : total > policy.max_bytes
          ? "capacity"
          : undefined;
    if (
      !reason ||
      a.attach_to.kind === "delivery" ||
      pins.has(a.id) ||
      hashes.has(a.sha256) ||
      (a.basis !== undefined && chains.has(a.basis))
    ) {
      live.add(s.blob_id);
      continue;
    }
    const entry = tx.timeline.get(project, a.attach_to.id);
    if (entry?.decision_id || entry?.delivery_id) {
      live.add(s.blob_id);
      continue;
    }
    if (changed >= 16 || (changed && performance.now() >= until))
      return { live, more: true };
    changed++;
    tx.attachments.put(project, {
      ...a,
      streamed_artifact: { ...s, expired: { at, reason } },
    });
    total -= a.size;
  }
  return { live, more: false };
}
/** A crash after tombstoning is retryable. Unknown fresh blobs may be in-flight: never remove them. */
export async function* artifactPages(
  store: Pick<Store, "uow" | "listProjects" | "database">,
  dir: string,
  at: string,
) {
  let entries: Dirent[];
  try {
    const directory = join(dir, "artifacts");
    if (!(await lstat(directory)).isDirectory())
      throw Error("Invalid artifact directory");
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const live = new Set<string>(),
    expired = new Set<string>();
  for (const p of store.listProjects()) {
    while (true) {
      const policies = await readPolicies(dir);
      const ids = store.uow.run((tx) => {
        const kept = expire(
          store,
          tx,
          p.id,
          policies.get(p.id) ?? defaults,
          at,
        );
        return {
          kept,
          expired: tx.attachments
            .list(p.id)
            .flatMap((a) =>
              a.streamed_artifact?.expired ? [a.streamed_artifact.blob_id] : [],
            ),
        };
      });
      if (ids.kept.more) {
        yield;
        continue;
      }
      for (const id of ids.kept.live) live.add(id);
      for (const id of ids.expired) expired.add(id);
      break;
    }
    yield;
  }
  let count = 0,
    until = performance.now() + 250;
  for (const entry of entries) {
    if (++count > 128 || performance.now() >= until) {
      yield;
      count = 1;
      until = performance.now() + 250;
    }
    if (
      !entry.isFile() ||
      !ARTIFACT_BLOB_ID.test(entry.name) ||
      live.has(entry.name)
    )
      continue;
    const path = artifactPath(dir, entry.name);
    try {
      const stat = await lstat(path);
      if (
        stat.isFile() &&
        (expired.has(entry.name) || Date.parse(at) - stat.mtimeMs > DAY)
      )
        store.uow.run(() => {
          // The page may have yielded since we collected references. A live
          // record in ANY project now wins, even for an old orphan candidate.
          const refs = store.database
            .prepare(`SELECT json_extract(doc,'$.streamed_artifact.expired') IS NULL AS live
            FROM attachments WHERE json_extract(doc,'$.streamed_artifact.blob_id')=?`)
            .all(entry.name);
          if (refs.some((row) => row.live)) return;
          const current = lstatSync(path);
          if (
            current.isFile() &&
            (refs.length || Date.parse(at) - current.mtimeMs > DAY)
          )
            unlinkSync(path);
        });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/** Exhaustive maintenance entry; the production timer advances one page at a time. */
export async function sweepArtifacts(
  ...args: Parameters<typeof artifactPages>
) {
  for await (const _page of artifactPages(...args)) {
    /* drain */
  }
}
