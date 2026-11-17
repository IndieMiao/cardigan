import { createHash, randomUUID } from "node:crypto";
import { connect as connectTcp, isIP } from "node:net";
import { connect as connectTls } from "node:tls";
import {
  type AssignmentId,
  type Clock,
  type CommandState,
  currentInteraction,
  DEFAULT_UPSTREAM_POLICY,
  diagnoseUpstream,
  diagnoseUpstreams,
  type EventId,
  type InteractionSample,
  type ProjectId,
  type Runtime,
  type RuntimeInteractionReader,
  recordUpstreamHealth,
  type SessionActivity,
  type UpstreamDiagnosis,
  type UpstreamProbe,
  type UpstreamTarget,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { LaunchConfig } from "@cardigan/roles";
import {
  beginUpstreamProbeSample,
  cancelUpstreamProbeSample,
  readUpstreamProbeSample,
  recordNotification,
  type Store,
  writeUpstreamProbeSample,
} from "@cardigan/store";

export type ConnectionProbe = (
  origin: string,
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<
  | { status: "reachable" }
  | { status: "unreachable"; failure: NonNullable<UpstreamProbe["failure"]> }
>;
/** TCP/TLS only: no model requests, request headers, credentials, redirects or response bodies. */
export const probeUpstreamConnection: ConnectionProbe = (
  origin,
  timeoutMs,
  signal,
) =>
  new Promise((resolve) => {
    const url = new URL(origin);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let finished = false;
    const socket =
      url.protocol === "https:"
        ? connectTls({
            host: hostname,
            port: Number(url.port || 443),
            ...(isIP(hostname) ? {} : { servername: hostname }),
            rejectUnauthorized: true,
          })
        : connectTcp({ host: hostname, port: Number(url.port || 80) });
    const done = (result: Awaited<ReturnType<ConnectionProbe>>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      resolve(result);
    };
    const abort = () => done({ status: "unreachable", failure: "timeout" });
    // Absolute deadline also bounds DNS lookup; socket idle timeouts alone do not.
    const timer = setTimeout(abort, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () =>
      done({ status: "reachable" }),
    );
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done({
        status: "unreachable",
        failure: /CERT|TLS|SSL/.test(error.code ?? "")
          ? "tls_error"
          : "connection_error",
      }),
    );
    if (signal.aborted) abort();
  });

/** Background sampling is detached from the global dispatcher tick; only cached facts are consumed there. */
export class UpstreamHealthMonitor {
  readonly policy;
  private readonly samples = new Map<string, UpstreamProbe>();
  private readonly unpublished = new Map<string, UpstreamProbe>();
  private readonly publicationFailures = new Set<string>();
  private readonly uncertainPublications = new Set<string>();
  private readonly activity = new Map<
    string,
    { status: "working" | "idle" | "unknown"; at: string; ref: string }
  >();
  private readonly interactions = new Map<string, InteractionSample>();
  private pending: Promise<void> | undefined;
  private readonly classificationFailures = new Set<ProjectId>();
  private lastPoll = Number.NEGATIVE_INFINITY;
  private readonly abort = new AbortController();
  constructor(
    private readonly config: LaunchConfig,
    private readonly runtime: Runtime & Partial<RuntimeInteractionReader>,
    private readonly clock: Clock,
    private readonly probe: ConnectionProbe = probeUpstreamConnection,
    private sampleStore?: Store,
    private readonly onPublicationError?: () => void,
  ) {
    this.policy = config.upstream_health
      ? {
          inactive_session_count: config.upstream_health.inactive_session_count,
          inactivity_window_ms: config.upstream_health.inactivity_window_ms,
          recurrence_window_ms: config.upstream_health.recurrence_window_ms,
        }
      : DEFAULT_UPSTREAM_POLICY;
  }
  private configurationKey(provider: string) {
    const upstream = this.config.providers[provider]?.upstream;
    return createHash("sha256")
      .update(
        JSON.stringify([
          provider,
          upstream?.group ?? provider,
          upstream?.probe_url ?? null,
          this.config.upstream_health?.probe ?? null,
        ]),
      )
      .digest("hex");
  }
  private sample(provider: string) {
    return this.sampleStore
      ? readUpstreamProbeSample(
          this.sampleStore,
          provider,
          this.configurationKey(provider),
        )
      : this.samples.get(provider);
  }
  private publicationFailed(provider: string) {
    this.publicationFailures.add(provider);
    // Only a fixed diagnostic reaches the host logger; never the SQLite error.
    try {
      this.onPublicationError?.();
    } catch {
      /* Logging cannot remove the fence. */
    }
  }
  private group(provider: string) {
    return this.config.providers[provider]?.upstream?.group ?? provider;
  }
  targets(state: CommandState): UpstreamTarget[] {
    const closedCards = new Set(
      state.cards
        .filter((c) => ["done", "cancelled"].includes(c.status))
        .map((c) => c.id),
    );
    const closedItems = new Set(
      state.work_items
        .filter((w) => closedCards.has(w.card_id))
        .map((w) => w.id),
    );
    // Preserve findLast semantics, including runs without a launch profile.
    const profiles = new Map<AssignmentId, string>();
    for (const run of state.runs)
      if (run.launch_profile_ref)
        profiles.set(run.assignment_id, run.launch_profile_ref);
    const employees = new Map(state.employees?.map((e) => [e.id, e]));
    return state.assignments
      .filter(
        (a) =>
          a.status === "active" &&
          !a.external &&
          (a.scope !== "work_item" || !closedItems.has(a.work_item_id)),
      )
      .flatMap((a) => {
        const ref =
          profiles.get(a.id) ??
          (a.employee_id
            ? employees.get(a.employee_id)?.launch_profile_ref
            : undefined);
        const provider = ref ? this.config.profiles[ref]?.provider : undefined;
        return provider
          ? [{ assignment_id: a.id, provider, group: this.group(provider) }]
          : [];
      });
  }

  schedule() {
    const policy = this.config.upstream_health?.probe;
    const now = Date.parse(this.clock.now());
    if (
      !policy ||
      this.pending ||
      this.abort.signal.aborted ||
      now - this.lastPoll < policy.interval_ms
    )
      return;
    this.lastPoll = now;
    this.pending = Promise.allSettled(
      Object.entries(this.config.providers).map(
        async ([provider, definition]) => {
          const origin = definition.upstream?.probe_url;
          if (!origin) return;
          const key = this.configurationKey(provider);
          const publicationId = randomUUID();
          let wasPending = false;
          if (this.sampleStore) {
            try {
              wasPending = beginUpstreamProbeSample(
                this.sampleStore,
                key,
                provider,
                this.group(provider),
                publicationId,
              );
              if (wasPending && !this.unpublished.has(provider))
                this.uncertainPublications.add(provider);
            } catch {
              this.publicationFailed(provider);
              return;
            }
          }
          const result = await Promise.resolve()
            .then(() =>
              this.probe(origin, policy.timeout_ms, this.abort.signal),
            )
            .catch(() => ({
              status: "unreachable" as const,
              failure: "connection_error" as const,
            }));
          if (this.abort.signal.aborted) {
            if (this.sampleStore && !wasPending) {
              try {
                cancelUpstreamProbeSample(
                  this.sampleStore,
                  key,
                  provider,
                  publicationId,
                );
              } catch {
                this.publicationFailed(provider);
              }
            }
            return;
          }
          const checked_at = this.clock.now();
          const last_failure_at =
            result.status === "unreachable"
              ? checked_at
              : (this.samples.get(provider)?.last_failure_at ??
                this.sample(provider)?.last_failure_at);
          const sample: UpstreamProbe = {
            provider,
            group: this.group(provider),
            ...result,
            checked_at,
            ...(last_failure_at ? { last_failure_at } : {}),
          };
          // Retain the completed fact even when SQLite rejects its publication.
          this.samples.set(provider, sample);
          if (result.status === "unreachable")
            this.uncertainPublications.delete(provider);
          if (this.sampleStore) {
            try {
              const complete = !this.uncertainPublications.has(provider);
              writeUpstreamProbeSample(
                this.sampleStore,
                key,
                sample,
                publicationId,
                complete,
              );
              this.publicationFailures.delete(provider);
              this.unpublished.delete(provider);
            } catch {
              this.unpublished.set(provider, sample);
              this.publicationFailed(provider);
            }
          }
        },
      ),
    )
      .then(() => {})
      .finally(() => {
        this.pending = undefined;
      });
  }

  async close() {
    this.abort.abort();
    await this.pending;
  }
  /** Diagnostic/request IO is outside database transactions and outside the dispatcher. */
  async observe(state: CommandState, only?: AssignmentId) {
    const fresh: Record<string, SessionActivity[string]> = {};
    await Promise.all(
      state.assignments
        .filter(
          (a) =>
            a.status === "active" &&
            !a.external &&
            a.runtime_ref &&
            (!only || only === a.id),
        )
        .map(async (a) => {
          const ref = a.runtime_ref;
          if (!ref) return;
          const result = await Promise.resolve()
            .then(() => this.runtime.status(ref))
            .catch(() => undefined);
          const agent = result?.ok
            ? result.value.process === "exited"
              ? "idle"
              : result.value.agent
            : result?.error.code === "runtime_not_found"
              ? "idle"
              : "unknown";
          fresh[a.id] =
            agent === "working"
              ? "working"
              : ["idle", "done", "error"].includes(agent)
                ? "idle"
                : "unknown";
          const run = state.runs.findLast((r) => r.assignment_id === a.id);
          const key = `${state.project_id}:${a.id}`;
          this.interactions.delete(key);
          if (
            run &&
            ["dispatched", "acked", "running", "unknown"].includes(run.status)
          ) {
            const inactive = state.events.some(
              (e) =>
                ["run_inactive", "run_dispatch_stalled"].includes(e.type) &&
                (e.payload as { run_id?: string }).run_id === run.id,
            );
            const exited =
              (result?.ok && result.value.process === "exited") ||
              (!result?.ok && result?.error.code === "runtime_not_found");
            let interaction: InteractionSample["interaction"] | undefined =
              exited
                ? "exited"
                : !result?.ok || result.value.process !== "alive"
                  ? "unknown"
                  : undefined;
            if (
              result?.ok &&
              result.value.process === "alive" &&
              agent !== "working" &&
              (agent === "blocked" || inactive) &&
              this.runtime.interaction
            ) {
              const observed = await this.runtime
                .interaction?.(ref, {
                  project_id: state.project_id,
                  assignment_id: a.id,
                  harness:
                    run.harness ??
                    this.config.profiles[run.launch_profile_ref ?? ""]
                      ?.harness ??
                    "unknown",
                })
                .catch(() => undefined);
              interaction = observed?.ok ? observed.value : "unknown";
            }
            if (interaction) {
              const sample: InteractionSample = {
                interaction,
                project_id: state.project_id,
                assignment_id: a.id,
                run_id: run.id,
                runtime_ref: ref,
                observed_at: this.clock.now(),
                stale_after_ms:
                  this.config.interaction_stale_after_ms ?? 30_000,
              };
              this.interactions.set(key, sample);
              fresh[a.id] = sample;
            }
          }
          this.activity.set(`${state.project_id}:${a.id}`, {
            status:
              agent === "working"
                ? "working"
                : ["idle", "done", "error"].includes(agent)
                  ? "idle"
                  : "unknown",
            at: this.clock.now(),
            ref: JSON.stringify(a.runtime_ref),
          });
        }),
    );
    return fresh;
  }
  view(state: CommandState, fresh: SessionActivity = {}) {
    const now = this.clock.now();
    const timings = this.config.upstream_health?.probe;
    const unavailable_groups = new Set<string>();
    const probes: UpstreamProbe[] = Object.keys(this.config.providers).map(
      (provider) => {
        const previous = state.events.findLast(
          (e) =>
            e.type === "upstream_probe_changed" &&
            (e.payload as { provider: string }).provider === provider,
        )?.payload as unknown as UpstreamProbe | undefined;
        const stored = this.sample(provider);
        const incomplete = Boolean(
          (stored && "publication_id" in stored) ||
            this.publicationFailures.has(provider) ||
            this.uncertainPublications.has(provider),
        );
        if (incomplete) unavailable_groups.add(this.group(provider));
        const local = this.unpublished.get(provider);
        const source =
          local ?? stored ?? (this.sampleStore ? undefined : previous);
        const { publication_id: _publicationId, ...sample } =
          (source as UpstreamProbe & { publication_id?: string }) ?? {};
        const last_failure_at =
          this.samples.get(provider)?.last_failure_at ??
          sample.last_failure_at ??
          previous?.last_failure_at;
        const fresh =
          sample.checked_at &&
          timings &&
          Date.parse(now) - Date.parse(sample.checked_at) >= 0 &&
          Date.parse(now) - Date.parse(sample.checked_at) <=
            timings.stale_after_ms;
        return {
          ...sample,
          provider,
          group: this.group(provider),
          status:
            fresh && (!incomplete || local?.status === "unreachable")
              ? sample.status
              : "unknown",
          ...(last_failure_at ? { last_failure_at } : {}),
        };
      },
    );
    const activity: Record<string, SessionActivity[string]> = {};
    for (const a of state.assignments) {
      const sample = this.activity.get(`${state.project_id}:${a.id}`);
      // Without a configured freshness period, use only observations from this instant.
      if (
        sample &&
        sample.ref === JSON.stringify(a.runtime_ref) &&
        Date.parse(now) - Date.parse(sample.at) >= 0 &&
        Date.parse(now) - Date.parse(sample.at) <=
          (timings?.stale_after_ms ?? 0)
      )
        activity[a.id] = sample.status;
    }
    for (const a of state.assignments) {
      const sample = this.interactions.get(`${state.project_id}:${a.id}`);
      if (sample)
        activity[a.id] = currentInteraction(state, sample, now)
          ? sample
          : "interaction_unknown";
    }
    Object.assign(activity, fresh);
    const targets = this.targets(state);
    return {
      targets,
      probes,
      activity,
      policy: this.policy,
      unavailable_groups,
    };
  }
  diagnosis(
    state: CommandState,
    id: AssignmentId,
    ignoreAction?: EventId,
    fresh?: SessionActivity,
  ): UpstreamDiagnosis {
    if (this.classificationFailures.has(state.project_id))
      return this.unavailableDiagnosis(id);
    return this.diagnosisFromView(
      state,
      id,
      this.view(state, fresh),
      ignoreAction,
    );
  }
  private unavailableDiagnosis(id: AssignmentId): UpstreamDiagnosis {
    return {
      assignment_id: id,
      provider: "unknown",
      group: "unknown",
      cause: "unknown" as const,
      action: "wait" as const,
      evidence: ["classification_failed"],
    };
  }
  private diagnosisFromView(
    state: CommandState,
    id: AssignmentId,
    view: ReturnType<UpstreamHealthMonitor["view"]>,
    ignoreAction?: EventId,
    diagnoses?: ReadonlyMap<AssignmentId, UpstreamDiagnosis>,
  ): UpstreamDiagnosis {
    if (this.classificationFailures.has(state.project_id))
      return this.unavailableDiagnosis(id);
    const target = view.targets.find((t) => t.assignment_id === id);
    if (target && view.unavailable_groups.has(target.group))
      return {
        assignment_id: id,
        provider: target.provider,
        group: target.group,
        cause: "unknown" as const,
        action: "wait" as const,
        evidence: ["classification_failed"],
      };
    const interaction = view.activity[id];
    if (
      !target &&
      typeof interaction === "object" &&
      "interaction" in interaction &&
      currentInteraction(state, interaction, this.clock.now())
    ) {
      return diagnoseUpstream(
        state,
        { assignment_id: id, provider: "unknown", group: "unknown" },
        [],
        [],
        this.policy,
        this.clock.now(),
        view.activity,
      );
    }
    return target
      ? (diagnoses?.get(id) ??
          diagnoseUpstream(
            state,
            target,
            view.targets,
            view.probes,
            this.policy,
            this.clock.now(),
            view.activity,
            ignoreAction,
          ))
      : {
          assignment_id: id,
          provider: "unknown",
          group: "unknown",
          cause: "unknown" as const,
          action: "wait" as const,
          evidence: ["provider_not_resolved"],
        };
  }
  diagnostics(state: CommandState, fresh?: SessionActivity) {
    const view = this.view(state, fresh);
    const diagnoses = new Map(
      diagnoseUpstreams(
        state,
        this.classificationFailures.has(state.project_id)
          ? []
          : view.targets.filter((t) => !view.unavailable_groups.has(t.group)),
        view.probes,
        this.policy,
        this.clock.now(),
        view.activity,
      ).map((d) => [d.assignment_id, d]),
    );
    return {
      classification_available:
        view.unavailable_groups.size === 0 &&
        !this.classificationFailures.has(state.project_id),
      thresholds: this.policy,
      probe_configured: Boolean(this.config.upstream_health?.probe),
      providers: view.probes,
      sessions: state.assignments
        .filter((a) => a.status === "active" && !a.external)
        .map((a) =>
          this.diagnosisFromView(state, a.id, view, undefined, diagnoses),
        ),
    };
  }
  reconcile(store: Store, project: ProjectId, fresh?: SessionActivity) {
    try {
      let reconciled = false;
      store.uow.run((tx) => {
        const state = loadCommandState(tx, project);
        const view = this.view(state, fresh);
        if (view.unavailable_groups.size > 0) return;
        const effect = unwrap(
          recordUpstreamHealth(
            state,
            { kind: "system", project_id: project },
            view,
            { clock: this.clock, ids: tx.ids },
          ),
        );
        persistEffect(tx, project, effect);
        reconciled = true;
        for (const { event, recipient } of effect.data)
          recordNotification(store.database, {
            project_id: project,
            event_id: event.id,
            seq: event.seq,
            kind: "upstream_health",
            at: event.created_at,
            recipient,
            ...(event.card_id ? { card_id: event.card_id } : {}),
          });
      });
      if (!reconciled) return;
      // Bind legacy/injected monitors before their first reconciliation, too.
      if (!this.sampleStore) {
        for (const sample of this.samples.values())
          writeUpstreamProbeSample(
            store,
            this.configurationKey(sample.provider),
            sample,
          );
        this.sampleStore = store;
      }
      this.classificationFailures.delete(project);
    } catch {
      // Fail closed for recovery, but never stop dispatching other projects.
      this.classificationFailures.add(project);
    }
  }
  observationFailed(project: ProjectId) {
    this.classificationFailures.add(project);
  }
}
