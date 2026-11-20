import { idBadgeClass, idType } from "../../id-types.js";
/** `titled={false}` drops the native type hint where a richer tooltip covers it. */
export function IdBadge({
  id,
  titled = true,
}: {
  id: string;
  titled?: boolean;
}) {
  return (
    <span
      data-ui="id-badge"
      className={idBadgeClass(id)}
      title={titled ? idType(id)?.label : undefined}
    >
      {id}
    </span>
  );
}
