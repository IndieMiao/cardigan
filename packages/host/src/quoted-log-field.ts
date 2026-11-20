/** Bounded lexical state, independent of both terminal rendering and retained
 * body pages. Values are never stored here. Return the first unsafe offset. */
export class QuotedLogField {
  private quote = "";
  private escaped = false;
  private word = "";
  private identifier = false;
  private uppercase = false;
  private inWord = false;
  private quotedName = false;
  private awaitingValue = false;

  get active() {
    return !!this.quote || this.awaitingValue;
  }
  scan(text: string): number {
    let keep = this.quote ? 0 : text.length;
    const tokens = /\w+|\s+|['":=]|[^\w\s'":=]+/guy;
    for (let i = 0; i < text.length; ) {
      if (this.quote) {
        const end = text.indexOf(this.quote, i);
        const stop = end < 0 ? text.length : end;
        let j = stop;
        while (j > i && text[j - 1] === "\\") j--;
        this.escaped = (stop - j + Number(j === i && this.escaped)) % 2 === 1;
        if (end < 0) break;
        if (!this.escaped) this.quote = "";
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
      if (this.awaitingValue) {
        keep = Math.min(keep, start);
        this.awaitingValue = false;
        if (token === "'" || token === '"') {
          this.quote = token;
          continue;
        }
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
      this.awaitingValue =
        this.identifier &&
        !!this.word &&
        (token === "=" ||
          (token === ":" &&
            ((this.uppercase && (this.word.length >= 2 || this.quotedName)) ||
              /^(?:password|secret|token|key|api_?key)$/iu.test(this.word))));
      this.word = "";
    }
    return keep;
  }
  endLine() {
    this.word = "";
    this.inWord = this.escaped = false;
    // Whitespace after a separator may include newlines. Only the first actual
    // value byte consumes awaitingValue; only an unescaped delimiter ends quote.
  }
}
