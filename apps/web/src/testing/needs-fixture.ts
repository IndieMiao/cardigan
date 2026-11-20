import type { NeedsCounts, NeedsPage, NeedsTab } from "../api.js";

/** In-memory HTTP fixture behavior; production eligibility comes from domain. */
export function fixtureNeedsSection(
  page: NeedsPage,
  section: NeedsTab,
): NeedsPage {
  const empty = { decisions: [], human_actions: [], incidents: [] };
  const merge = (q: NeedsPage["decisions"][number]) =>
    q.trigger === "merge_confirmation" && !q.followup_notice;
  if (section === "decisions")
    return { ...empty, decisions: page.decisions.filter((q) => !merge(q)) };
  if (section === "merges")
    return {
      ...empty,
      decisions: page.decisions.filter(merge),
      ...(page.pm_held_merges ? { pm_held_merges: page.pm_held_merges } : {}),
      ...(page.auto_merge_pause
        ? { auto_merge_pause: page.auto_merge_pause }
        : {}),
      ...(page.waiting_merge_checks_count
        ? { waiting_merge_checks_count: page.waiting_merge_checks_count }
        : {}),
      ...(page.waiting_merge_check_items
        ? { waiting_merge_check_items: page.waiting_merge_check_items }
        : {}),
    };
  if (section === "actions")
    return {
      ...empty,
      human_actions: page.human_actions,
      incidents: page.incidents,
      ...(page.provider_incidents
        ? { provider_incidents: page.provider_incidents }
        : {}),
      ...(page.attention ? { attention: page.attention } : {}),
      ...(page.system_rule_attention
        ? { system_rule_attention: page.system_rule_attention }
        : {}),
      ...(page.incident_handling
        ? { incident_handling: page.incident_handling }
        : {}),
    };
  if (section === "later") return { ...empty, later: page.later ?? [] };
  return {
    ...empty,
    notices: page.notices ?? [],
    notices_next_cursor: page.notices_next_cursor ?? null,
  };
}
export function fixtureNeedsCounts(page: NeedsPage): NeedsCounts {
  const decisions = fixtureNeedsSection(page, "decisions").decisions.length;
  const merges = fixtureNeedsSection(page, "merges").decisions.length;
  const actions = page.human_actions.filter((a) => a.triage !== "host").length;
  const attention = page.incidents.length + (page.attention?.length ?? 0);
  const system = page.system_rule_attention?.length ?? 0;
  return {
    total_pending: decisions + merges + actions + attention,
    tabs: {
      decisions: { count: decisions, attention: decisions },
      merges: {
        count: merges + (page.pm_held_merges?.length ?? 0),
        attention: merges,
      },
      actions: {
        count: page.human_actions.length + attention + system,
        attention: actions + attention + system,
      },
      later: { count: page.later?.length ?? 0, attention: 0 },
      notices: {
        count: page.notices?.length ?? 0,
        attention: page.notices?.filter((n) => !n.read).length ?? 0,
      },
    },
  };
}
