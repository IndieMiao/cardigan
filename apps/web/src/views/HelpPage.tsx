import { CARD_GUIDE_SLUG, CardLegend } from "../components/CardLegend.js";
import { EmptyState, PageTitle } from "../components/Foundation.js";
import { HelpMarkdown } from "../components/HelpMarkdown.js";
import { findHelpDocument, helpDocuments } from "../help-content.js";
import { routeHash, useRouteFilters } from "../route.js";

export function HelpPage({ projectId }: { projectId: string }) {
  const [filters] = useRouteFilters({ kind: "help", projectId });
  const selected = findHelpDocument(helpDocuments, filters.doc);
  return (
    <section className="help-page">
      <PageTitle title="帮助" />
      <div className="help-layout">
        <nav className="help-directory" aria-label="帮助目录">
          <h2>目录</h2>
          {helpDocuments.map((doc) => (
            <a
              key={doc.slug}
              href={routeHash({
                kind: "help",
                projectId,
                filters: { doc: doc.slug },
              })}
              aria-current={selected?.slug === doc.slug ? "page" : undefined}
            >
              {doc.title}
            </a>
          ))}
        </nav>
        <article
          className="help-article"
          aria-label={selected?.title ?? "帮助文档"}
        >
          {selected?.slug === CARD_GUIDE_SLUG ? (
            <CardLegend projectId={projectId} />
          ) : selected ? (
            <HelpMarkdown source={selected.source} />
          ) : (
            <EmptyState>找不到这篇帮助文档，请从目录选择。</EmptyState>
          )}
        </article>
      </div>
    </section>
  );
}
