// WHATWG URL parsing is pure. Declare its minimal surface without adding DOM/Node dependencies.
declare const URL: new (
  input: string,
) => { readonly protocol: string; readonly hostname: string };
export function isHttpUrl(input: string): boolean {
  if (
    !/^https?:\/\//iu.test(input) ||
    [...input].some(
      (c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === "\\",
    )
  )
    return false;
  try {
    const url = new URL(input);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}
