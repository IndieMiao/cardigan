/** Deliver fragments without buffering arbitrary network lines. The receiver owns any carry. */
export function lineFragments(
  chunk: string,
  consume: (part: string, newline: boolean) => void,
) {
  for (let at = 0; at < chunk.length; ) {
    const end = chunk.indexOf("\n", at);
    consume(chunk.slice(at, end < 0 ? chunk.length : end), end >= 0);
    if (end < 0) break;
    at = end + 1;
  }
}
