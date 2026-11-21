import { createHash } from "node:crypto";

/** Screen and argv are untrusted and may contain secrets. Only a digest and a
 * fixed command vocabulary can leave the adapter (and neither PID nor digest is logged). */
export function terminalSnapshot(
  screen: string,
  fg?: { pid?: number; name?: string; argv?: string[] } | null,
) {
  if (Buffer.byteLength(screen) > 64 * 1024) throw new Error();
  const output = screen
    .split("\n")
    .map((s) => s.trimEnd())
    .filter(
      (s) =>
        s.trim() &&
        !/esc to (?:interrupt|cancel)|ctrl\+c to interrupt|^[\s✳✶✻✽✢·*]+[^\n]*…\s*(?:\(|$)/iu.test(
          s,
        ),
    );
  const name = fg?.name?.split("/").at(-1);
  const command =
    name &&
    ["node", "python", "python3", "vite", "npm", "pnpm", "bash", "sh"].includes(
      name,
    )
      ? name
      : undefined;
  return {
    digest: createHash("sha256").update(output.join("\n")).digest("hex"),
    ...(command && fg?.pid && fg.pid > 0
      ? { foreground: { key: `${fg.pid}:${command}`, command } }
      : {}),
  };
}
