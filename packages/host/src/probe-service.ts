import { createHash, randomUUID } from "node:crypto";
import {
  type Assignment,
  authorizeProbe,
  type ProbeAdapter,
  type ProbeInput,
  type ProbeJob,
} from "@cardigan/domain";
import {
  fileAttachmentStore,
  loadCommandState,
  type ToolContext,
  ToolError,
  unwrap,
} from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { hostWideEventDocs } from "./host-wide-events.js";
import type { ProbeProfiles } from "./probe-config.js";

export type { ProbeAdapter, ProbeJob } from "@cardigan/domain";
export const probeJobView = (job: ProbeJob) => ({
  project_id: job.project_id,
  probe_run_id: job.id,
  probe: job.probe,
  card_id: job.card_id,
  work_item_id: job.work_item_id,
  head_sha: job.head_sha,
  ...(job.tested_sha ? { tested_sha: job.tested_sha } : {}),
  ...(job.checks ? { checks: job.checks } : {}),
  status: job.status,
  cleanup: job.cleanup,
  ...(job.attachment_id ? { attachment_id: job.attachment_id } : {}),
});
/** A durable queue shared by the MCP frontend and the sole background host. */
export class ProbeService {
  private working: Promise<void> | undefined;
  constructor(
    private readonly options: {
      store: Store;
      dataDir: string;
      profiles: () => ProbeProfiles;
      head: (project: string, assignment: Assignment) => Promise<string>;
      adapters?: Partial<Record<"github" | "config", ProbeAdapter>>;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private jobs(): ProbeJob[] {
    const jobs = new Map<string, ProbeJob>();
    // Query only probe facts; an idle probe loop must not load every card history.
    for (const event of hostWideEventDocs<ProbeJob>(
      this.options.store.database,
      "probe_job",
    )) {
      if (event.actor.kind !== "system") continue;
      const job = event.payload;
      jobs.set(job.id, job);
    }
    return [...jobs.values()];
  }
  private save(tx: StoreTransactionContext, job: ProbeJob) {
    tx.events.append(job.project_id, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(job.project_id, job.card_id),
      card_id: job.card_id,
      actor: { kind: "system", project_id: job.project_id },
      type: "probe_job",
      payload: JSON.parse(JSON.stringify(job)),
      created_at: new Date(this.now()).toISOString(),
    });
  }
  private checkpoint = (job: ProbeJob) => {
    this.options.store.uow.run((tx) => {
      const current = this.jobs().find((j) => j.id === job.id);
      if (!current || current.cleanup === "complete") return;
      const next = {
        ...job,
        ...(current.cancel_requested
          ? {
              cancel_requested: true,
              ...(job.cleanup === "complete"
                ? { status: "cancelled" as const }
                : {}),
            }
          : {}),
      };
      if (JSON.stringify(next) !== JSON.stringify(current)) this.save(tx, next);
    });
  };
  async execute(context: ToolContext, input: ProbeInput): Promise<unknown> {
    context.revalidateToken?.();
    const owner = () =>
      this.options.store.uow.read((tx) =>
        unwrap(
          authorizeProbe(
            loadCommandState(tx, context.identity.actor.project_id),
            context.identity.actor,
          ),
        ),
      );
    const before = owner();
    const profile =
      this.options.profiles()[before.owner.project_id]?.[input.probe];
    if (!profile?.operations.includes(input.operation))
      throw new ToolError("unauthorized", "探针或操作未获主机授权");
    if ((input.operation === "smoke") === (input.parameters !== undefined))
      throw ToolError.validation(
        "smoke 不接受参数；其它操作只接受本身份的 probe_run_id",
      );
    if (input.operation === "status") {
      // Polling is a fresh read even when the caller reuses its request key.
      const job = this.options.store.uow.read(() =>
        this.jobs().find(
          (j) =>
            j.id === input.parameters?.probe_run_id &&
            j.probe === input.probe &&
            j.project_id === before.owner.project_id &&
            j.card_id === before.owner.card_id &&
            j.work_item_id === before.owner.work_item_id &&
            j.assignment_id === before.owner.assignment_id,
        ),
      );
      if (!job) throw new ToolError("unauthorized", "探针运行不属于当前身份");
      return probeJobView(job);
    }
    const request = { tool: "run_probe" as const, params: input };
    const invocation = {
      project_id: before.owner.project_id,
      assignment_id: before.owner.assignment_id,
      key: input.idempotency_key,
      request,
    };
    // Cache hits never read a new HEAD or enqueue a second execution.
    const miss = Symbol();
    try {
      return unwrap(
        this.options.store.runIdempotent(invocation, () => {
          throw miss;
        }),
      ).value;
    } catch (e) {
      if (e !== miss) throw e;
    }
    const head =
      input.operation === "smoke"
        ? await this.options.head(before.owner.project_id, before.assignment)
        : undefined;
    context.revalidateToken?.();
    return unwrap(
      this.options.store.runIdempotent(invocation, (tx) => {
        context.revalidateToken?.();
        const current = unwrap(
          authorizeProbe(
            loadCommandState(tx, before.owner.project_id),
            context.identity.actor,
          ),
        );
        if (JSON.stringify(current) !== JSON.stringify(before))
          throw new ToolError("stale_target", "探针负责人已变化");
        const currentProfile =
          this.options.profiles()[before.owner.project_id]?.[input.probe];
        if (!currentProfile?.operations.includes(input.operation))
          throw new ToolError("unauthorized", "探针授权已变化");
        const jobs = this.jobs();
        let job: ProbeJob;
        if (input.operation === "smoke") {
          if (!head || !/^[a-f0-9]{40}$/u.test(head))
            throw ToolError.validation("无法取得当前产出分支版本");
          if (jobs.some((j) => j.cleanup !== "complete"))
            throw new ToolError("illegal_transition", "已有探针运行或等待清理");
          job = {
            ...current.owner,
            id: randomUUID().replaceAll("-", ""),
            probe: input.probe,
            head_sha: head,
            created_at: new Date(this.now()).toISOString(),
            profile: currentProfile,
            status: "queued",
            cleanup: "pending",
          };
          this.save(tx, job);
        } else {
          const found = jobs.find(
            (j) =>
              j.id === input.parameters?.probe_run_id &&
              j.probe === input.probe &&
              j.project_id === current.owner.project_id &&
              j.assignment_id === current.owner.assignment_id &&
              j.work_item_id === current.owner.work_item_id &&
              j.card_id === current.owner.card_id,
          );
          if (!found)
            throw new ToolError("unauthorized", "探针运行不属于当前身份");
          job = found;
          if (input.operation !== "status" && job.cleanup !== "complete") {
            job = { ...job, cancel_requested: true };
            this.save(tx, job);
          }
        }
        return probeJobView(job);
      }),
    ).value;
  }
  tick(): Promise<void> {
    this.working ??= this.cycle().finally(() => {
      this.working = undefined;
    });
    return this.working;
  }
  private cancelled(job: ProbeJob): boolean {
    try {
      const active = this.options.store.uow.read((tx) => {
        const current = this.jobs().find((j) => j.id === job.id);
        const a = tx.assignments.get(job.project_id, job.assignment_id);
        const w = tx.work_items.get(job.project_id, job.work_item_id);
        const c = tx.cards.get(job.project_id, job.card_id);
        return (
          current &&
          !current.cancel_requested &&
          a?.status === "active" &&
          a.scope === "work_item" &&
          a.work_item_id === job.work_item_id &&
          w?.assignment_id === a.id &&
          w.kind === "produce" &&
          w.status !== "cancelled" &&
          c &&
          !["done", "cancelled", "awaiting_merge"].includes(c.status)
        );
      });
      const profile = this.options.profiles()[job.project_id]?.[job.probe];
      return (
        !active ||
        !profile?.operations.includes("smoke") ||
        JSON.stringify(profile) !== JSON.stringify(job.profile) ||
        this.now() - Date.parse(job.created_at) >= job.profile.timeout_ms
      );
    } catch {
      return true;
    }
  }
  private async cycle(): Promise<void> {
    for (let job of this.options.store.uow.read(() => this.jobs())) {
      if (job.cleanup === "complete") {
        if (
          job.status === "passed" &&
          !job.attachment_id &&
          !job.cancel_requested &&
          job.tested_sha
        )
          await this.evidence(job);
        continue;
      }
      if (this.cancelled(job)) job = { ...job, cancel_requested: true };
      if (job.status === "queued" && job.cancel_requested) {
        this.checkpoint({ ...job, status: "cancelled", cleanup: "complete" });
        continue;
      }
      const adapter = this.options.adapters?.[job.probe];
      if (!adapter) continue;
      // Persist running before IO so restart never treats an uncertain effect as new work.
      if (job.status === "queued") job = { ...job, status: "running" };
      this.checkpoint(job);
      try {
        job = await adapter.advance(job, this.checkpoint, () =>
          this.cancelled(job),
        );
      } catch {
        job = {
          ...(this.options.store.uow.read(() =>
            this.jobs().find((j) => j.id === job.id),
          ) ?? job),
          cleanup: "held",
        };
      }
      this.checkpoint(job);
      if (
        job.status === "passed" &&
        job.cleanup === "complete" &&
        !job.cancel_requested &&
        job.tested_sha
      )
        await this.evidence(job);
    }
  }
  private async evidence(job: ProbeJob) {
    const report = Buffer.from(
      JSON.stringify({ source: "live", ...probeJobView(job) }, null, 2),
    );
    const sha256 = createHash("sha256").update(report).digest("hex");
    const stored = await fileAttachmentStore(this.options.dataDir).put(
      sha256,
      report,
    );
    this.options.store.uow.run((tx) => {
      const current = this.jobs().find((j) => j.id === job.id);
      if (
        !current ||
        current.attachment_id ||
        current.cancel_requested ||
        current.cleanup !== "complete" ||
        current.status !== "passed"
      )
        return;
      const attachment = tx.ids.nextAttachmentId(job.project_id);
      const entry = tx.ids.nextTimelineEntryId(job.project_id, job.card_id);
      const seq = tx.ids.nextEventSequence(job.project_id, job.card_id);
      const at = new Date(this.now()).toISOString();
      tx.events.append(job.project_id, {
        id: tx.ids.nextEventId(),
        seq,
        card_id: job.card_id,
        actor: { kind: "system", project_id: job.project_id },
        type: "probe_evidence",
        payload: JSON.parse(
          JSON.stringify({
            ...probeJobView(job),
            attachment_id: attachment,
            source: "live",
            result: "passed",
          }),
        ),
        created_at: at,
      });
      tx.timeline.put(job.project_id, {
        id: entry,
        short_id: entry,
        card_id: job.card_id,
        event_seq: seq,
        type: "system",
        author: "system",
        body: `集成探针 ${job.probe} 已通过并完成清理，证据已附。`,
        refs: [],
        mentions: [],
        retracted: false,
        created_at: at,
      });
      tx.attachments.put(job.project_id, {
        id: attachment,
        sha256,
        mime: "application/json",
        size: report.byteLength,
        card_id: job.card_id,
        uploaded_by: "system",
        storage_path: stored.storage_path,
        attach_to: { kind: "timeline_entry", id: entry },
        kind: "evidence",
        original_filename: "probe-evidence.json",
      });
      this.save(tx, { ...current, attachment_id: attachment });
    });
  }
}
