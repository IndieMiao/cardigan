import type { DatabaseSync, StatementSync } from "node:sqlite";

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** Fixed repository queries, shared across this connection's serial transactions. */
export function prepare(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) {
    cache = new Map();
    statements.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}
