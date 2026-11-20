import { stripVTControlCharacters } from "node:util";
import { lineFragments } from "./check-log-lines.js";

export interface StepTime {
  readonly name: string;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
  readonly conclusion: string | null;
}
const commands = new Map([
  ["pnpm install --frozen-lockfile", "install"],
  ["pnpm build", "build"],
  ['workers="$(getconf _NPROCESSORS_ONLN)"', "test"],
  ["pnpm lint", "lint"],
  ["pnpm check:deps", "deps"],
  ["pnpm test:e2e", "e2e"],
]);
/** Raw download covers the entire job. REST step boundaries have one-second precision. */
export function githubJobLog(
  steps: readonly StepTime[],
  checks: readonly string[],
  emit: (name: string, text: string) => void,
) {
  const windows = steps
    .filter((s) => s.conclusion !== "skipped")
    .map((s) => ({
      name: s.name,
      from: Date.parse(s.started_at ?? ""),
      to: Date.parse(s.completed_at ?? "") + 999,
    }));
  const verified = new Set<string>();
  const completeWindows =
    windows.length > 0 &&
    windows.every((w) => Number.isFinite(w.from) && w.to >= w.from);
  let group: string | undefined,
    owner: string | undefined,
    prefix = "",
    uncertain = false;
  const route = () => {
    const line = stripVTControlCharacters(prefix);
    const stamp = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) /u.exec(line);
    const run = /^##\[group\]Run (.*)/u.exec(
      line.slice(stamp?.[0].length ?? 0),
    );
    if (run) group = commands.get(run[1]?.trim() ?? "");
    const time = Date.parse(stamp?.[1] ?? "");
    const matches = windows.filter((w) => w.from <= time && time <= w.to);
    const unique = matches.length === 1 ? matches[0]?.name : undefined;
    if (unique) verified.add(unique);
    else uncertain = true;
    const name =
      unique ??
      (group &&
      ((!matches.length && (!completeWindows || !stamp)) ||
        matches.some((w) => w.name === group))
        ? group
        : undefined);
    owner = name && checks.includes(name) ? name : "github-job";
    emit(owner, prefix);
    prefix = "";
  };
  return {
    write(chunk: string) {
      lineFragments(chunk, (part, newline) => {
        if (!owner) {
          const take = Math.min(512 - prefix.length, part.length);
          prefix += part.slice(0, take);
          part = part.slice(take);
          if (prefix.length === 512 || newline) route();
        }
        if (owner && (part || newline))
          emit(owner, part + (newline ? "\n" : ""));
        if (newline) owner = undefined;
      });
    },
    finish() {
      if (prefix) route();
      return (
        completeWindows &&
        !uncertain &&
        steps
          .filter(
            (s) => s.conclusion === "failure" || s.conclusion === "timed_out",
          )
          .every((s) => verified.has(s.name))
      );
    },
  };
}
