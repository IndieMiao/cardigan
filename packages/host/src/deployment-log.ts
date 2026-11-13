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
  finish(stage: "install" | "build", code: number | null): string {
    this.append("\n");
    return [...this.lines, `${stage}: exit ${code ?? "unknown"}`].join("\n");
  }
}
