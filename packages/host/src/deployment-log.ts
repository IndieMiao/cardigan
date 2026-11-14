/**
 * Build output is untrusted, even when it comes from the approved main tree.
 * Only diagnostic codes and exit status cross into events/Agent diagnostics;
 * no free text, paths, environment values or raw stdout/stderr are retained.
 */
export class DeploymentBuildLog {
  private pending = "";
  private readonly lines: string[] = [];
  append(chunk: string) {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/u);
    this.pending = (lines.pop() ?? "").slice(-8192);
    for (const line of lines) {
      for (const match of line.matchAll(/\berror (TS[0-9]{4,5}):/gu)) {
        this.lines.push(`TypeScript ${match[1]}`);
        if (this.lines.length > 20) this.lines.shift();
      }
    }
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
  constructor(private readonly ports: readonly number[]) {}

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
          const urls = [new URL(ready.url), new URL(ready.web_url)];
          found ||=
            ready.ready === true &&
            ready.deployment_fence === 1 &&
            urls.every(
              (url, i) =>
                ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
                Number(url.port) === this.ports[i],
            );
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
