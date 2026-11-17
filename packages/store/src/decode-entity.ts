/** Read compatibility only: never rewrite historical card JSON on startup. */
export function decodeEntity(table: string, doc: string): unknown {
  const entity = JSON.parse(doc);
  return table === "cards"
    ? { ...entity, flow_version: entity.flow_version ?? 1 }
    : entity;
}
