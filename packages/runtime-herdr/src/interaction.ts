/** Visible Codex approval UI only. History, prose mentions and partial menus are unknown. */
export function confirmationVisible(screen: string): boolean {
  if (screen.length > 65536) return false;
  const lines = screen
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal ANSI styling before matching fixed UI markers.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim());
  const title = lines.lastIndexOf(
    "Would you like to run the following command?",
  );
  if (title < 0) return false;
  const menu = lines.slice(title + 1);
  return (
    menu.some((line) => /^(?:[›❯>]\s*)?1\. Yes, proceed \(y\)$/u.test(line)) &&
    menu.some((line) =>
      /^(?:[›❯>]\s*)?[23]\. No, and tell Codex what to do differently \(esc\)$/u.test(
        line,
      ),
    ) &&
    /^Press enter to confirm or esc to cancel\.?$/iu.test(
      menu.filter(Boolean).at(-1) ?? "",
    )
  );
}
