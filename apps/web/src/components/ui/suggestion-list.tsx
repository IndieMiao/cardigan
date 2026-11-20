import type { ReactNode, RefObject } from "react";
import { Anchor, PopoverContent, Root } from "./popover.js";

/**
 * Inline completion for a text field (e.g. `@` mentions): a non-modal popover
 * under the field that never takes focus. The field keeps typing and drives
 * the active option through `aria-activedescendant`; Escape and pointer-down
 * outside close it. Radix keeps it inside the viewport (flip and shift).
 */
export function SuggestionList({
  open,
  onOpenChange,
  field,
  id,
  label,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The text field the list completes; pressing it does not close the list. */
  field: RefObject<HTMLElement | null>;
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <Anchor virtualRef={field} />
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="ui-suggestions"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (field.current?.contains(event.target as Node))
            event.preventDefault();
        }}
      >
        <div role="listbox" id={id} aria-label={label}>
          {children}
        </div>
      </PopoverContent>
    </Root>
  );
}

export function SuggestionOption({
  id,
  active,
  icon,
  label,
  meta,
  onSelect,
  onActivate,
}: {
  id: string;
  active: boolean;
  icon?: ReactNode;
  label: string;
  meta?: string | undefined;
  onSelect: () => void;
  onActivate: () => void;
}) {
  return (
    // Focus stays in the field; the field's keyboard handler selects options.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is the field's Enter/Tab.
    <div
      role="option"
      id={id}
      tabIndex={-1}
      aria-selected={active}
      data-highlighted={active ? "" : undefined}
      className="ui-menu-item ui-suggestion"
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => {
        if (!active) onActivate();
      }}
      onClick={onSelect}
    >
      {icon}
      <span className="ui-suggestion-label">{label}</span>
      {meta && <span className="ui-suggestion-meta">{meta}</span>}
    </div>
  );
}

/** A non-selectable line in the list, e.g. loading or a read failure. */
export function SuggestionStatus({ children }: { children: ReactNode }) {
  return (
    <div className="ui-suggestion-status" role="status">
      {children}
    </div>
  );
}
