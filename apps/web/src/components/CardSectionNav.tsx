export interface CardSection {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
}

/** Shared tabs; panels stay mounted so switching never discards a draft. */
export function CardSectionNav({
  sections,
  active,
  onSelect,
}: {
  sections: readonly CardSection[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="card-section-nav" role="tablist" aria-label="卡片区块导航">
      {sections.map((section, index) => (
        <button
          key={section.id}
          id={`${section.id}-tab`}
          type="button"
          role="tab"
          className="quiet"
          aria-controls={section.id}
          aria-selected={active === section.id}
          tabIndex={active === section.id ? 0 : -1}
          onClick={() => onSelect(section.id)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % sections.length
                : event.key === "ArrowLeft"
                  ? (index + sections.length - 1) % sections.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? sections.length - 1
                      : undefined;
            const target = next === undefined ? undefined : sections[next];
            if (!target) return;
            event.preventDefault();
            onSelect(target.id);
            document.getElementById(`${target.id}-tab`)?.focus();
          }}
        >
          {section.label}
          {section.count === undefined ? "" : `（${section.count}）`}
        </button>
      ))}
    </div>
  );
}
