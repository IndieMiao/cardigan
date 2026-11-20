/** Decode display controls before lexing assignments. Network boundaries have no
 * meaning here: keep only the control's kind, never its parameters or payload. */
export class CheckLogDisplay {
  private state:
    | "text"
    | "escape"
    | "intermediate"
    | "csi"
    | "string"
    | "stringEscape" = "text";
  private osc = false;
  private high = "";
  private opaque = false;

  clean(part: string): string {
    // A decoded JS string (including an internal scan block) may end between
    // the halves of a Unicode format character. Classify complete code points.
    if (this.high) {
      part = this.high + part;
      this.high = "";
    }
    const last = part.charCodeAt(part.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.high = part.slice(-1);
      part = part.slice(0, -1);
    }
    if (this.state === "text" && !/[\p{Cc}\p{Cf}]/u.test(part)) return part;
    let visible = "";
    for (const c of part) {
      if (this.state === "string" || this.state === "stringEscape") {
        if (
          c === "\x18" ||
          c === "\x1a" ||
          c === "\x9c" ||
          (this.osc && c === "\x07") ||
          (this.state === "stringEscape" && c === "\\")
        )
          this.state = "text";
        else this.state = c === "\x1b" ? "stringEscape" : "string";
        continue;
      }
      if (c === "\x1b") {
        this.state = "escape";
        continue;
      }
      if (c === "\x9b" || (this.state === "escape" && c === "[")) {
        this.state = "csi";
        continue;
      }
      if (
        ["\x90", "\x98", "\x9d", "\x9e", "\x9f"].includes(c) ||
        (this.state === "escape" && "PX]^_".includes(c))
      ) {
        this.opaque = true;
        this.osc = c === "\x9d" || c === "]";
        this.state = "string";
        continue;
      }
      if (this.state !== "text") {
        if (this.state === "escape" && c >= " " && c <= "/")
          this.state = "intermediate";
        else if (
          (c >= (this.state === "csi" ? "@" : "0") && c <= "~") ||
          c === "\x18" ||
          c === "\x1a"
        )
          this.state = "text";
        continue;
      }
      if (c === "\t" || c === "\r" || !/[\p{Cc}\p{Cf}]/u.test(c)) visible += c;
    }
    return visible;
  }
  endLine() {
    // A physical line resynchronizes a malformed CSI/ESC; string payloads are
    // not printable until their terminator. Neither event closes a quoted value.
    const incomplete = this.opaque || this.state !== "text" || !!this.high;
    this.high = "";
    if (this.state !== "string" && this.state !== "stringEscape")
      this.state = "text";
    else this.state = "string";
    this.opaque = this.state === "string";
    return incomplete;
  }
}
