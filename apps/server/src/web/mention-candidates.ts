import type {
  Assignment,
  CardId,
  EmployeeId,
  ProjectId,
} from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { webAvatarPath } from "./read.js";

export interface MentionCandidate {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly avatar: string | null;
  /** Works on this card, wrote on its timeline, or is a standing PM. */
  readonly related: boolean;
}

/**
 * `@` suggestions for one card's comment box: active employees by public
 * profile only. Routing stays with the server's `@<employee name>` parsing;
 * this read only tells the box who to offer and who belongs to the card.
 */
export function readMentionCandidates(
  store: Store,
  project_id: ProjectId,
  card_id: CardId,
): { employees: MentionCandidate[] } | undefined {
  return store.uow.read((tx) => {
    if (!tx.cards.get(project_id, card_id)) return undefined;
    const assignments = new Map<string, Assignment>(
      tx.assignments.list(project_id).map((a) => [a.id, a]),
    );
    const related = new Set<EmployeeId>();
    const add = (assignmentId: string | undefined) => {
      const employee = assignmentId
        ? assignments.get(assignmentId)?.employee_id
        : undefined;
      if (employee) related.add(employee);
    };
    for (const item of tx.work_items.list(project_id))
      if (item.card_id === card_id) add(item.assignment_id);
    // Every author on the card, including entries on pages not yet loaded.
    for (const row of store.database
      .prepare(
        "SELECT DISTINCT json_extract(doc, '$.author') AS author FROM timeline WHERE project_id = ? AND card_id = ?",
      )
      .all(project_id, card_id)) {
      const author = String(row.author ?? "");
      if (author.startsWith("assignment:")) add(author.slice(11));
    }
    for (const assignment of assignments.values())
      if (
        assignment.scope === "standing" &&
        assignment.role_id === "pm" &&
        assignment.status === "active"
      )
        add(assignment.id);
    return {
      employees: tx.employees
        .list()
        .filter((employee) => employee.status === "active")
        .map((employee) => ({
          id: employee.id,
          name: employee.name,
          title: employee.title,
          avatar: webAvatarPath(employee.avatar),
          related: related.has(employee.id),
        })),
    };
  });
}
