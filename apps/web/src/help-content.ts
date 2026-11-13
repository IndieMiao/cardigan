export interface HelpDocument {
  readonly slug: string;
  readonly title: string;
  readonly source: string;
}

/** Only these build-time imports can become help documents; URLs never read files. */
const sources = import.meta.glob<string>("./help/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

export function collectHelpDocuments(
  files: Record<string, string>,
): HelpDocument[] {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .flatMap(([path, source]) => {
      const slug = /^\.\/help\/([a-z0-9][a-z0-9-]*)\.md$/u.exec(path)?.[1];
      return slug
        ? [
            {
              slug,
              title: /^#\s+(.+)$/mu.exec(source)?.[1]?.trim() ?? slug,
              source,
            },
          ]
        : [];
    });
}

export const helpDocuments = collectHelpDocuments(sources);

export function findHelpDocument(
  documents: readonly HelpDocument[],
  slug?: string,
) {
  return slug === undefined
    ? documents[0]
    : documents.find((doc) => doc.slug === slug);
}
