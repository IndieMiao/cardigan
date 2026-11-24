import { type ProjectId, setProjectPreferences } from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

/** Legacy launch/CLI fixtures must register every role referenced by dev. */
export function registerTemplateRoles(store: Store, project: string): void {
  store.uow.run((tx) => {
    for (const role_id of ["coder", "reviewer", "pm"]) {
      if (tx.roles.list(project).some((r) => r.role_id === role_id)) continue;
      tx.roles.put(project, {
        role_id,
        role_version: 1,
        capabilities: [],
        allowed_tools: [
          role_id === "coder" ? "submit_delivery" : "submit_review",
        ],
      });
    }
  });
}

/**
 * C-684: a person (no Token) may only open story cards until the project opens
 * other templates; fixtures that create dev and other cards open them first.
 */
export function openHumanCardTemplates(
  store: Store,
  project: string,
  templates: readonly string[] = ["dev", "general", "design", "artifact"],
): void {
  store.uow.run((tx) => {
    const effect = unwrap(
      setProjectPreferences(
        loadCommandState(tx, project as ProjectId),
        { kind: "human", project_id: project as ProjectId },
        {
          human_card_templates: Object.fromEntries(
            templates.map((id) => [id, true]),
          ),
        },
        { clock: { now: () => new Date().toISOString() }, ids: tx.ids },
      ),
    );
    persistEffect(tx, project as ProjectId, effect);
  });
}
