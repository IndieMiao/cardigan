import { type RefObject, useEffect, useRef, useState } from "react";
import type { CommentBoxHandle } from "./CommentBox.js";
import { IdBadge } from "./IdTag.js";

export interface CardSection {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
}

/** The drawer body owns scrolling; a full detail page uses the window. */
export function CardSectionNav({
  sections,
  article,
  cardId,
  title,
  commentBox,
  inDrawer = false,
}: {
  sections: readonly CardSection[];
  article: RefObject<HTMLElement | null>;
  cardId: string;
  title: string;
  commentBox: RefObject<CommentBoxHandle | null>;
  inDrawer?: boolean;
}) {
  const nav = useRef<HTMLElement>(null);
  const [active, setActive] = useState(sections[0]?.id);
  const keys = sections.map((s) => s.id).join("|");
  useEffect(() => {
    const page = article.current,
      bar = nav.current;
    if (!page || !bar) return;
    const root = page.closest<HTMLElement>(".drawer-body");
    const scroller = root ?? window;
    const update = () => {
      const gap =
        Number.parseFloat(
          window.getComputedStyle(bar).getPropertyValue("--gap"),
        ) || 0;
      page.style.setProperty(
        "--card-scroll-offset",
        `${scrollInset(bar, root)}px`,
      );
      const top = bar.getBoundingClientRect().bottom + gap;
      let current = keys.split("|")[0];
      for (const id of keys.split("|")) {
        const target = document.getElementById(id);
        if (
          target &&
          page.contains(target) &&
          target.getBoundingClientRect().top <= top + 2
        )
          current = id;
      }
      const height = root?.clientHeight ?? window.innerHeight;
      const extent =
        root?.scrollHeight ?? document.documentElement.scrollHeight;
      const offset = root?.scrollTop ?? window.scrollY;
      // A short last section cannot reach the sticky header. Treat the final
      // spacing (including fractional layout settling) as the end of the page.
      if (extent > height && offset + height >= extent - 16)
        current = keys.split("|").at(-1);
      setActive(current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(page);
    observer?.observe(bar);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
      page.style.removeProperty("--card-scroll-offset");
    };
  }, [article, keys]);
  const scrollTo = (target: HTMLElement) => {
    const root = article.current?.closest<HTMLElement>(".drawer-body");
    const inset = nav.current ? scrollInset(nav.current, root) : 0;
    const top =
      target.getBoundingClientRect().top -
      (root?.getBoundingClientRect().top ?? 0) +
      (root?.scrollTop ?? window.scrollY) -
      inset;
    (root ?? window).scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  };
  return (
    <nav ref={nav} className="card-section-nav" aria-label="卡片区块导航">
      {!inDrawer && (
        <div className="card-nav-identity">
          <span className="card-nav-id">
            <IdBadge id={cardId} />
          </span>
          <span className="card-nav-title" title={title}>
            {title}
          </span>
        </div>
      )}
      <div className="card-nav-links">
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            className="quiet"
            aria-current={active === section.id ? "location" : undefined}
            onClick={() => {
              const target = document.getElementById(section.id);
              if (target) {
                for (
                  let element: HTMLElement | null = target;
                  element;
                  element = element.parentElement
                )
                  if (element instanceof HTMLDetailsElement)
                    element.open = true;
                const contents = target.querySelector<HTMLDetailsElement>(
                  ":scope > section > details, :scope > details",
                );
                if (contents) contents.open = true;
                setActive(section.id);
                scrollTo(target);
              }
            }}
          >
            {section.label}
            {section.count === undefined ? "" : `（${section.count}）`}
          </button>
        ))}
        <button
          type="button"
          className="write-comment"
          onClick={() => {
            commentBox.current?.focus(scrollTo);
          }}
        >
          写评论
        </button>
      </div>
    </nav>
  );
}

function scrollInset(bar: HTMLElement, root?: HTMLElement | null): number {
  const style = window.getComputedStyle(bar);
  return (
    bar.getBoundingClientRect().height +
    (root
      ? Number.parseFloat(window.getComputedStyle(root).paddingTop) || 0
      : 0) +
    (Number.parseFloat(style.top) || 0) +
    (Number.parseFloat(style.getPropertyValue("--gap")) || 0)
  );
}
