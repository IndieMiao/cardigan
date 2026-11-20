/** Lex only the assignment boundary; never retain the value. A GitHub job is one
 * stream even when consecutive lines are attributed to different steps. */
export class QuotedLogField {
  private quote = "";
  private escaped = false;
  private word = "";
  private uppercase = false;
  private inWord = false;
  private afterSeparator = false;
  private uncertain = false;

  get open() {
    return !!this.quote || this.uncertain;
  }
  // We cannot normalize a terminal escape sequence split across discarded
  // pieces of an oversized line. Do not guess its effect on delimiters.
  obscure() {
    this.uncertain = true;
  }
  scan(text: string) {
    if (this.uncertain) return;
    const tokens = /\w+|[ \t]+|['":=]|[^\w \t'":=]+/guy;
    for (let i = 0; i < text.length; ) {
      if (this.quote) {
        const end = text.indexOf(this.quote, i);
        const stop = end < 0 ? text.length : end;
        let j = stop;
        while (j > i && text[j - 1] === "\\") j--;
        this.escaped = (stop - j + Number(j === i && this.escaped)) % 2 === 1;
        if (end < 0) return;
        if (!this.escaped) this.quote = "";
        this.escaped = false;
        i = end + 1;
        continue;
      }
      tokens.lastIndex = i;
      const token = tokens.exec(text)?.[0];
      if (!token) {
        this.obscure();
        return;
      }
      i = tokens.lastIndex;
      if (/^\w/u.test(token)) {
        this.uppercase =
          (!this.inWord || this.uppercase) && /^[A-Z0-9_]+$/u.test(token);
        // Only a fixed suffix is needed to recognize field names; a hyphen separates words (e.g. api-key).
        this.word = ((this.inWord ? this.word : "") + token.slice(-16)).slice(
          -16,
        );
        this.inWord = true;
        this.afterSeparator = false;
        continue;
      }
      this.inWord = false;
      if (token[0] === " " || token[0] === "\t") continue;
      if (token === '"' || token === "'") {
        if (this.afterSeparator) {
          this.quote = token;
          this.afterSeparator = false;
        }
        // Also allow the closing quote of a quoted field name.
        continue;
      }
      this.afterSeparator =
        !!this.word &&
        (token === "=" ||
          (token === ":" &&
            (this.uppercase ||
              /^(?:password|secret|token|key|api_?key)$/iu.test(this.word))));
      this.word = "";
    }
  }
  endLine() {
    this.word = "";
    this.inWord = this.afterSeparator = this.escaped = false;
  }
}
