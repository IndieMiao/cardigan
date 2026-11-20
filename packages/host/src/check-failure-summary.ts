/** Bounded projections from complete lines. Never retain raw output as a finding. */
const MAX_LINE = 16_384;
const MAX_NAMES = 5;
class Sample {
  readonly values: string[] = [];
  overflow = false;
  add(value: string) {
    if (this.values.includes(value)) return;
    if (this.values.length < MAX_NAMES) this.values.push(value);
    else this.overflow = true;
  }
}
export class CheckFailureSummary {
  private readonly detailed = new Sample();
  private readonly reported = new Sample();
  private readonly files = new Sample();
  private error?: string;
  private readonly annotations = new Sample();
  private fileStats?: string;
  private testStats?: string;
  private failedCount = 0;
  private lintFile = "";
  constructor(private readonly redact: (line: string) => string) {}
  inspect(safe: string, oversized = false) {
    const line = safe
      .trim()
      .replace(/^##\[group\]\s*/u, "")
      .replace(/^(?:packages|apps)\/\S+ (?:test|lint|build)(?:\$|:)\s*/u, "");
    if (oversized || safe.length > MAX_LINE) {
      // A clipped value may lack its redaction boundary. Publish only a fixed type.
      const type =
        /^(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|Error)\b/u.exec(
          line,
        )?.[1];
      if (type) this.error ??= type;
      return;
    }
    const compact = (s: string) => this.redact(s).slice(0, 480).trimEnd();
    if (/^Test Files\s+\d/u.test(line)) this.fileStats = compact(line);
    else if (/^Tests\s+\d/u.test(line)) {
      this.testStats = compact(line);
      const total =
        /^Tests\s+(\d+) failed(?:\s*\|\s*\d+ (?:passed|skipped|todo|pending))*\s*(?:\(\d+\))?$/u.exec(
          line,
        );
      this.failedCount =
        total && Number.isSafeInteger(Number(total[1])) ? Number(total[1]) : 0;
    } else if (/^##\[error\]/u.test(line)) this.annotations.add(compact(line));
    else if (/^FAIL\s+/u.test(line)) {
      (line.includes(" > ") ? this.detailed : this.files).add(compact(line));
    } else if (/^[❯✗]\s+\S+\.(?:[cm]?[jt]sx?)\s+\(.*failed/u.test(line)) {
      this.files.add(compact(line));
    } else if (
      /^[×✘✗✖]\s/u.test(line) ||
      /^\d+\)\s+.*(?:›|\.spec\.)/u.test(line)
    ) {
      this.reported.add(compact(line.replace(/\s+[\d.]+\s*ms$/u, "")));
    } else if (
      /^(?:[\w.]*Error\b|→\s+(?:expected|Test timed out)|Expected\s*:)|\berror TS\d+:/u.test(
        line,
      ) ||
      /^\S+:\d+:\d+\s+(?:lint\/|format\b)/u.test(line)
    ) {
      this.error ??= compact(line);
    } else if (/^\d+:\d+\s+error\s/u.test(line)) {
      this.error ??= compact(`${this.lintFile} ${line}`.trim());
    } else if (/^(?:\S+\.[cm]?[jt]sx?|\[私有路径\])$/u.test(line))
      this.lintFile = compact(line);
  }
  lines(): string[] {
    const names = this.detailed.values.length ? this.detailed : this.reported;
    const extra = this.failedCount - names.values.length;
    return [
      ...this.files.values,
      ...names.values,
      ...(extra > 0
        ? [`另有 ${extra} 个失败用例`]
        : names.overflow
          ? ["另有失败用例"]
          : []),
      this.error,
      this.fileStats,
      this.testStats,
      ...this.annotations.values,
    ].filter((v): v is string => !!v);
  }
}
