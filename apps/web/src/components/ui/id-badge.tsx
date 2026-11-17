import { idBadgeClass, idType } from "../../id-types.js";
export function IdBadge({ id }: { id: string }) {
  return (
    <span
      data-ui="id-badge"
      className={idBadgeClass(id)}
      title={idType(id)?.label}
    >
      {id}
    </span>
  );
}
