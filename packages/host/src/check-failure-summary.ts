/** Bounded projections from complete lines. Never retain raw output as a finding. */
const MAX_LINE = 16_384;
const MAX_NAMES = 5;
const MAX_POINTS = 10;
const TAIL_LINES = 3;
class Sample {
  readonly values: string[] = [];
  overflow = false;
  constructor(private readonly max = MAX_NAMES) {}
  add(value: string) {
    if (this.values.includes(value)) return;
    if (this.values.length < this.max) this.values.push(value);
    else this.overflow = true;
  }
}
/** C-766: wrapper and runner noise that never locates a failure. */
const NOISE =
  /^(?:ELIFECYCLE\b|ERR_PNPM_|npm (?:ERR|error)!|##\[(?:end)?group\]|Post job cleanup|(?:Start at|Duration)\s|Exit status \d|(?:Error: )?Process completed with exit code|[-=_~*⎯─━]{3,})/u;
const HINT =
  /\b(?:[Ee]rror|ERROR|FATAL|[Ff]atal|[Pp]anic|Exception|[Ff]ailed|FAILED|[Uu]nhandled|[Tt]raceback)\b/u;
/** Repository-relative file references; absolute paths are redacted upstream. */
const PATH =
  /(?:^|[\s('"`@])(?:\.\/)?((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,5})(?=$|[\s:)'"`,(])/gu;
const SOURCE =
  /\.(?:[cm]?[jt]sx?|gd|tscn|py|go|rs|java|kt|rb|cs|vue|svelte|json|ya?ml|toml|css|html|sh)$/u;
const PACKAGE_PREFIX =
  /^(?:##\[group\]\s*)?((?:packages|apps)\/[\w.-]+) (?:test|lint|build)(?:\$|:)/u;
export class CheckFailureSummary {
  private readonly detailed = new Sample();
  private readonly reported = new Sample();
  private readonly files = new Sample();
  private error?: string;
  private readonly annotations = new Sample();
  private readonly hints = new Sample(TAIL_LINES);
  private readonly located = new Sample(MAX_POINTS);
  private tail: string[] = [];
  private fileStats?: string;
  private testStats?: string;
  private errorStats?: string;
  private locatingAnnotation = false;
  private failedCount = 0;
  private lintFile = "";
  constructor(private readonly redact: (line: string) => string) {}
  inspect(safe: string, oversized = false) {
    const pkg = PACKAGE_PREFIX.exec(safe.trim())?.[1];
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
    const locate = (text: string) => {
      for (const match of text.matchAll(PATH)) {
        const path = match[1] as string;
        if (
          path.includes("..") ||
          /^\d/u.test(path) ||
          (!path.includes("/") && !SOURCE.test(path))
        )
          continue;
        this.located.add(
          pkg && !/^(?:packages|apps)\//u.test(path) ? `${pkg}/${path}` : path,
        );
      }
    };
    if (/^Test Files\s+\d/u.test(line)) this.fileStats = compact(line);
    else if (/^Tests\s+\d/u.test(line)) {
      this.testStats = compact(line);
      const total =
        /^Tests\s+(\d+) failed(?:\s*\|\s*\d+ (?:passed|skipped|todo|pending))*\s*(?:\(\d+\))?$/u.exec(
          line,
        );
      this.failedCount =
        total && Number.isSafeInteger(Number(total[1])) ? Number(total[1]) : 0;
    } else if (/^Errors\s+\d+\s+errors?\b/u.test(line))
      this.errorStats = compact(line);
    else if (/^##\[error\]/u.test(line)) {
      // C-766: the runner's generic exit annotation does not locate a failure.
      if (!/^##\[error\]Process completed with exit code/u.test(line))
        this.locatingAnnotation = true;
      this.annotations.add(compact(line));
    } else if (/^FAIL\s+/u.test(line)) {
      locate(line.replace(/^FAIL\s+/u, "").split(" > ")[0] ?? "");
      (line.includes(" > ") ? this.detailed : this.files).add(compact(line));
    } else if (/^[❯✗]\s+\S+\.(?:[cm]?[jt]sx?)\s+\(.*failed/u.test(line)) {
      locate(line);
      this.files.add(compact(line));
    } else if (
      /^[×✘✗✖]\s/u.test(line) ||
      /^\d+\)\s+.*(?:›|\.spec\.)/u.test(line)
    ) {
      locate(line);
      this.reported.add(compact(line.replace(/\s+[\d.]+\s*ms$/u, "")));
    } else if (
      /^(?:[\w.]*Error\b|→\s+(?:expected|Test timed out)|Expected\s*:)|\berror TS\d+:/u.test(
        line,
      ) ||
      /^\S+:\d+:\d+\s+(?:lint\/|format\b)/u.test(line)
    ) {
      if (!this.error) locate(line.replace(/\(\d+,\d+\).*$/u, ""));
      this.error ??= compact(line);
    } else if (/^\d+:\d+\s+error\s/u.test(line)) {
      if (!this.error) locate(this.lintFile);
      this.error ??= compact(`${this.lintFile} ${line}`.trim());
    } else if (/^(?:\S+\.[cm]?[jt]sx?|\[私有路径\])$/u.test(line))
      this.lintFile = compact(line);
    else if (/^❯\s+\S+:\d+:\d+/u.test(line)) locate(line.slice(1));
    else if (line && !NOISE.test(line)) {
      // C-766: unrecognized formats keep bounded, redacted evidence instead
      // of degrading to pass counts only.
      if (HINT.test(line)) this.hints.add(compact(line));
      this.tail = [...this.tail, compact(line)].slice(-TAIL_LINES);
    }
  }
  /** C-766: repository-relative files named by recognized failure lines. */
  points(): string[] {
    return [...this.located.values];
  }
  lines(): string[] {
    const names = this.detailed.values.length ? this.detailed : this.reported;
    const extra = this.failedCount - names.values.length;
    const located =
      this.files.values.length ||
      names.values.length ||
      this.error ||
      this.locatingAnnotation;
    const fallback = located
      ? []
      : [...new Set([...this.hints.values, ...this.tail])].slice(0, 5);
    return [
      ...this.files.values,
      ...names.values,
      ...(extra > 0
        ? [`另有 ${extra} 个失败用例`]
        : names.overflow
          ? ["另有失败用例"]
          : []),
      this.error,
      ...(fallback.length ? ["未识别到失败用例，相关输出：", ...fallback] : []),
      this.fileStats,
      this.testStats,
      this.errorStats,
      ...this.annotations.values,
    ].filter((v): v is string => !!v);
  }
}
