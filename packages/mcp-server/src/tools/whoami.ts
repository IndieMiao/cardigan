import { z } from "zod";
import { defineTool } from "./types.js";

/**
 * Return the assignment context the token belongs to (§9.2).
 *
 * The identity comes from the token; anything the caller sends is ignored, so a
 * tool parameter can never impersonate another assignment.
 */
export const whoamiTool = defineTool({
  name: "whoami",
  description:
    "Return the assignment, role, machine and worktree bound to the bearer token",
  input: z.object({}),
  handler: (_args, { store, identity }) => {
    const { assignment, actor, role } = identity;
    const work_item =
      assignment.scope === "work_item"
        ? store.uow.read((tx) =>
            tx.work_items.get(actor.project_id, assignment.work_item_id),
          )
        : undefined;

    const employee = store.uow.read((tx) =>
      assignment.employee_id
        ? tx.employees?.get(assignment.employee_id)
        : undefined,
    );
    return {
      employee_id: employee?.id ?? null,
      employee_name: employee?.name ?? null,
      employee_title: employee?.title ?? null,
      project_id: actor.project_id,
      assignment_id: assignment.id,
      role_id: role.role_id,
      role_version: role.role_version,
      capabilities: actor.capabilities,
      allowed_tools: actor.allowed_tools,
      scope: assignment.scope,
      work_item_id:
        assignment.scope === "work_item" ? assignment.work_item_id : null,
      card_id: work_item?.card_id ?? null,
      machine_id: assignment.machine_id,
      worktree_path: assignment.worktree_path ?? null,
      branch: assignment.branch ?? null,
      base_sha: assignment.base_sha ?? null,
      session_ref: assignment.session_ref ?? null,
    };
  },
});
