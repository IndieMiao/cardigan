import { join } from "node:path";
import {
  type ActivityMetadata,
  type ContextReadInput,
  type ContextReading,
  json,
  measured,
  object,
  parseActivityMetadata,
  records,
} from "./context.js";
export async function readPiContext(
  input: ContextReadInput,
): Promise<ContextReading> {
  const usage = (await input.caches(join(input.root, "pi", "context-usage")))
    .filter((v) => v.agent === "pi")
    // Select the latest sample before checking its measurements. Unknown
    // samples must suppress older valid sessions, including timestamp ties.
    .sort(
      (a, b) =>
        Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
        Number(measured(a)) - Number(measured(b)),
    )[0];
  return { usage, activity: await readPiActivity(input) };
}
async function readPiActivity({
  root,
  files,
  readParts,
  onReadFailure,
}: ContextReadInput): Promise<ActivityMetadata | undefined> {
  // Select by creation filename, never by a late write's mtime or cache-provided path.
  let failed = false;
  const fail = () => {
    failed = true;
    onReadFailure?.();
  };
  const path = (await files(join(root, "pi", "sessions"), ".jsonl", 0, fail))
    .sort()
    .at(-1);
  if (!path || failed) return;
  try {
    const parts = await readParts(path);
    if (!parts) {
      fail();
      return;
    }
    const meta = parts.head
      .split("\n")
      .map(json)
      .find((v) => v?.type === "session");
    let last: ActivityMetadata | undefined;
    for (const event of records(parts.tail, parts.tailStart)) {
      if (event?.type !== "message") continue;
      const message = object(event.message);
      if (!["assistant", "user", "toolResult"].includes(String(message?.role)))
        continue;
      const sample = parseActivityMetadata({
        session_id: meta?.id,
        cwd: meta?.cwd,
        updated_at: event.timestamp,
        ...(message?.stopReason === "error" ? { error: "unclassified" } : {}),
      });
      if (
        !sample ||
        (last && Date.parse(sample.updated_at) < Date.parse(last.updated_at))
      )
        return;
      last = sample;
    }
    return last;
  } catch {
    fail();
    return;
  }
}
