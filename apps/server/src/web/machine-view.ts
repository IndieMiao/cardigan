import { DEFAULT_MAX_RUN_LIMIT, type Machine } from "@cardigan/domain";
import {
  effectiveRunLimit,
  parseMachineCapabilityCatalog,
  type ReadResourceLimits,
} from "@cardigan/host";
import {
  readMachineObservationsInTransaction,
  type Store,
} from "@cardigan/store";
import {
  declaredCapabilities,
  machineObservationView,
} from "./execution-state.js";
import type { MachineHost } from "./machine-host.js";
import { inIds, readDocs } from "./sql-state.js";

export interface MachineViewOptions {
  readonly checks: import("./machine-checks.js").MachineChecks;
  readonly runLimit?: ((id: string) => number) | undefined;
  readonly runLimitMaximum?: ((id: string) => number) | undefined;
  readonly resourceLimits?: ReadResourceLimits | undefined;
  readonly host?: MachineHost | undefined;
  /** C-708: the host capability catalog (keys and platforms), as the execution read uses it. */
  readonly capabilityCatalog?:
    | (() => readonly {
        readonly key: string;
        readonly os: readonly string[];
      }[])
    | undefined;
}
/**
 * C-708: how the host checks a built-in capability: the fixed argv, or the
 * labels of the places the browser search looks. Checks from the private
 * custom catalog are not shown.
 */
export type CapabilityProbeView =
  | { readonly kind: "command"; readonly argv: readonly string[] }
  | { readonly kind: "search"; readonly locations: readonly string[] };
function builtinProbes(os: string): ReadonlyMap<string, CapabilityProbeView> {
  try {
    return new Map(
      parseMachineCapabilityCatalog(undefined, undefined, os).map((c) => [
        c.key,
        "scopes" in c.check
          ? {
              kind: "search" as const,
              locations: c.check.scopes.map((s) => s.label),
            }
          : { kind: "command" as const, argv: [...c.check] },
      ]),
    );
  } catch {
    return new Map();
  }
}
export function machineView(
  store: Store,
  current: string,
  options: MachineViewOptions,
  now: string,
  only?: string,
) {
  // Snapshot the private configuration once, outside the DB transaction. A bad
  // configuration never falls back to the legacy local execution account.
  let binding: ReturnType<MachineHost["bindings"]> | undefined;
  let configAvailable = options.host !== undefined;
  try {
    binding = options.host?.bindings();
  } catch {
    configAvailable = false;
  }
  const declared = declaredCapabilities(options.capabilityCatalog);
  const probes = new Map<string, ReadonlyMap<string, CapabilityProbeView>>();
  const probesFor = (os: string) => {
    const known = probes.get(os);
    if (known) return known;
    const found = builtinProbes(os);
    probes.set(os, found);
    return found;
  };
  const machines = store.uow.read((tx) => {
    const projects = store.listProjects();
    const rows = projects.flatMap((p) => {
      const registrations =
        only === undefined
          ? tx.machines.list(p.id)
          : [tx.machines.get(p.id, only)].filter((m): m is Machine => !!m);
      if (!registrations.length) return [];
      const active = readDocs(
        store,
        p.id,
        "assignments",
        "json_extract(doc,'$.status') = 'active'",
      );
      const runs = readDocs(
        store,
        p.id,
        "runs",
        "json_extract(doc,'$.status') IN ('running','acked','dispatched')",
      );
      const triggers = new Map(
        readDocs(store, p.id, "events", inIds("id"), [
          JSON.stringify(runs.map((r) => r.trigger_event_id)),
        ]).map((e) => [e.id, e.card_id]),
      );
      return registrations.map((m) => {
        // C-708: only this project's binding lists the catalog keys not yet
        // verified, with the host's probe and the last check's failures.
        const mine = p.id === current;
        const observed = machineObservationView(
          store,
          p.id,
          m,
          now,
          mine ? declared?.(m) : undefined,
        );
        const failures = mine
          ? (readMachineObservationsInTransaction(store, p.id, m.id, now).health
              ?.capability_failures ?? [])
          : [];
        const probe = mine ? probesFor(m.os) : undefined;
        const assignments = active
          .filter((a) => a.machine_id === m.id)
          .map((a) => {
            const work = a.work_item_id
              ? tx.work_items.get(p.id, a.work_item_id)
              : null;
            return {
              assignment_id: a.id,
              role_id: a.role_id,
              employee_id: a.employee_id ?? null,
              employee_name: a.employee_id
                ? (tx.employees.get(a.employee_id)?.name ?? null)
                : null,
              card_id: work?.card_id ?? null,
              runs: runs
                .filter((r) => r.assignment_id === a.id)
                .map((r) => ({
                  id: r.id,
                  status: r.status,
                  card_id:
                    work?.card_id ?? triggers.get(r.trigger_event_id) ?? null,
                })),
            };
          });
        return {
          id: m.id,
          label: m.label,
          os: m.os,
          arch: m.arch,
          project_id: p.id,
          project_name: p.name,
          is_current: p.id === current,
          status: m.status,
          last_seen: m.last_seen,
          registered_max_assignments: m.max_assignments,
          runtime: binding?.(p.id, m.id) ?? null,
          config_available: configAvailable,
          capabilities: observed.capabilities.map((c) => {
            const how = probe?.get(c.key);
            return how ? { ...c, probe: how } : c;
          }),
          capability_failures: failures.map((f) => ({
            key: f.key,
            search_locations: [...f.search_locations],
            ...(f.search_incomplete ? { search_incomplete: true } : {}),
            ...(f.reason ? { reason: f.reason } : {}),
          })),
          machine_check: observed.health,
          last_requested_check: options.checks.latest(m.id, p.id),
          assignments,
        };
      });
    });
    const ids = [...new Set(rows.map((r) => r.id))].sort();
    return ids.map((id) => {
      const bindings = rows.filter((r) => r.id === id);
      const primary = bindings.find((b) => b.is_current) ?? bindings[0];
      if (!primary) throw new Error("Missing machine registration");
      const limit = effectiveRunLimit(
        store,
        id,
        options.runLimit,
        options.runLimitMaximum,
      );
      return {
        id,
        label: primary.label,
        os: primary.os,
        arch: primary.arch,
        status: ["draining", "offline", "degraded", "online"].find((status) =>
          bindings.some((b) => b.status === status),
        ),
        last_seen:
          bindings
            .map((b) => b.last_seen)
            .sort()
            .at(-1) ?? primary.last_seen,
        max_assignments: limit,
        run_limit: limit,
        run_limit_maximum:
          options.runLimitMaximum?.(id) ?? DEFAULT_MAX_RUN_LIMIT,
        resources: [...(options.resourceLimits?.(id) ?? [])].map(
          ([key, limit]) => ({ key, limit }),
        ),
        bindings,
      };
    });
  });
  return machines.map((m) => ({
    ...m,
    bindings: m.bindings.map((b) => {
      try {
        return {
          ...b,
          worker_check: options.host?.workerRecord(b.project_id, m.id) ?? null,
          worker_record_readable: !!options.host,
        };
      } catch {
        return { ...b, worker_check: null, worker_record_readable: false };
      }
    }),
  }));
}
