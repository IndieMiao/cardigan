import { splitQualifiedId } from "@cardigan/domain";
import type { CardiganClient } from "./api.js";
import { linkableReferences, referenceHref } from "./refs.js";
import { routeHash } from "./route.js";

/**
 * C-675: where a full number typed into a search box (`SEN-C-34`,
 * `SEN-Q-12`, `SEN-H-46`) leads, in whichever project its code names.
 * Undefined for anything else (short numbers, text) or a number nothing
 * has, so the box keeps filtering as before.
 *
 * A decision or human action without a card opens that project's Needs You.
 */
export async function fullIdHref(
  client: Pick<CardiganClient, "resolveFullId">,
  value: string,
): Promise<string | undefined> {
  const id = value.trim();
  if (splitQualifiedId(id) === undefined || !client.resolveFullId)
    return undefined;
  const resolved = await client.resolveFullId(id);
  const [reference] = linkableReferences(resolved ? [resolved] : []);
  const projectId = reference?.project_id;
  if (reference === undefined || projectId === undefined) return undefined;
  return (
    referenceHref(reference, projectId) ??
    routeHash({ kind: "needs-you", projectId })
  );
}
