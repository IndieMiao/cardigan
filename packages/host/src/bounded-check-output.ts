import { CheckFailureSummary } from "./check-failure-summary.js";
import { lineFragments } from "./check-log-lines.js";
import { TRUNCATED_OUTPUT } from "./merge-check-timeout.js";

const MAX_BODY_LINE = 128 * 1024;
interface Page {
  text: string;
  weight: number;
}
/** Redact complete lines *before* retaining head/tail. A dropped middle cannot
 * hide the start of an assignment, authentication header or multiline key. */
export class BoundedOutput {
  readonly failure: CheckFailureSummary;
  private head = "";
  private headWeight = 0;
  private tail: Page[] = [];
  private tailWeight = 0;
  private page: Page = { text: "", weight: 0 };
  private pastHead = false;
  private totalWeight = 0;
  private pending = "";
  private bytes = 0;
  private oversized = false;
  private keyCarry = "";
  private keyLine = false;
  incomplete = false;
  constructor(
    private readonly limit: number,
    private readonly normalize: (s: string) => string,
    private readonly redact: (s: string) => string,
    summaryRedact: (s: string) => string,
    private readonly key = { open: false },
  ) {
    this.failure = new CheckFailureSummary(summaryRedact);
  }
  private scanKey(s: string) {
    for (const m of s.matchAll(
      /-----(BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----/gu,
    )) {
      this.keyLine ||= this.key.open || m[1] === "BEGIN";
      this.key.open = m[1] === "BEGIN";
    }
  }
  append(text: string) {
    lineFragments(text, (part, newline) => {
      this.bytes += Buffer.byteLength(part);
      // A small overlap catches delimiters split across callbacks even after
      // the line exceeds the retained prefix.
      if (part.includes("-") || this.keyCarry) {
        const scan = this.keyCarry + this.normalize(part);
        this.scanKey(scan);
        this.keyCarry = scan.slice(-96);
      }
      if (this.pending.length + part.length > MAX_BODY_LINE)
        this.oversized = true;
      this.pending += part.slice(0, MAX_BODY_LINE - this.pending.length);
      if (newline) this.flush(true);
    });
  }
  private flush(newline: boolean) {
    const normalized = this.normalize(this.pending);
    // Strip controls on the reassembled line too: an ANSI escape can itself
    // be split across two callbacks. Do not replay an incomplete prefix.
    if (!this.oversized && normalized.includes("-----"))
      this.scanKey(normalized);
    const hidden = this.keyLine || this.key.open;
    const safe = hidden
      ? "[REDACTED]"
      : this.oversized
        ? `[REDACTED] ${TRUNCATED_OUTPUT}`
        : this.redact(normalized);
    if (!hidden)
      this.failure.inspect(
        this.oversized ? normalized : safe,
        this.oversized || normalized.length > 16384,
      );
    this.incomplete ||= this.oversized || hidden || safe !== normalized;
    const text = safe + (newline ? "\n" : "");
    const weight = Math.max(
      this.bytes + Number(newline),
      Buffer.byteLength(text),
    );
    if (this.page.weight + weight > 8192) this.finishPage();
    this.page.text += text;
    this.page.weight += weight;
    this.pending = this.keyCarry = "";
    this.bytes = 0;
    this.oversized = false;
    this.keyLine = false;
  }
  private finishPage() {
    if (!this.page.weight) return;
    const page = this.page;
    this.page = { text: "", weight: 0 };
    this.totalWeight += page.weight;
    const half = (this.limit - 64) / 2;
    if (!this.pastHead && this.headWeight + page.weight <= half) {
      this.head += page.text;
      this.headWeight += page.weight;
      return;
    }
    this.pastHead = true;
    this.tail.push(page);
    this.tailWeight += page.weight;
    if (this.totalWeight > this.limit) {
      while (this.tailWeight > half) {
        const first = this.tail.shift();
        if (!first) break;
        this.tailWeight -= first.weight;
      }
    }
  }
  seal() {
    if (this.bytes) this.flush(false);
    this.finishPage();
  }
  text() {
    return (
      this.head +
      (this.totalWeight > this.limit ? `\n${TRUNCATED_OUTPUT}\n` : "") +
      this.tail.map((p) => p.text).join("")
    );
  }
}
