import {
  describeQualifiedInputError,
  type LocalInputKind,
  localInputKind,
  qualifiedInputProject,
  splitQualifiedInput,
} from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import type { CliIo } from "./io.js";

/**
 * C-675: commands whose arguments name project-scoped numbers (`C-34`,
 * `Q-12`, `attachment-3`). Global commands (members, employees, workers,
 * launch, deploy, init, project) never take one.
 */
const PROJECT_COMMANDS = new Set([
  "role",
  "assignment",
  "preference",
  "template",
  "comment",
  "attachment",
  "rework",
  "merge",
  "worktree",
  "inbox",
  "attention",
  "work-item",
  "card",
  "assign",
  "token",
  "machine",
  "pm",
  "host-ops",
  "needs-you",
  "human-action",
]);

/** Free text and JSON: a full number written there is content, never rewritten. */
const TEXT_FLAGS = new Set([
  "acceptance",
  "bio",
  "code",
  "dependency-reason",
  "description",
  "goal",
  "label",
  "merge-classification",
  "message",
  "name",
  "note",
  "quote",
  "reason",
  "requirements",
  "result",
  "set",
  "summary",
  "tags",
  "text",
  "title",
  "work-item-requirements",
]);

interface Token {
  /** Index in argv. */
  readonly index: number;
  /** Text before the value (`--entry=`), empty for a whole argument. */
  readonly prefix: string;
  readonly value: string;
}

/** Arguments that may hold numbers, with `--flag=value` split off. */
function idTokens(argv: readonly string[]): {
  readonly tokens: readonly Token[];
  readonly project: string | undefined;
} {
  const tokens: Token[] = [];
  let project: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--") break;
    if (!arg.startsWith("--")) {
      tokens.push({ index, prefix: "", value: arg });
      continue;
    }
    const separator = arg.indexOf("=");
    const name = arg.slice(2, separator < 0 ? undefined : separator);
    if (name === "project") {
      project = separator < 0 ? argv[index + 1] : arg.slice(separator + 1);
      if (separator < 0) index += 1;
      continue;
    }
    if (TEXT_FLAGS.has(name)) {
      if (separator < 0) index += 1;
      continue;
    }
    if (separator >= 0)
      tokens.push({
        index,
        prefix: arg.slice(0, separator + 1),
        value: arg.slice(separator + 1),
      });
  }
  // An empty `--project` counts as none, as in resolveProject.
  return { tokens, project: project?.trim() || undefined };
}

/** `C-1,SEN-C-2` → each comma-separated part. */
const parts = (value: string) => value.split(",").map((part) => part.trim());

/**
 * C-675: let every project command take full numbers (`SEN-C-34`,
 * `SEN-C-34#12`, `SEN-attachment-3`) as well as short ones.
 *
 * - A full number's code picks the project: the number is rewritten to its
 *   short form and `--project` is added. An explicit `--project` must name
 *   the same project; full numbers of two projects in one command are
 *   refused. `CARDIGAN_PROJECT` is only a default, so a full number wins.
 * - Without any project (no `--project`, no `CARDIGAN_PROJECT`) and with
 *   several projects, a short number some projects share is refused with
 *   the full numbers to use instead; one that exactly one project has is
 *   resolved there.
 *
 * Free-text flags are never read or rewritten. The store is opened only
 * when an argument looks like a number.
 */
export function resolveQualifiedArgs(
  argv: readonly string[],
  io: CliIo,
  openStore: () => Store,
): readonly string[] {
  if (!PROJECT_COMMANDS.has(argv[0] ?? "")) return argv;
  const { tokens, project } = idTokens(argv);
  const values = tokens.flatMap((token) => parts(token.value));
  const qualified = values.filter((v) => splitQualifiedInput(v) !== undefined);
  const short = values.flatMap((value) => {
    const kind = localInputKind(value);
    return kind === undefined ? [] : [{ value, kind }];
  });
  if (!qualified.length) {
    const context = project ?? io.env.CARDIGAN_PROJECT?.trim();
    if (!short.length || context) return argv;
    return withStore(openStore, (store) => {
      const target = uniqueProject(store, short);
      return target === undefined ? argv : [...argv, "--project", target];
    });
  }
  return withStore(openStore, (store) => {
    const resolved = qualifiedInputProject(
      values,
      (code) => store.projectByCode(code)?.id,
      project,
    );
    if (!resolved.ok)
      throw new CliError(
        describeQualifiedInputError(resolved.error, (p) => ` --project ${p} `),
        EXIT.usage,
      );
    const target = resolved.value as string;
    const rewritten = [...argv];
    for (const token of tokens) {
      const local = parts(token.value).map(
        (part) => splitQualifiedInput(part)?.id ?? part,
      );
      if (local.join(",") !== parts(token.value).join(","))
        rewritten[token.index] = `${token.prefix}${local.join(",")}`;
    }
    // The last `--project` wins in every parser, so an empty one is overridden.
    if (project !== undefined) return rewritten;
    const end = rewritten.indexOf("--");
    if (end < 0) return [...rewritten, "--project", target];
    rewritten.splice(end, 0, "--project", target);
    return rewritten;
  });
}

function withStore<T>(openStore: () => Store, use: (store: Store) => T): T {
  const store = openStore();
  try {
    return use(store);
  } finally {
    store.close();
  }
}

/**
 * The one project every short number belongs to, or undefined when the
 * normal "several projects" refusal should stand. A number several projects
 * share is refused here, naming the full numbers.
 */
function uniqueProject(
  store: Store,
  short: readonly { readonly value: string; readonly kind: LocalInputKind }[],
): string | undefined {
  const projects = store.listProjects();
  if (projects.length < 2) return undefined;
  const codes = new Map(projects.map((p) => [p.id, p.code]));
  let owner: string | undefined;
  for (const { value, kind } of short) {
    const holders = store.projectsHoldingId(kind, value);
    if (holders.length > 1)
      throw new CliError(
        `${value} 在多个项目里都有：${holders
          .map((p) => {
            const code = codes.get(p);
            return `${code ? `${code}-${value}` : value}（${p}）`;
          })
          .join("、")}；请改用完整编号，或用 --project 指定项目`,
        EXIT.usage,
      );
    const [only] = holders;
    if (only === undefined) return undefined;
    if (owner !== undefined && owner !== only) return undefined;
    owner = only;
  }
  return owner;
}
