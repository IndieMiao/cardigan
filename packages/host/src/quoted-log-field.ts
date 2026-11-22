/** Bounded lexical state, independent of both terminal rendering and retained
 * body pages. Values are never stored here. Return the first unsafe offset. */
export class QuotedLogField {
  private state: "field" | "awaiting" | "bare" | "'" | '"' = "field";
  private escaped = false;
  private word = "";
  private identifier = false;
  private uppercase = false;
  private inWord = false;
  private quotedName = false;

  get active() {
    return this.state !== "field";
  }
  scan(text: string): number {
    let keep =
      this.state === "field" || this.state === "awaiting" ? text.length : 0;
    // A bare atom owns its punctuation (including =, :, quotes and URL path
    // characters). Whitespace or a structural separator may start another field;
    // a block boundary never does. BoundedOutput still masks the rest of the line.
    const bareBoundary = /[\s,;&|()[\]{}]/gu;
    const tokens = /\w+|\s+|['":=]|[^\w\s'":=]+/guy;
    for (let i = 0; i < text.length; ) {
      if (this.state === "bare") {
        bareBoundary.lastIndex = i;
        if (!bareBoundary.test(text)) break;
        i = bareBoundary.lastIndex;
        this.state = "field";
        continue;
      }
      if (this.state === "'" || this.state === '"') {
        const end = text.indexOf(this.state, i);
        const stop = end < 0 ? text.length : end;
        let j = stop;
        while (j > i && text[j - 1] === "\\") j--;
        this.escaped = (stop - j + Number(j === i && this.escaped)) % 2 === 1;
        if (end < 0) break;
        if (!this.escaped) this.state = "field";
        this.escaped = false;
        i = end + 1;
        continue;
      }
      // The alternatives are disjoint and cover every character.
      tokens.lastIndex = i;
      const token = tokens.exec(text)?.[0];
      if (!token) throw new Error("Invalid log scanner state");
      const start = i;
      i = tokens.lastIndex;
      if (/^\s/u.test(token)) {
        this.inWord = false;
        continue;
      }
      if (this.state === "awaiting") {
        keep = Math.min(keep, start);
        if (token === "'" || token === '"') this.state = token;
        else {
          this.state = "bare";
          i = start;
        }
        continue;
      }
      if (/^\w/u.test(token)) {
        this.quotedName = false;
        if (!this.inWord) this.identifier = /^[a-z_]/iu.test(token);
        this.uppercase =
          (!this.inWord || this.uppercase) && /^[A-Z0-9_]+$/u.test(token);
        this.word = ((this.inWord ? this.word : "") + token.slice(-16)).slice(
          -16,
        );
        this.inWord = true;
        continue;
      }
      this.inWord = false;
      if (token === '"' || token === "'") {
        this.quotedName = !!this.word;
        continue;
      }
      if (
        this.identifier &&
        this.word &&
        (token === "=" ||
          (token === ":" &&
            ((this.uppercase && (this.word.length >= 2 || this.quotedName)) ||
              /^(?:password|secret|token|key|api_?key)$/iu.test(this.word))))
      )
        this.state = "awaiting";
      this.word = "";
    }
    return keep;
  }
  endLine() {
    this.word = "";
    this.inWord = this.escaped = false;
    // Only an empty RHS or an open quote can continue to the next line.
    if (this.state === "bare") this.state = "field";
  }
}
