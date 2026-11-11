import type { DatabaseSync } from "node:sqlite";

/** Fixed identifiers only; these triggers also cover CLI/other-process writes. */
export const snapshotTables: Readonly<Record<string, readonly string[]>> = {
  cards: ["id"],
  work_items: ["id"],
  assignments: ["id"],
  runs: ["id"],
  timeline: ["id"],
  deliveries: ["id"],
  reviews: ["id"],
  decisions: ["id"],
  human_actions: ["id"],
  attachments: ["id"],
  roles: ["role_id", "role_version"],
  cursors: ["assignment_id", "card_id"],
  card_templates: ["template_id", "version"],
  project_preferences: ["id"],
  events: ["id"],
};

export function installSnapshotTriggers(db: DatabaseSync): void {
  for (const [table, keys] of Object.entries({
    ...snapshotTables,
    employees: ["id"],
    members: ["id"],
    assignment_activity: ["assignment_id"],
  })) {
    const global = ["employees", "members", "assignment_activity"].includes(
      table,
    );
    const change = (ref: "OLD" | "NEW") => {
      const project = global ? "''" : `${ref}.project_id`;
      return `INSERT INTO command_versions VALUES (${project}, '${table}', 1)
        ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
        ${
          global
            ? ""
            : `INSERT INTO command_rows VALUES (${project}, '${table}',
          json_array(${keys.map((k) => `${ref}.${k}`).join(",")}),
          (SELECT version FROM command_versions WHERE project_id = ${project} AND collection = '${table}'))
        ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;`
        }`;
    };
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const)
      db.exec(`CREATE TRIGGER snapshot_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
        ${table === "assignment_activity" ? `WHEN ${operation === "INSERT" ? "NEW.employee_id IS NOT NULL" : operation === "DELETE" ? "OLD.employee_id IS NOT NULL" : "OLD.employee_id IS NOT NULL OR NEW.employee_id IS NOT NULL"}` : ""}
        BEGIN ${operation === "INSERT" ? "" : change("OLD")}
        ${operation === "DELETE" ? "" : change("NEW")} END;`);
  }

  const project = (where: string) => `INSERT INTO assignment_activity
    SELECT a.project_id, a.id, json_extract(a.doc, '$.employee_id'),
      json_extract(a.doc, '$.created_at'),
      (SELECT COUNT(*) FROM runs r WHERE r.project_id = a.project_id AND r.assignment_id = a.id
        AND json_extract(r.doc, '$.status') NOT IN ('completed', 'failed', 'cancelled')),
      CASE WHEN json_extract(a.doc, '$.scope') = 'standing'
        AND json_extract(a.doc, '$.external') = 1 AND json_extract(a.doc, '$.status') != 'released'
        THEN 1 ELSE 0 END
    FROM assignments a WHERE ${where}
    ON CONFLICT(project_id, assignment_id) DO UPDATE SET
      employee_id = excluded.employee_id, last_assigned_at = excluded.last_assigned_at,
      unfinished_runs = excluded.unfinished_runs, external_standing = excluded.external_standing
    WHERE employee_id IS NOT excluded.employee_id OR last_assigned_at IS NOT excluded.last_assigned_at
      OR unfinished_runs != excluded.unfinished_runs OR external_standing != excluded.external_standing;`;
  db.exec(project("1"));
  for (const table of ["assignments", "runs"]) {
    const key = table === "assignments" ? "id" : "assignment_id";
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const refresh = (ref: "OLD" | "NEW") =>
        project(`a.project_id = ${ref}.project_id AND a.id = ${ref}.${key}`);
      db.exec(`CREATE TRIGGER activity_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
        BEGIN ${operation === "INSERT" ? "" : refresh("OLD")}
        ${operation === "DELETE" ? "" : refresh("NEW")}
        ${
          table === "assignments" && operation !== "INSERT"
            ? `DELETE FROM assignment_activity
          WHERE project_id = OLD.project_id AND assignment_id = OLD.id AND NOT EXISTS
            (SELECT 1 FROM assignments WHERE project_id = OLD.project_id AND id = OLD.id);`
            : ""
        }
        END;`);
    }
  }
}
