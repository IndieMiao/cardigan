import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/**
 * C-267: de-identified review snapshot of one project.
 *
 * The CLI makes a private backup of the production database, then
 * {@link collectSensitiveValues} reads the exact values that must not leak
 * (kept in memory only), {@link scrubReviewSnapshot} rewrites the backup in
 * place, and {@link scanReviewSnapshot} independently checks the result before
 * anything is published. Scan hits name a rule and a location, never a value.
 *
 * Categories follow the card's five classes: credentials, other projects,
 * sensitive cards, personal and host data, attachments (files are never
 * copied; only metadata rows stay).
 */

/** Bump whenever a scrub or scan rule changes; recorded in manifest.json. */
export const REVIEW_SNAPSHOT_RULES_VERSION = 1;

export const REDACTED = "[已去敏]";
export const REDACTED_PATH = "[路径]";
export const REDACTED_IP = "[IP]";
export const REDACTED_SECRET = "[密钥]";
export const REDACTED_EMAIL = "[邮箱]";
export const REDACTED_HOST = "[主机]";
export const REDACTED_PROJECT = "[其它项目]";
export const MEMBER_TITLE_PLACEHOLDER = "成员";
export const memberNamePlaceholder = (id: string): string => `成员 ${id}`;

export type SnapshotCategory =
  | "credential"
  | "other_project"
  | "sensitive_card"
  | "personal"
  | "host";

/** Tables whose rows are credentials or can restore one; always emptied. */
export const CREDENTIAL_TABLES = [
  "tokens",
  "web_credential",
  "web_sessions",
  "idempotency",
] as const;
/** Host process bookkeeping (pids, process start times); always emptied. */
export const HOST_TABLES = [
  "host_deployment_capacity",
  "merge_check_capacity",
] as const;

/** Exact values read from the source; never written anywhere. */
export interface SensitiveValues {
  readonly project: string;
  /** Matched as whole words (letters, digits, `_`, `-` around do not count). */
  readonly words: ReadonlyArray<{
    readonly category: SnapshotCategory;
    readonly value: string;
  }>;
  /** Matched as plain substrings. */
  readonly literals: ReadonlyArray<{
    readonly category: SnapshotCategory;
    readonly value: string;
  }>;
}

/* ------------------------------------------------------------------ rules */

interface TextRule {
  readonly id: string;
  readonly category: SnapshotCategory;
  readonly pattern: RegExp;
  readonly replacement: string;
  /** Extra filter on a match; a rejected match is neither scrubbed nor reported. */
  readonly accept?: (match: string) => boolean;
}

const mixedToken = (match: string): boolean =>
  /[A-Z]/.test(match) && /[a-z]/.test(match) && /\d/.test(match);

/**
 * Pattern rules shared by the scrubber and the scanner. The scanner also runs
 * exact-value and table rules the scrubber cannot fool by construction.
 */
export const TEXT_RULES: readonly TextRule[] = [
  {
    id: "private_key",
    category: "credential",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replacement: REDACTED_SECRET,
  },
  {
    id: "password_hash",
    category: "credential",
    pattern: /\bscrypt\$[^\s"']+/g,
    replacement: REDACTED_SECRET,
  },
  {
    id: "token_env",
    category: "credential",
    pattern:
      /\b(?:CARDIGAN_TOKEN|[A-Z0-9_]*(?:API_KEY|SECRET|PASSWORD))=[^\s"']+/g,
    replacement: REDACTED_SECRET,
  },
  {
    id: "bearer",
    category: "credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
    replacement: REDACTED_SECRET,
  },
  {
    id: "provider_key",
    category: "credential",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
    replacement: REDACTED_SECRET,
  },
  {
    // Assignment Tokens and Workbench session ids: 32 random bytes, base64url.
    id: "random_token",
    category: "credential",
    pattern: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
    accept: mixedToken,
  },
  {
    id: "ssh_key_path",
    category: "credential",
    pattern: /(?<![\w.-])(?:~|\$HOME)\/\.ssh\/[^\s"'`<>)\]]*/g,
    replacement: REDACTED_PATH,
  },
  {
    id: "absolute_path",
    category: "host",
    pattern:
      /(?<![\w.~-])\/(?:home|Users|root|srv|var|tmp|opt|etc|mnt|media|private|run|data|workspace|usr|nix|Volumes)\/[^\s"'`<>)\]]*/g,
    replacement: REDACTED_PATH,
  },
  {
    id: "windows_path",
    category: "host",
    pattern: /(?<![\w])[A-Za-z]:\\[^\s"'`<>]*/g,
    replacement: REDACTED_PATH,
  },
  {
    id: "ipv4",
    category: "host",
    pattern:
      /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.])/g,
    replacement: REDACTED_IP,
  },
  {
    id: "ipv6",
    category: "host",
    pattern:
      /(?<![\w:])(?:(?:[0-9A-Fa-f]{1,4}:){4,7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4})?|::1)(?![\w:])/g,
    replacement: REDACTED_IP,
  },
  {
    id: "email",
    category: "personal",
    pattern:
      /(?<![\w.+-])[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g,
    replacement: REDACTED_EMAIL,
  },
];

const REPLACEMENT_BY_CATEGORY: Record<SnapshotCategory, string> = {
  credential: REDACTED_SECRET,
  other_project: REDACTED_PROJECT,
  sensitive_card: REDACTED,
  personal: REDACTED,
  host: REDACTED_HOST,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordPattern(value: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_-])${escapeRegExp(value)}(?![A-Za-z0-9_-])`,
    "g",
  );
}

/** Exact-value rules, longest first so a longer secret wins over its prefix. */
function valueRules(values: SensitiveValues): TextRule[] {
  const rules: TextRule[] = [];
  const seen = new Set<string>();
  const entries = [
    ...values.literals.map((entry) => ({ ...entry, word: false })),
    ...values.words.map((entry) => ({ ...entry, word: true })),
  ].sort((a, b) => b.value.length - a.value.length);
  for (const entry of entries) {
    const key = `${entry.word}:${entry.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({
      id: entry.word ? `${entry.category}_word` : `${entry.category}_value`,
      category: entry.category,
      pattern: entry.word
        ? wordPattern(entry.value)
        : new RegExp(escapeRegExp(entry.value), "g"),
      replacement: REPLACEMENT_BY_CATEGORY[entry.category],
    });
  }
  return rules;
}

function applyRules(text: string, rules: readonly TextRule[]): string {
  let out = text;
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (match) =>
      rule.accept === undefined || rule.accept(match)
        ? rule.replacement
        : match,
    );
  }
  return out;
}

function firstMatch(text: string, rule: TextRule): boolean {
  rule.pattern.lastIndex = 0;
  for (const match of text.matchAll(rule.pattern))
    if (rule.accept === undefined || rule.accept(match[0])) return true;
  return false;
}

/* ------------------------------------------------------------- json walk */

function parseJson(text: string): unknown {
  const head = text.trimStart()[0];
  if (head !== "{" && head !== "[") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Rewrite every string value (not key) inside a JSON value. */
function mapStrings(
  value: unknown,
  fn: (text: string, key: string | undefined) => string,
  key?: string,
): unknown {
  if (typeof value === "string") return fn(value, key);
  if (Array.isArray(value))
    return value.map((item) => mapStrings(item, fn, key));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn, k);
    return out;
  }
  return value;
}

function eachString(
  value: unknown,
  fn: (text: string, key: string | undefined) => void,
  key?: string,
): void {
  mapStrings(
    value,
    (text, k) => {
      fn(text, k);
      return text;
    },
    key,
  );
}

/** Text of a cell as a list of strings: JSON string values, or the cell. */
function cellStrings(text: string): string[] {
  const parsed = parseJson(text);
  if (parsed === undefined) return [text];
  const out: string[] = [];
  eachString(parsed, (s) => out.push(s));
  return out;
}

/* ------------------------------------------------------ member snapshots */

const MEMBER_ID = /^M-\d+$/;
const MEMBER_FIELDS = ["name", "title", "avatar"] as const;

/**
 * A copy of a Member anywhere in stored JSON: the members row itself, and the
 * full `payload.member` every member_created / member_updated global event
 * keeps — so old names survive a rename there. `M-n` ids belong to members only.
 */
function isMemberSnapshot(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    MEMBER_ID.test(record.id) &&
    MEMBER_FIELDS.some((field) => Object.hasOwn(record, field))
  );
}

function memberPlaceholder(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const id = String(record.id);
  return {
    ...record,
    ...(Object.hasOwn(record, "name")
      ? { name: memberNamePlaceholder(id) }
      : {}),
    ...(Object.hasOwn(record, "title")
      ? { title: MEMBER_TITLE_PLACEHOLDER }
      : {}),
    ...(Object.hasOwn(record, "avatar") ? { avatar: null } : {}),
  };
}

function isMemberPlaceholder(record: Record<string, unknown>): boolean {
  const expected = memberPlaceholder(record);
  return MEMBER_FIELDS.every((field) => record[field] === expected[field]);
}

/** Replace every member snapshot, at any depth, with its placeholder. */
function maskMembers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskMembers);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = maskMembers(v);
  return isMemberSnapshot(out) ? memberPlaceholder(out) : out;
}

function eachMemberSnapshot(
  value: unknown,
  fn: (record: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) eachMemberSnapshot(item, fn);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (isMemberSnapshot(value)) fn(value);
  for (const v of Object.values(value)) eachMemberSnapshot(v, fn);
}

/* --------------------------------------------------------- sensitive cards */

/**
 * Keys that form the "number and status skeleton" of a sensitive card's rows:
 * ids, references, timestamps and enums. Everything else becomes REDACTED.
 * The listed scalar keys also cover every json_extract() in the schema's
 * CHECK constraints, so a skeleton row still satisfies them.
 */
const SKELETON_KEY =
  /^(?:id|ids|seq|at|.+_id|.+_ids|.+_at|.+_seq|status|stored_status|kind|type|stream|resolution|role|role_id|template|template_key|category|outcome|verdict|merge_policy|priority|author|created_by|decider|severity|queue_reason|capabilities|allowed_tools|risk_tags|related_cards|affected_cards|affected_work_items|mentions|requested_verifiers|depends_on|blocked_work_items|superseded_by|supersedes|card|work_item|assignment|delivery|decision|review|run)$/;

function skeletonString(text: string, key: string | undefined): string {
  if (text === "") return text;
  return key !== undefined && SKELETON_KEY.test(key) ? text : REDACTED;
}

function skeletonCell(text: string): string {
  const parsed = parseJson(text);
  if (parsed === undefined) return REDACTED;
  return JSON.stringify(mapStrings(parsed, skeletonString));
}

interface TableInfo {
  readonly name: string;
  readonly textColumns: readonly string[];
  readonly hasProjectId: boolean;
}

function tables(db: DatabaseSync): TableInfo[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => {
      const name = String(row.name);
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all();
      return {
        name,
        textColumns: columns
          .filter(
            (c) => String(c.type).toUpperCase() === "TEXT" || c.type === "",
          )
          .map((c) => String(c.name)),
        hasProjectId: columns.some((c) => c.name === "project_id"),
      };
    });
}

/**
 * Ids that belong to a sensitive card: the card, its work items, their
 * deliveries and reviews, and its decisions and human actions. A row that
 * carries any of them (column or anywhere in its JSON) is reduced to the
 * skeleton.
 */
function sensitiveIds(db: DatabaseSync, project: string): Set<string> {
  const ids = new Set<string>();
  const cardRows = db
    .prepare("SELECT id, doc FROM cards WHERE project_id = ?")
    .all(project);
  for (const row of cardRows) {
    const doc = parseJson(String(row.doc)) as
      | { sensitive?: unknown }
      | undefined;
    if (doc?.sensitive === true) ids.add(String(row.id));
  }
  if (ids.size === 0) return ids;
  const cards = [...ids];
  const placeholders = cards.map(() => "?").join(",");
  const add = (sql: string, params: SQLInputValue[]): void => {
    for (const row of db.prepare(sql).all(...params)) ids.add(String(row.id));
  };
  add(
    `SELECT id FROM work_items WHERE project_id = ? AND card_id IN (${placeholders})`,
    [project, ...cards],
  );
  for (const table of ["decisions", "human_actions", "attachments"])
    add(
      `SELECT id FROM ${table} WHERE project_id = ? AND json_extract(doc, '$.card_id') IN (${placeholders})`,
      [project, ...cards],
    );
  const workItems = [...ids].filter((id) => !cards.includes(id));
  if (workItems.length > 0)
    add(
      `SELECT id FROM deliveries WHERE project_id = ? AND work_item_id IN (${workItems.map(() => "?").join(",")})`,
      [project, ...workItems],
    );
  const deliveries = db
    .prepare("SELECT id, work_item_id FROM deliveries WHERE project_id = ?")
    .all(project)
    .filter((row) => ids.has(String(row.work_item_id)))
    .map((row) => String(row.id));
  if (deliveries.length > 0)
    add(
      `SELECT id FROM reviews WHERE project_id = ? AND delivery_id IN (${deliveries.map(() => "?").join(",")})`,
      [project, ...deliveries],
    );
  return ids;
}

function mentionsAny(value: unknown, ids: ReadonlySet<string>): boolean {
  let found = false;
  eachString(value, (text) => {
    if (found) return;
    // Timeline entries are addressed as `C-n#k`.
    if (ids.has(text) || ids.has(text.split("#")[0] ?? "")) found = true;
  });
  return found;
}

function rowLinked(
  row: Record<string, unknown>,
  table: TableInfo,
  ids: ReadonlySet<string>,
): boolean {
  // A card is tied only by its own id: a related_cards mention of a
  // sensitive card must not hide an ordinary card's content.
  if (table.name === "cards") return ids.has(String(row.id));
  for (const column of table.textColumns) {
    const value = row[column];
    if (typeof value !== "string") continue;
    if (column.endsWith("_id") && ids.has(value)) return true;
    const parsed = parseJson(value);
    if (parsed !== undefined && mentionsAny(parsed, ids)) return true;
  }
  return false;
}

/** Rowids, per table, of every row tied to a sensitive card. */
function linkedRows(db: DatabaseSync, project: string): Map<string, number[]> {
  const ids = sensitiveIds(db, project);
  const out = new Map<string, number[]>();
  if (ids.size === 0) return out;
  for (const table of tables(db)) {
    if (!table.hasProjectId || BOOKKEEPING_TABLES.has(table.name)) continue;
    const rows = db
      .prepare(
        `SELECT rowid AS __rowid, * FROM "${table.name}" WHERE project_id = ?`,
      )
      .all(project);
    const linked = rows
      .filter((row) => rowLinked(row, table, ids))
      .map((row) => Number(row.__rowid));
    if (linked.length > 0) out.set(table.name, linked);
  }
  return out;
}

/**
 * Change-feed and cursor bookkeeping: only ids, sequence numbers and
 * collection names, keyed by them, so they are not reduced to a skeleton.
 * The generic text pass still applies to them.
 */
const BOOKKEEPING_TABLES = new Set([
  "command_rows",
  "command_versions",
  "event_counters",
  "id_counters",
  "router_cursors",
  "cursors",
  "bell_attempts",
]);

/** Columns of a linked row that keep their value (ids, enums, timestamps). */
function skeletonColumn(column: string): boolean {
  return SKELETON_KEY.test(column) || column === "project_id";
}

/* ---------------------------------------------------------------- collect */

/** Shorter strings are too common to remove project-wide (e.g. "开发"). */
const MIN_SENSITIVE_TEXT = 8;
/** Titles are short but identifying, so they get a lower floor. */
const MIN_SENSITIVE_TITLE = 4;
const GENERIC_TITLES = new Set(["所有者", "成员", "审批人", "观察者"]);
const HOSTNAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.-]{3,}$/;

/**
 * Read the exact values to remove and to scan for, from the private backup
 * (before scrubbing). `hostnames` adds names of the machine running the
 * command. Values are kept in memory only.
 */
export function collectSensitiveValues(
  db: DatabaseSync,
  project: string,
  options: { readonly hostnames?: readonly string[] } = {},
): SensitiveValues {
  const words: { category: SnapshotCategory; value: string }[] = [];
  const literals: { category: SnapshotCategory; value: string }[] = [];
  const all = tables(db);
  const has = (name: string): boolean => all.some((t) => t.name === name);

  // ① credentials and what can restore them.
  const literal = (category: SnapshotCategory, sql: string): void => {
    for (const row of db.prepare(sql).all()) {
      const value = row.value;
      if (typeof value === "string" && value.length >= 16)
        literals.push({ category, value });
    }
  };
  if (has("tokens"))
    literal("credential", "SELECT token_hash AS value FROM tokens");
  if (has("web_credential"))
    literal("credential", "SELECT password_hash AS value FROM web_credential");
  if (has("web_sessions"))
    literal("credential", "SELECT id_hash AS value FROM web_sessions");

  // ② other projects, from the registry and from every scoped table.
  const otherProjects = new Set<string>();
  for (const row of db.prepare("SELECT id FROM projects").all())
    otherProjects.add(String(row.id));
  for (const table of all)
    if (table.hasProjectId)
      for (const row of db
        .prepare(`SELECT DISTINCT project_id AS id FROM "${table.name}"`)
        .all())
        if (row.id !== null) otherProjects.add(String(row.id));
  otherProjects.delete(project);
  for (const value of otherProjects)
    if (value.length > 0) words.push({ category: "other_project", value });

  // ③ sensitive cards: every free-text string tied to them.
  const linked = linkedRows(db, project);
  for (const [name, rowids] of linked) {
    const table = all.find((t) => t.name === name);
    if (table === undefined) continue;
    const select = db.prepare(`SELECT * FROM "${name}" WHERE rowid = ?`);
    for (const rowid of rowids) {
      const row = select.get(rowid) ?? {};
      for (const column of table.textColumns) {
        const value = row[column];
        if (typeof value !== "string" || skeletonColumn(column)) continue;
        const parsed = parseJson(value);
        const push = (text: string, key: string | undefined): void => {
          const min =
            key === "title" ? MIN_SENSITIVE_TITLE : MIN_SENSITIVE_TEXT;
          if (
            Array.from(text.trim()).length >= min &&
            skeletonString(text, key) === REDACTED
          )
            literals.push({ category: "sensitive_card", value: text });
        };
        if (parsed === undefined) push(value, column);
        else eachString(parsed, push);
      }
    }
  }

  // ④ people and hosts.
  // Every member snapshot in every table, current and historical (renames
  // leave the old name in global_events).
  for (const table of all)
    for (const row of db.prepare(`SELECT * FROM "${table.name}"`).all())
      for (const column of table.textColumns) {
        const value = row[column];
        if (typeof value !== "string") continue;
        const parsed = parseJson(value);
        if (parsed === undefined) continue;
        eachMemberSnapshot(parsed, (member) => {
          for (const field of ["name", "title"] as const) {
            const text = member[field];
            if (
              typeof text === "string" &&
              Array.from(text.trim()).length >= 2 &&
              !GENERIC_TITLES.has(text.trim())
            )
              literals.push({ category: "personal", value: text.trim() });
          }
          const avatar = member.avatar;
          // Built-in library avatars are shared assets, not personal data.
          if (
            typeof avatar === "string" &&
            avatar.length >= 6 &&
            !avatar.startsWith("library:")
          )
            literals.push({ category: "personal", value: avatar });
        });
      }
  const reserved = reservedWords(db, project);
  const hostWord = (value: unknown): void => {
    if (typeof value !== "string") return;
    const v = value.trim();
    if (HOSTNAME_SHAPE.test(v) && !reserved.has(v.toLowerCase()))
      words.push({ category: "host", value: v });
  };
  if (has("machines"))
    for (const row of db.prepare("SELECT doc FROM machines").all()) {
      const doc = parseJson(String(row.doc)) as
        | { label?: unknown; herdr_machine?: unknown }
        | undefined;
      hostWord(doc?.label);
      hostWord(doc?.herdr_machine);
    }
  for (const name of options.hostnames ?? []) {
    hostWord(name);
    hostWord(name.split(".")[0]);
  }
  for (const row of db
    .prepare(
      "SELECT repo_path AS value FROM projects WHERE repo_path IS NOT NULL",
    )
    .all())
    if (typeof row.value === "string" && row.value.length >= 4)
      literals.push({ category: "host", value: row.value });

  return { project, words, literals };
}

/**
 * Words a host name must not be, or replacing it would break the snapshot
 * itself (project, template and role ids, OS names, our own placeholders).
 */
function reservedWords(db: DatabaseSync, project: string): Set<string> {
  const out = new Set(
    ["localhost", "linux", "darwin", "win32", "main", "cardigan", project].map(
      (v) => v.toLowerCase(),
    ),
  );
  for (const sql of [
    "SELECT DISTINCT template_id AS v FROM card_templates",
    "SELECT DISTINCT role_id AS v FROM roles",
    "SELECT id AS v FROM projects",
    "SELECT id AS v FROM machines",
  ])
    try {
      for (const row of db.prepare(sql).all())
        out.add(String(row.v).toLowerCase());
    } catch {
      // Older or partial schemas lack the table; nothing to reserve.
    }
  return out;
}

/* ------------------------------------------------------------------ scrub */

export interface ScrubSummary {
  /** Rows per table after scrubbing. */
  readonly row_counts: Readonly<Record<string, number>>;
  readonly sensitive_rows: number;
}

/**
 * Rewrite a private copy in place. Triggers are dropped for the duration (the
 * append-only and snapshot-bookkeeping triggers would refuse or record the
 * rewrite) and recreated unchanged afterwards. Run VACUUM INTO afterwards so
 * no freed page keeps a deleted value.
 */
export function scrubReviewSnapshot(
  db: DatabaseSync,
  values: SensitiveValues,
): ScrubSummary {
  const project = values.project;
  if (
    db.prepare("SELECT 1 FROM projects WHERE id = ?").get(project) === undefined
  )
    throw new Error(`project ${project} not found`);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA secure_delete = ON");
  const triggers = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL",
    )
    .all()
    .map((row) => ({ name: String(row.name), sql: String(row.sql) }));
  const all = tables(db);
  const has = (name: string): boolean => all.some((t) => t.name === name);
  let sensitiveRows = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);

    // ① and host bookkeeping: emptied outright.
    for (const name of [...CREDENTIAL_TABLES, ...HOST_TABLES])
      if (has(name)) db.exec(`DELETE FROM "${name}"`);

    // ② everything outside the project.
    db.prepare("DELETE FROM projects WHERE id <> ?").run(project);
    for (const table of all)
      if (table.hasProjectId)
        db.prepare(`DELETE FROM "${table.name}" WHERE project_id IS NOT ?`).run(
          project,
        );
    if (has("run_capacity_limits") && has("machines"))
      db.exec(
        "DELETE FROM run_capacity_limits WHERE machine_id NOT IN (SELECT id FROM machines)",
      );

    // ③ sensitive cards down to their skeleton.
    const linked = linkedRows(db, project);
    for (const [name, rowids] of linked) {
      const table = all.find((t) => t.name === name);
      if (table === undefined) continue;
      const select = db.prepare(`SELECT * FROM "${name}" WHERE rowid = ?`);
      for (const rowid of rowids) {
        const row = select.get(rowid) ?? {};
        const updates: [string, string][] = [];
        for (const column of table.textColumns) {
          const value = row[column];
          if (typeof value !== "string" || skeletonColumn(column)) continue;
          updates.push([column, skeletonCell(value)]);
        }
        updateRow(db, name, rowid, updates);
        sensitiveRows += 1;
      }
    }

    // ④ people, machines and the repository path.
    if (has("members"))
      for (const row of db
        .prepare("SELECT rowid AS r, id, doc FROM members")
        .all()) {
        const doc = parseJson(String(row.doc)) as Record<string, unknown>;
        updateRow(db, "members", Number(row.r), [
          [
            "doc",
            JSON.stringify({
              ...doc,
              name: memberNamePlaceholder(String(row.id)),
              title: MEMBER_TITLE_PLACEHOLDER,
              avatar: null,
            }),
          ],
        ]);
      }
    if (has("machines"))
      for (const row of db
        .prepare("SELECT rowid AS r, id, doc FROM machines")
        .all()) {
        const doc = parseJson(String(row.doc)) as Record<string, unknown>;
        updateRow(db, "machines", Number(row.r), [
          [
            "doc",
            JSON.stringify({
              ...doc,
              label: `机器 ${String(row.id)}`,
              herdr_machine: `machine-${String(row.id)}`,
            }),
          ],
        ]);
      }
    db.prepare(
      "UPDATE projects SET repo_path = ? WHERE repo_path IS NOT NULL",
    ).run(REDACTED_PATH);

    // Every remaining text cell: member snapshots to placeholders, then
    // exact values, then patterns.
    const rules = [...valueRules(values), ...TEXT_RULES];
    for (const table of all) {
      if (table.textColumns.length === 0) continue;
      const rows = db
        .prepare(`SELECT rowid AS __rowid, * FROM "${table.name}"`)
        .all();
      for (const row of rows) {
        const updates: [string, string][] = [];
        for (const column of table.textColumns) {
          const value = row[column];
          if (typeof value !== "string") continue;
          const next = scrubCell(value, rules);
          if (next !== value) updates.push([column, next]);
        }
        updateRow(db, table.name, Number(row.__rowid), updates);
      }
    }

    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { row_counts: rowCounts(db), sensitive_rows: sensitiveRows };
}

function scrubCell(value: string, rules: readonly TextRule[]): string {
  const parsed = parseJson(value);
  if (parsed === undefined) return applyRules(value, rules);
  return JSON.stringify(
    mapStrings(maskMembers(parsed), (text) => applyRules(text, rules)),
  );
}

function updateRow(
  db: DatabaseSync,
  table: string,
  rowid: number,
  updates: readonly (readonly [string, string])[],
): void {
  if (updates.length === 0) return;
  db.prepare(
    `UPDATE "${table}" SET ${updates.map(([c]) => `"${c}" = ?`).join(", ")} WHERE rowid = ?`,
  ).run(...updates.map(([, v]) => v), rowid);
}

export function rowCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of tables(db))
    out[table.name] = Number(
      db.prepare(`SELECT count(*) AS n FROM "${table.name}"`).get()?.n ?? 0,
    );
  return out;
}

/* ------------------------------------------------------------------- scan */

export interface ScanHit {
  readonly rule: string;
  readonly category: SnapshotCategory;
  /** Table and rowid/column, or "file" for raw database bytes. Never a value. */
  readonly table?: string;
  readonly rowid?: number;
  readonly column?: string;
  readonly where: "table" | "cell" | "file";
}

export interface ScanResult {
  readonly passed: boolean;
  readonly hits: readonly ScanHit[];
  /** Total hits; `hits` is capped. */
  readonly hit_count: number;
  readonly rules: readonly string[];
}

const MAX_REPORTED_HITS = 200;

/** Rule ids the scanner runs, recorded in manifest.json. */
export const SCAN_RULE_IDS: readonly string[] = [
  "credential_table_empty",
  "host_table_empty",
  "single_project",
  "member_placeholder",
  "member_snapshot_placeholder",
  "machine_placeholder",
  "repo_path_placeholder",
  "sensitive_card_skeleton",
  ...TEXT_RULES.map((rule) => rule.id),
  "credential_value",
  "other_project_word",
  "sensitive_card_value",
  "personal_value",
  "host_word",
  "host_value",
  "file_bytes",
];

/**
 * Check a scrubbed snapshot. `fileBytes`, when given, is the final database
 * file: exact values and key material are searched in it too, which catches
 * leftovers in free pages or journals that SQL cannot see.
 */
export function scanReviewSnapshot(
  db: DatabaseSync,
  values: SensitiveValues,
  fileBytes?: Uint8Array,
): ScanResult {
  const project = values.project;
  const hits: ScanHit[] = [];
  let count = 0;
  const hit = (h: ScanHit): void => {
    count += 1;
    if (hits.length < MAX_REPORTED_HITS) hits.push(h);
  };
  const all = tables(db);
  const has = (name: string): boolean => all.some((t) => t.name === name);

  for (const name of CREDENTIAL_TABLES)
    if (has(name) && db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get())
      hit({
        rule: "credential_table_empty",
        category: "credential",
        table: name,
        where: "table",
      });
  for (const name of HOST_TABLES)
    if (has(name) && db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get())
      hit({
        rule: "host_table_empty",
        category: "host",
        table: name,
        where: "table",
      });

  for (const row of db
    .prepare("SELECT rowid AS r FROM projects WHERE id IS NOT ?")
    .all(project))
    hit({
      rule: "single_project",
      category: "other_project",
      table: "projects",
      rowid: Number(row.r),
      where: "table",
    });
  for (const table of all)
    if (table.hasProjectId)
      for (const row of db
        .prepare(
          `SELECT rowid AS r FROM "${table.name}" WHERE project_id IS NOT ?`,
        )
        .all(project))
        hit({
          rule: "single_project",
          category: "other_project",
          table: table.name,
          rowid: Number(row.r),
          column: "project_id",
          where: "table",
        });

  if (has("members"))
    for (const row of db
      .prepare("SELECT rowid AS r, id, doc FROM members")
      .all()) {
      const doc = parseJson(String(row.doc)) as
        | Record<string, unknown>
        | undefined;
      if (
        doc?.name !== memberNamePlaceholder(String(row.id)) ||
        doc.title !== MEMBER_TITLE_PLACEHOLDER ||
        (doc.avatar !== null && doc.avatar !== undefined)
      )
        hit({
          rule: "member_placeholder",
          category: "personal",
          table: "members",
          rowid: Number(row.r),
          column: "doc",
          where: "table",
        });
    }
  if (has("machines"))
    for (const row of db
      .prepare("SELECT rowid AS r, id, doc FROM machines")
      .all()) {
      const doc = parseJson(String(row.doc)) as
        | Record<string, unknown>
        | undefined;
      if (
        doc?.label !== `机器 ${String(row.id)}` ||
        doc.herdr_machine !== `machine-${String(row.id)}`
      )
        hit({
          rule: "machine_placeholder",
          category: "host",
          table: "machines",
          rowid: Number(row.r),
          column: "doc",
          where: "table",
        });
    }
  for (const row of db
    .prepare(
      "SELECT rowid AS r FROM projects WHERE repo_path IS NOT NULL AND repo_path IS NOT ?",
    )
    .all(REDACTED_PATH))
    hit({
      rule: "repo_path_placeholder",
      category: "host",
      table: "projects",
      rowid: Number(row.r),
      column: "repo_path",
      where: "table",
    });

  for (const [name, rowids] of linkedRows(db, project)) {
    const table = all.find((t) => t.name === name);
    if (table === undefined) continue;
    const select = db.prepare(`SELECT * FROM "${name}" WHERE rowid = ?`);
    for (const rowid of rowids) {
      const row = select.get(rowid) ?? {};
      for (const column of table.textColumns) {
        const value = row[column];
        if (typeof value !== "string" || skeletonColumn(column)) continue;
        if (skeletonCell(value) !== normalizeJson(value))
          hit({
            rule: "sensitive_card_skeleton",
            category: "sensitive_card",
            table: name,
            rowid,
            column,
            where: "cell",
          });
      }
    }
  }

  const rules = [...TEXT_RULES, ...valueRules(values)];
  for (const table of all) {
    if (table.textColumns.length === 0) continue;
    for (const row of db
      .prepare(`SELECT rowid AS __rowid, * FROM "${table.name}"`)
      .all())
      for (const column of table.textColumns) {
        const value = row[column];
        if (typeof value !== "string") continue;
        const parsed = parseJson(value);
        let unmasked = false;
        eachMemberSnapshot(parsed, (member) => {
          if (!isMemberPlaceholder(member)) unmasked = true;
        });
        if (unmasked)
          hit({
            rule: "member_snapshot_placeholder",
            category: "personal",
            table: table.name,
            rowid: Number(row.__rowid),
            column,
            where: "cell",
          });
        const strings = cellStrings(value);
        for (const rule of rules)
          if (strings.some((text) => firstMatch(text, rule))) {
            hit({
              rule: rule.id,
              category: rule.category,
              table: table.name,
              rowid: Number(row.__rowid),
              column,
              where: "cell",
            });
          }
      }
  }

  if (fileBytes !== undefined) {
    const text = Buffer.from(fileBytes).toString("latin1");
    const fileRules = [
      ...valueRules(values),
      ...TEXT_RULES.filter(
        (r) => r.id === "private_key" || r.id === "password_hash",
      ),
    ];
    for (const rule of fileRules) {
      // Match UTF-8 bytes: encode the pattern's subject the same way.
      if (firstMatch(text, latin1Rule(rule)))
        hit({
          rule: `file_bytes:${rule.id}`,
          category: rule.category,
          where: "file",
        });
    }
  }

  return { passed: count === 0, hits, hit_count: count, rules: SCAN_RULE_IDS };
}

/** A rule rewritten to run over a UTF-8 buffer decoded as latin1. */
function latin1Rule(rule: TextRule): TextRule {
  const source = rule.pattern.source.replace(/[^\p{ASCII}]+/gu, (chars) =>
    Buffer.from(chars, "utf8").toString("latin1"),
  );
  return { ...rule, pattern: new RegExp(source, rule.pattern.flags) };
}

function normalizeJson(text: string): string {
  const parsed = parseJson(text);
  return parsed === undefined ? text : JSON.stringify(parsed);
}
