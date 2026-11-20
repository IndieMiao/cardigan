import { CheckFailureSummary } from "./check-failure-summary.js";
import { CheckLogDisplay } from "./check-log-display.js";
import { lineFragments } from "./check-log-lines.js";
import { TRUNCATED_OUTPUT } from "./merge-check-timeout.js";
import { QuotedLogField } from "./quoted-log-field.js";

const MAX_BODY_LINE = 128 * 1024;
const BLOCK = 8192;
export function outputScanState() {
  return {
    pem: false,
    field: new QuotedLogField(),
    display: new CheckLogDisplay(),
  };
}
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
  private block = "";
  private firstBlock = true;
  private masked = false;
  private keyLine = false;
  private keyCarry = "";
  private lastHighSurrogate = false;
  incomplete = false;
  constructor(
    private readonly limit: number,
    private readonly stripPrefix: (s: string) => string,
    private readonly redact: (s: string) => string,
    summaryRedact: (s: string) => string,
    private readonly stream = outputScanState(),
  ) {
    this.failure = new CheckFailureSummary(summaryRedact);
  }
  // Scan *all* visible text in fixed blocks, retaining only a bounded prefix.
  // A long line and a short line go through exactly the same redaction path.
  private scan(last: boolean) {
    const s = this.firstBlock ? this.stripPrefix(this.block) : this.block;
    this.block = "";
    const { field } = this.stream;
    const keep =
      this.firstBlock && last && !field.active && !/[:=]/u.test(s)
        ? s.length
        : field.scan(s);
    if (!this.masked)
      this.pending += s.slice(
        0,
        Math.min(keep, MAX_BODY_LINE - this.pending.length),
      );
    this.masked ||= keep < s.length;
    this.keyLine ||= this.stream.pem;
    const joined = this.keyCarry + s;
    if (joined.includes("-----")) {
      for (const match of joined.matchAll(
        /-----(BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----/gu,
      )) {
        if (match.index + match[0].length <= this.keyCarry.length) continue;
        this.stream.pem = match[1] === "BEGIN";
        this.keyLine ||= this.stream.pem;
      }
    }
    this.keyCarry = last ? "" : joined.slice(-96);
    this.firstBlock = false;
  }
  append(text: string) {
    lineFragments(text, (part, newline) => {
      if (part.length) {
        this.bytes += Buffer.byteLength(part);
        // A JS producer can split a decoded surrogate pair between callbacks.
        const first = part.charCodeAt(0),
          last = part.charCodeAt(part.length - 1);
        if (this.lastHighSurrogate && first >= 0xdc00 && first <= 0xdfff)
          this.bytes -= 2;
        this.lastHighSurrogate = last >= 0xd800 && last <= 0xdbff;
      }
      for (let i = 0; i < part.length; i += BLOCK) {
        this.block += this.stream.display.clean(part.slice(i, i + BLOCK));
        if (this.block.length >= BLOCK) {
          const rest = this.block.slice(BLOCK);
          this.block = this.block.slice(0, BLOCK);
          this.scan(false);
          this.block = rest;
        }
      }
      if (newline) this.flush(true);
    });
  }
  private flush(newline: boolean) {
    this.scan(true);
    this.stream.field.endLine();
    const opaqueDisplay = this.stream.display.endLine();
    const oversized = this.bytes > MAX_BODY_LINE;
    const prefix = this.keyLine ? "" : this.pending;
    const safe = oversized
      ? `[REDACTED] ${TRUNCATED_OUTPUT}`
      : this.redact(prefix + (this.masked || this.keyLine ? "[REDACTED]" : ""));
    if (!this.keyLine)
      this.failure.inspect(
        oversized ? prefix : safe,
        oversized || this.bytes > 16384,
      );
    this.incomplete ||=
      opaqueDisplay ||
      oversized ||
      this.masked ||
      this.keyLine ||
      safe !== prefix;
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
    this.firstBlock = true;
    this.masked = this.keyLine = this.lastHighSurrogate = false;
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
