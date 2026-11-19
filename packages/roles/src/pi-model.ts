/** The model/CLI contract of Pi 1.4.0. Other harnesses keep their own vocabularies. */
export const piThinkingLevels: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function piInlineArgsConflict(args: readonly string[]) {
  // Reject reserved tokens anywhere rather than guessing which option consumed
  // the previous token. Native profiles keep their original passthrough.
  return args.some((arg) =>
    /^--(?:model|models|provider|thinking|api-key)(?:=|$)/u.test(arg),
  );
}

export function piThinkingConfig(
  declared?: readonly string[],
  selected?: string,
) {
  const levels = declared ?? (selected ? [selected] : undefined);
  if (!levels) return {};
  // Pi clamps a boolean-only model to off/high. Null disables an unsupported
  // level; extended levels require an explicit wire mapping even when identical.
  const thinkingLevelMap: Record<string, string | null> = {};
  for (const level of piThinkingLevels) {
    if (level === "off" && levels.includes("none"))
      thinkingLevelMap.off = "none";
    else if (!levels.includes(level)) thinkingLevelMap[level] = null;
    else if (level === "xhigh" || level === "max")
      thinkingLevelMap[level] = level;
  }
  return {
    reasoning: levels.some((level) => level !== "off" && level !== "none"),
    thinkingLevelMap,
  };
}
