import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { Input } from "./input.js";
import {
  SuggestionList,
  SuggestionOption,
  SuggestionStatus,
} from "./suggestion-list.js";

export interface ComboboxOption {
  readonly value: string;
  /** Secondary text after the value (e.g. metadata), muted. */
  readonly meta?: string | undefined;
}

/** How many matches the list renders; the rest are reached by typing more. */
export const COMBOBOX_LIMIT = 100;

/**
 * C-564: a text field with a filtered list of suggested values (ARIA 1.2
 * combobox, list autocomplete). Free text is allowed: the list only helps to
 * find a value. Focus stays in the field; ↓/↑ move through the list, Enter
 * picks, Escape closes. Opening without typing shows every option; typing
 * filters by substring (case-insensitive). `status` is one line shown at the
 * top of the list (loading, a read failure).
 */
export function Combobox({
  value,
  onValueChange,
  options,
  label,
  status,
  ...input
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly ComboboxOption[];
  /** Accessible name of the list. */
  label: string;
  status?: ReactNode;
} & Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange" | "role" | "list" | "type"
>) {
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  /** `null` until the person types: then every option is shown. */
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const needle = (query ?? "").trim().toLowerCase();
  const all = needle
    ? options.filter((o) => o.value.toLowerCase().includes(needle))
    : options;
  const matches = all.slice(0, COMBOBOX_LIMIT);
  const current = active < matches.length ? active : -1;
  const show = open && (matches.length > 0 || status !== undefined);
  const optionId = (index: number) => `${id}-option-${index}`;
  const close = () => {
    setOpen(false);
    setActive(-1);
    setQuery(null);
  };
  const choose = (option: ComboboxOption) => {
    onValueChange(option.value);
    close();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    input.onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(event.key === "ArrowDown" ? 0 : matches.length - 1);
        return;
      }
      if (!matches.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + matches.length) % matches.length);
    } else if (event.key === "Enter" && show && current >= 0) {
      event.preventDefault();
      const option = matches[current];
      if (option) choose(option);
    } else if (event.key === "Escape" && show) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") close();
  };
  return (
    <>
      <Input
        {...input}
        ref={field}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={show}
        aria-controls={show ? listId : undefined}
        aria-activedescendant={
          show && current >= 0 ? optionId(current) : undefined
        }
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value);
          setQuery(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          input.onClick?.(event);
          setOpen(true);
        }}
        onBlur={(event) => {
          input.onBlur?.(event);
          close();
        }}
      />
      <SuggestionList
        open={show}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        field={field}
        id={listId}
        label={label}
        matchField
      >
        {status !== undefined && <SuggestionStatus>{status}</SuggestionStatus>}
        {matches.map((option, index) => (
          <SuggestionOption
            key={option.value}
            id={optionId(index)}
            active={index === current}
            label={option.value}
            meta={option.meta}
            onActivate={() => setActive(index)}
            onSelect={() => choose(option)}
          />
        ))}
        {all.length > matches.length && (
          <SuggestionStatus>
            另有 {all.length - matches.length} 项
          </SuggestionStatus>
        )}
      </SuggestionList>
    </>
  );
}
