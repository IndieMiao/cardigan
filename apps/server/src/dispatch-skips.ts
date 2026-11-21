import type { AssignmentId, ProjectId } from "@cardigan/domain";

/** One line per source and changing reason, not per poll. Bound memory for retired notifications. */
export class DispatchSkips {
  private readonly seen = new Map<string, string>();
  constructor(
    private readonly now: () => string,
    private readonly log: (line: string) => void = console.info,
  ) {}
  record(
    project: ProjectId,
    assignment: AssignmentId | undefined,
    source: string,
    since: string,
    reason: string,
  ): undefined {
    const key = `${project}/${assignment ?? "-"}/${source}`;
    if (this.seen.get(key) === reason) return;
    if (this.seen.size >= 8192) {
      const oldest = this.seen.keys().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    this.seen.set(key, reason);
    this.log(
      `dispatch_skipped project=${project} assignment=${assignment ?? "-"} source=${source} reason=${reason} age_ms=${Math.max(0, Date.parse(this.now()) - Date.parse(since))}`,
    );
  }
}
