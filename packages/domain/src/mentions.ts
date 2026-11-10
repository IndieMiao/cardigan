import { type Employee, employeeNameKey } from "./employee.js";

/** Server-side parsing shared by human and Agent comments (including old UIs). */
export function commentMentions(
  body: string,
  explicit: readonly string[],
  employees: readonly Employee[],
  roles: readonly string[],
): readonly string[] {
  const active = employees.filter((employee) => employee.status === "active");
  // Longest name wins: @Mary Jane must not also mention @Mary.
  const names = active
    .map((employee) => ({
      key: employeeNameKey(employee.name),
      name: employee.name,
    }))
    .sort((a, b) => b.key.length - a.key.length);
  const source = body.replace(/\u3000/gu, " ").toLowerCase();
  const found: string[] = [];
  const partials = new Set<string>();
  const word = /[\p{L}\p{N}\p{M}_-]/u;
  for (let index = 0; index < source.length; index++) {
    if (
      source[index] !== "@" ||
      (index > 0 &&
        /[\p{L}\p{N}\p{M}_@]$/u.test(
          source.slice(Math.max(0, index - 2), index),
        ))
    )
      continue;
    const rest = source.slice(index + 1).trimStart();
    // Explicit targets take precedence over employee names and role names.
    const target = /^[aw]-\d+(?![\p{L}\p{N}\p{M}_-])/u.exec(rest)?.[0];
    if (target !== undefined) {
      found.push(`@${target.toUpperCase()}`);
      index += source.slice(index + 1).length - rest.length + target.length;
      continue;
    }
    const name = names.find(
      ({ key }) =>
        rest.startsWith(key) &&
        !word.test(Array.from(rest.slice(key.length))[0] ?? ""),
    );
    if (name === undefined) {
      const token = /^[a-z0-9][a-z0-9._-]*/u.exec(rest)?.[0];
      if (token !== undefined && roles.includes(token)) found.push(`@${token}`);
      continue;
    }
    found.push(`@${name.name}`);
    // Older clients only send the first ASCII token of a spaced employee name.
    const partial = /^[a-z0-9][a-z0-9_-]*/u.exec(rest)?.[0];
    if (partial !== undefined && partial !== name.key) partials.add(partial);
    index += source.slice(index + 1).length - rest.length + name.key.length;
  }
  const known = (mention: string): boolean => {
    const value = mention.replace(/^@/u, "");
    if (/^[AW]-\d+$/u.test(value)) return true;
    const key = employeeNameKey(value);
    if (
      partials.has(key) &&
      !found.some((name) => employeeNameKey(name.slice(1)) === key)
    )
      return false;
    if (names.some((name) => name.key === key)) return true;
    return roles.includes(value);
  };
  // Explicit IDs/roles keep their original spelling and representation. Unknown
  // names are ordinary text, never an invented role sent to PM Ops.
  const result = new Map<string, string>();
  for (const mention of [...explicit.filter(known), ...found]) {
    const value = mention.replace(/^@/u, "");
    const key = names.some((name) => name.key === employeeNameKey(value))
      ? employeeNameKey(value)
      : value;
    if (!result.has(key)) result.set(key, mention);
  }
  return [...result.values()];
}
