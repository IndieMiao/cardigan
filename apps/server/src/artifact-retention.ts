import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  AttachmentId,
  DeliverySubject,
  ProjectId,
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
  if (!records.length) return live;
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
  for (const card of new Set(records.map(({ a }) => a.card_id))) {
    for (const e of tx.events.listAfter(project, card, 0)) {
      if (
        e.type === "card_marked_done" &&
        e.payload &&
        typeof e.payload === "object" &&
        "attachments" in e.payload &&
        Array.isArray(e.payload.attachments)
      )
        for (const id of e.payload.attachments)
          if (typeof id === "string") pins.add(id);
    }
  }
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
      a.basis ||
      a.attach_to.kind === "delivery" ||
      pins.has(a.id) ||
      hashes.has(a.sha256)
    ) {
      live.add(s.blob_id);
      continue;
    }
    const entry = tx.timeline.get(project, a.attach_to.id);
    if (entry?.decision_id || entry?.delivery_id) {
      live.add(s.blob_id);
      continue;
    }
    tx.attachments.put(project, {
      ...a,
      streamed_artifact: { ...s, expired: { at, reason } },
    });
    total -= a.size;
  }
  return live;
}
/** A crash after tombstoning is retryable. Unknown fresh blobs may be in-flight: never remove them. */
export async function sweepArtifacts(
  store: Pick<Store, "uow" | "listProjects">,
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
  const policies = await readPolicies(dir),
    live = new Set<string>(),
    expired = new Set<string>();
  for (const p of store.listProjects()) {
    const ids = store.uow.run((tx) => {
      const kept = expire(tx, p.id, policies.get(p.id) ?? defaults, at);
      return {
        kept,
        expired: tx.attachments
          .list(p.id)
          .flatMap((a) =>
            a.streamed_artifact?.expired ? [a.streamed_artifact.blob_id] : [],
          ),
      };
    });
    for (const id of ids.kept) live.add(id);
    for (const id of ids.expired) expired.add(id);
  }
  for (const entry of entries) {
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
        await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
