import { CardDetailTabs } from "./layout/CardDetailLayout.js";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.js";
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
    <CardDetailTabs>
      <Tabs value={active} onValueChange={onSelect}>
        <TabsList aria-label="卡片区块导航" loop>
          {sections.map((section) => (
            <TabsTrigger
              key={section.id}
              value={section.id}
              onClick={() => onSelect(section.id)}
              id={`${section.id}-tab`}
              aria-controls={section.id}
            >
              {section.label}
              {section.count === undefined ? "" : `（${section.count}）`}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </CardDetailTabs>
  );
}
