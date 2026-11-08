import { type RefObject, useEffect, useRef, useState } from "react";

export interface CardSection {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
}

/** The drawer body owns scrolling; a full detail page uses the window. */
export function CardSectionNav({
  sections,
  article,
}: {
  sections: readonly CardSection[];
  article: RefObject<HTMLElement | null>;
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
      const top = bar.getBoundingClientRect().bottom + 12;
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
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [article, keys]);
  const scrollTo = (target: HTMLElement) => {
    const root = article.current?.closest<HTMLElement>(".drawer-body");
    const padding = root
      ? Number.parseFloat(getComputedStyle(root).paddingTop) || 0
      : 0;
    const stickyTop = nav.current
      ? Number.parseFloat(getComputedStyle(nav.current).top) || 0
      : 0;
    const inset =
      (nav.current?.getBoundingClientRect().height ?? 0) +
      padding +
      stickyTop +
      12;
    const top =
      target.getBoundingClientRect().top -
      (root?.getBoundingClientRect().top ?? 0) +
      (root?.scrollTop ?? window.scrollY) -
      inset;
    (root ?? window).scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  };
  return (
    <nav ref={nav} className="card-section-nav" aria-label="卡片区块导航">
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          className="quiet"
          aria-current={active === section.id ? "location" : undefined}
          onClick={() => {
            const target = document.getElementById(section.id);
            if (target) {
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
          const input =
            article.current?.querySelector<HTMLTextAreaElement>(
              ".comment-input",
            );
          if (input) {
            scrollTo(input);
            input.focus({ preventScroll: true });
          }
        }}
      >
        写评论
      </button>
    </nav>
  );
}
