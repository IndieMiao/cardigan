import type { Actor, Event } from "../entities.js";
import type { NotificationRecipient } from "../notification.js";
import {
  hasUnfinishedUpstreamRun,
  lastUpstreamInactivity,
  recurrentUpstreamFailure,
  type SessionActivity,
  type UpstreamPolicy,
  type UpstreamProbe,
  type UpstreamTarget,
  upstreamActivityAfter,
  upstreamCluster,
  upstreamIncident,
  upstreamRecoverySince,
} from "../upstream-health.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

/** Host observations are projected into durable incidents, inbox work and human notices. */
export function recordUpstreamHealth(
  state: CommandState,
  actor: Actor,
  p: {
    targets: readonly UpstreamTarget[];
    probes: readonly UpstreamProbe[];
    policy: UpstreamPolicy;
    activity: SessionActivity;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    ensure(
      Object.values(p.policy).every((v) => Number.isSafeInteger(v) && v > 0),
      "validation_failed",
      "Invalid upstream policy",
    );
    const notices: { event: Event; recipient: NotificationRecipient }[] = [];
    const hostOps = state.assignments.find(
      (a) =>
        a.scope === "standing" &&
        a.role_id === "host_ops" &&
        a.status === "active",
    );
    const notify = (event: Event) => {
      if (hostOps)
        notices.push({
          event,
          recipient: { kind: "assignment", assignment_id: hostOps.id },
        });
      notices.push({ event, recipient: { kind: "pm_office" } });
    };
    const requestHuman = (body: string, key: string) => {
      const id = d.ids.next(state.project_id, "human_action");
      d.put("human_actions", {
        id,
        key: id,
        requested_by: "system",
        status: "open",
        triage: "human",
        blocked_work_items: [],
        instructions: body,
        why_human: "上游线路异常，需要人知悉或检查线路；主机运维不会反复重启。",
        expected_return: "核对线路与恢复记录后填写结果。",
      });
      d.emit(
        "human_action_requested",
        undefined,
        { human_action_id: id, upstream_key: key, disposition: "human" },
        { type: "human_action", body, human_action_id: id },
      );
    };
    for (const probe of p.probes) {
      if (!probe.checked_at || probe.status === "unknown") continue;
      const previous = state.events.findLast(
        (e) =>
          e.type === "upstream_probe_changed" &&
          (e.payload as { provider: string }).provider === probe.provider,
      );
      if (
        previous &&
        (previous.payload as { status: string }).status === probe.status &&
        (previous.payload as { group: string }).group === probe.group &&
        (previous.payload as { last_failure_at?: string }).last_failure_at ===
          probe.last_failure_at
      )
        continue;
      d.emit("upstream_probe_changed", undefined, { ...probe });
    }
    for (const group of new Set(p.targets.map((t) => t.group))) {
      const targets = p.targets.filter((t) => t.group === group);
      const failed = p.probes.some(
        (probe) => probe.group === group && probe.status === "unreachable",
      );
      const cluster = upstreamCluster(state, targets, p.policy, p.activity);
      const incident = upstreamIncident(state, group);
      const affected = failed
        ? targets
            .filter((t) => hasUnfinishedUpstreamRun(state, t.assignment_id))
            .map((t) => t.assignment_id)
        : incident
          ? targets
              .filter(
                (t) =>
                  p.activity[t.assignment_id] !== "working" &&
                  lastUpstreamInactivity(state, t.assignment_id),
              )
              .map((t) => t.assignment_id)
          : cluster;
      if (!incident && affected.length) {
        const providers = [...new Set(targets.map((t) => t.provider))];
        const body = `上游线路 ${group}（provider: ${providers.join(", ")}）从 ${d.now} 起疑似中断；影响 ${affected.join(", ")}。依据：${failed ? "无凭据连接探测失败" : "同线路多个会话在配置窗口内失活"}。先不重启，复查时必须看到会话活动恢复证据；探测成功不代表模型 API 请求成功。`;
        const event = d.emit(
          "upstream_incident_started",
          undefined,
          {
            group,
            providers,
            assignment_ids: affected,
            evidence: failed
              ? "connection_probe_failed"
              : "clustered_inactivity",
            body,
          },
          { type: "system", body },
        );
        notify(event);
        requestHuman(body, event.id);
      } else if (incident) {
        if (
          !failed &&
          Date.parse(d.now) - Date.parse(incident.started_at) >=
            p.policy.inactivity_window_ms &&
          targets.some((t) =>
            upstreamActivityAfter(
              state,
              t.assignment_id,
              upstreamRecoverySince(incident, p.probes),
            ),
          ) &&
          !state.events.some(
            (e) =>
              e.type === "upstream_recovery_ready" &&
              (e.payload as { incident_id: string }).incident_id ===
                incident.id,
          )
        ) {
          const body = `上游线路 ${group} 已有活动恢复证据，复查窗口已到；主机运维请统一核对仍失活的会话，每个会话只恢复一次。`;
          const event = d.emit(
            "upstream_recovery_ready",
            undefined,
            { incident_id: incident.id, group, body },
            { type: "system", body },
          );
          notify(event);
        }
        const added = affected.filter(
          (id) => !incident.assignment_ids.includes(id),
        );
        if (added.length) {
          const body = `上游线路 ${group} 的中断新增受影响会话：${added.join(", ")}；继续等待线路和活动恢复证据。`;
          const event = d.emit(
            "upstream_incident_expanded",
            undefined,
            {
              incident_id: incident.id,
              group,
              assignment_ids: added,
              body,
            },
            { type: "system", body },
          );
          notify(event);
        }
        if (
          !failed &&
          !added.length &&
          incident.assignment_ids.every(
            (id) =>
              !targets.some((t) => t.assignment_id === id) ||
              !hasUnfinishedUpstreamRun(state, id) ||
              (!lastUpstreamInactivity(state, id) &&
                upstreamActivityAfter(
                  state,
                  id,
                  upstreamRecoverySince(incident, p.probes),
                )),
          )
        ) {
          const body = `上游线路 ${group} 的受影响会话已恢复活动；请核对恢复记录，避免重复重启。`;
          const event = d.emit(
            "upstream_incident_resolved",
            undefined,
            { incident_id: incident.id, group, body },
            { type: "system", body },
          );
          notify(event);
          const requested = state.events.find(
            (e) =>
              e.type === "human_action_requested" &&
              (e.payload as { upstream_key?: string }).upstream_key ===
                incident.id,
          );
          if (requested) {
            const action = state.human_actions.find(
              (h) =>
                h.id ===
                (requested.payload as { human_action_id: string })
                  .human_action_id,
            );
            if (action?.status === "open") {
              d.put("human_actions", { ...action, status: "cancelled" });
              d.emit("human_action_cancelled", undefined, {
                human_action_id: action.id,
                reason: "upstream_activity_recovered",
              });
            }
          }
        }
      }
      for (const target of targets) {
        if (p.activity[target.assignment_id] === "working") continue;
        const recovery = recurrentUpstreamFailure(
          state,
          target.assignment_id,
          p.policy,
        );
        const inactive = lastUpstreamInactivity(state, target.assignment_id);
        if (
          !recovery ||
          !inactive ||
          state.events.some(
            (e) =>
              e.type === "upstream_recovery_recurred" &&
              (e.payload as { inactive_event_id: string }).inactive_event_id ===
                inactive.id,
          )
        )
          continue;
        const body = `${target.assignment_id} 在恢复后的配置复发窗口内再次失活，疑似上游线路 ${group} 中断；不再重启，请人检查。前次恢复 ${recovery.id}，本次失活 ${inactive.id}。`;
        const event = d.emit(
          "upstream_recovery_recurred",
          inactive.card_id,
          {
            assignment_id: target.assignment_id,
            group,
            recovery_event_id: recovery.id,
            inactive_event_id: inactive.id,
            body,
          },
          { type: "system", body },
        );
        notify(event);
        requestHuman(body, event.id);
      }
    }
    return notices;
  });
}
