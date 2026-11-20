/** Bounded projections from complete lines. Never retain raw output as a finding. */
const MAX_LINE = 16_384;
const MAX_NAMES = 5;
class Sample {
  readonly values: string[] = [];
  count = 0;
  add(value: string) {
    if (this.values.includes(value)) return;
    this.count++;
    if (this.values.length < MAX_NAMES) this.values.push(value);
  }
}
export class CheckFailureSummary {
  private pending = "";
  private oversized = false;
  private privateKey = false;
  private readonly detailed = new Sample();
  private readonly reported = new Sample();
  private readonly files = new Sample();
  private error?: string;
  private readonly annotations = new Sample();
  private fileStats?: string;
  private testStats?: string;
  private failedCount = 0;
  private lintFile = "";
  constructor(
    private readonly normalize: (line: string) => string,
    private readonly redact: (line: string) => string,
  ) {}

  append(chunk: string) {
    for (let start = 0; start < chunk.length; ) {
      const newline = chunk.indexOf("\n", start);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.oversized && this.pending.length + end - start <= MAX_LINE)
        this.pending += chunk.slice(start, end);
      else this.oversized = true;
      if (newline === -1) break;
      this.flush();
      start = newline + 1;
    }
  }
  private flush() {
    if (!this.oversized && this.pending) this.inspect(this.pending);
    this.pending = "";
    this.oversized = false;
  }
  private inspect(raw: string) {
    // PEM bodies can span callbacks and even contain diagnostic-looking lines.
    const normalized = this.normalize(raw);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(normalized))
      this.privateKey = true;
    if (this.privateKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/u.test(normalized))
        this.privateKey = false;
      return;
    }
    const line = normalized
      .trim()
      .replace(/^##\[group\]\s*/u, "")
      .replace(/^(?:packages|apps)\/\S+ (?:test|lint|build)(?:\$|:)\s*/u, "");
    const compact = (s: string) => this.redact(s).slice(0, 480).trimEnd();
    if (/^Test Files\s+\d/u.test(line)) this.fileStats = compact(line);
    else if (/^Tests\s+\d/u.test(line)) {
      this.testStats = compact(line);
      this.failedCount = Number(/\b(\d+) failed\b/u.exec(line)?.[1] ?? 0);
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
    this.flush();
    const names = this.detailed.count ? this.detailed : this.reported;
    const extra = Math.max(this.failedCount, names.count) - names.values.length;
    return [
      ...(!this.detailed.count
        ? this.files.values.slice(0, names.count ? 1 : MAX_NAMES)
        : []),
      ...names.values,
      ...(extra > 0 ? [`另有 ${extra} 个失败用例`] : []),
      this.error,
      this.fileStats,
      this.testStats,
      ...this.annotations.values,
    ].filter((v): v is string => !!v);
  }
}
