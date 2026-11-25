/** C-650: well-known start failures, mapped to fixed human-readable labels. */
const FAILURE_CAUSES: readonly (readonly [RegExp, string])[] = [
  [
    /\bdatabase (?:table )?is locked\b|\bSQLITE_(?:BUSY|LOCKED)\b/u,
    "数据库被锁",
  ],
  [/\bdatabase or disk is full\b|\bSQLITE_FULL\b|\bENOSPC\b/u, "磁盘已满"],
  [/\bEADDRINUSE\b/u, "端口被占用"],
];

/**
 * Build output is untrusted, even when it comes from the approved main tree.
 * Only diagnostic codes and exit status cross into events/Agent diagnostics;
 * no free text, paths, environment values or raw stdout/stderr are retained.
 */
export class DeploymentBuildLog {
  private pending = "";
  private readonly lines: string[] = [];
  private readonly found: string[] = [];
  append(chunk: string) {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/u);
    this.pending = (lines.pop() ?? "").slice(-8192);
    for (const line of lines) {
      for (const match of line.matchAll(/\berror (TS[0-9]{4,5}):/gu)) {
        this.lines.push(`TypeScript ${match[1]}`);
        if (this.lines.length > 20) this.lines.shift();
      }
      // C-650: fixed labels only; the matched text itself never leaves.
      for (const [pattern, label] of FAILURE_CAUSES)
        if (pattern.test(line) && !this.found.includes(label)) {
          this.found.push(label);
          this.lines.push(`原因：${label}`);
          if (this.lines.length > 20) this.lines.shift();
        }
    }
  }
  /** C-650: recognised causes seen so far, in order; fixed labels only. */
  causes(): readonly string[] {
    return this.found;
  }
  finish(
    stage: "install" | "build" | "start" | "ready",
    code: number | null | "not_exited" | "spawn_failed",
  ): string {
    this.append("\n");
    const outcome =
      typeof code === "string" ? code : `exit ${code ?? "unknown"}`;
    return [...this.lines, `${stage}: ${outcome}`].join("\n");
  }
}

/** Bound partial lines, not entire chunks: a burst must not discard a ready line. */
export class DeploymentServerReady {
  private pending = "";
  private oversized = false;
  constructor(
    private readonly ports: readonly number[],
    private readonly role?: "web" | "background",
  ) {}

  append(data: Buffer): boolean {
    const text = data.toString("utf8");
    let found = false;
    for (let offset = 0; offset < text.length; ) {
      const end = text.indexOf("\n", offset);
      const part = text.slice(offset, end < 0 ? undefined : end);
      if (!this.oversized) {
        if (this.pending.length + part.length > 65536) {
          this.pending = "";
          this.oversized = true;
        } else this.pending += part;
      }
      if (end < 0) break;
      if (!this.oversized) {
        try {
          const ready = JSON.parse(this.pending);
          if (this.role === "background") {
            found ||=
              ready.ready === true &&
              ready.deployment_fence === 2 &&
              ready.role === "background";
          } else {
            const urls = [new URL(ready.url), new URL(ready.web_url)];
            found ||=
              ready.ready === true &&
              ready.deployment_fence === (this.role ? 2 : 1) &&
              (!this.role || ready.role === this.role) &&
              urls.every(
                (url, i) =>
                  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
                  Number(url.port) === this.ports[i],
              );
          }
        } catch {
          /* Raw server output never enters diagnostics. */
        }
      }
      this.pending = "";
      this.oversized = false;
      offset = end + 1;
    }
    return found;
  }
}
