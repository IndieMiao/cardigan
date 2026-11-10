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
