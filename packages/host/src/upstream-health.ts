import { createHash, randomUUID } from "node:crypto";
import { connect as connectTcp, isIP } from "node:net";
import { connect as connectTls } from "node:tls";
import {
  type AssignmentId,
  type Clock,
  type CommandState,
  DEFAULT_UPSTREAM_POLICY,
  diagnoseUpstream,
  type EventId,
  type ProjectId,
  type Runtime,
  recordUpstreamHealth,
  type SessionActivity,
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
  private pending: Promise<void> | undefined;
  private readonly classificationFailures = new Set<ProjectId>();
  private lastPoll = Number.NEGATIVE_INFINITY;
  private readonly abort = new AbortController();
  constructor(
    private readonly config: LaunchConfig,
    private readonly runtime: Runtime,
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
    return state.assignments
      .filter(
        (a) =>
          a.status === "active" &&
          !a.external &&
          (a.scope !== "work_item" ||
            !state.cards.some(
              (c) =>
                ["done", "cancelled"].includes(c.status) &&
                state.work_items.some(
                  (w) => w.id === a.work_item_id && w.card_id === c.id,
                ),
            )),
      )
      .flatMap((a) => {
        const run = state.runs.findLast(
          (r) => r.assignment_id === a.id && r.launch_profile_ref,
        );
        const ref =
          run?.launch_profile_ref ??
          state.employees?.find((e) => e.id === a.employee_id)
            ?.launch_profile_ref;
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
  ) {
    if (this.classificationFailures.has(state.project_id))
      return {
        assignment_id: id,
        provider: "unknown",
        group: "unknown",
        cause: "unknown" as const,
        action: "wait" as const,
        evidence: ["classification_failed"],
      };
    const view = this.view(state, fresh);
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
    return target
      ? diagnoseUpstream(
          state,
          target,
          view.targets,
          view.probes,
          this.policy,
          this.clock.now(),
          view.activity,
          ignoreAction,
        )
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
    return {
      classification_available:
        view.unavailable_groups.size === 0 &&
        !this.classificationFailures.has(state.project_id),
      thresholds: this.policy,
      probe_configured: Boolean(this.config.upstream_health?.probe),
      providers: view.probes,
      sessions: state.assignments
        .filter((a) => a.status === "active" && !a.external)
        .map((a) => this.diagnosis(state, a.id, undefined, fresh)),
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
