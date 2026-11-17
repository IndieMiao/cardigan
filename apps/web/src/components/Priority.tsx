import { useId, useRef, useState } from "react";
import { Tooltip } from "./Tooltip.js";
import { Button, IconButton } from "./ui/button.js";
import { ChevronDownIcon } from "./ui/icons.js";
import { Input } from "./ui/input.js";
import * as Popover from "./ui/popover.js";

export const PRIORITY_LEVELS = [
  { name: "none", label: "无" },
  { name: "low", label: "低" },
  { name: "medium", label: "中" },
  { name: "high", label: "高" },
  { name: "urgent", label: "紧急" },
] as const;

export function PriorityGlyph({ value }: { value: number }) {
  return (
    <svg
      className={`priority-glyph priority-${PRIORITY_LEVELS[value]?.name ?? "none"}`}
      viewBox="0 0 20 20"
      aria-hidden="true"
    >
      {value === 4 ? (
        <>
          <rect x="2" y="2" width="16" height="16" rx="3" fill="currentColor" />
          <path
            d="M10 5v6m0 3v1"
            fill="none"
            stroke="var(--surface)"
            strokeWidth="2"
          />
        </>
      ) : value > 0 ? (
        [0, 1, 2].map((bar) => (
          <rect
            key={bar}
            x={3 + bar * 5}
            y={12 - bar * 4}
            width="3"
            height={5 + bar * 4}
            rx="1"
            fill="currentColor"
            opacity={bar < value ? 1 : 0.2}
          />
        ))
      ) : (
        <g fill="none" stroke="currentColor" strokeWidth="1.7">
          <circle cx="10" cy="10" r="7" />
          <path d="m5 15 10-10" />
        </g>
      )}
    </svg>
  );
}

export function PriorityBadge({ value }: { value: number }) {
  const label = `优先级：${PRIORITY_LEVELS[value]?.label ?? "无"}`;
  return (
    <Tooltip content={label}>
      <IconButton variant="ghost" className="priority-badge" aria-label={label}>
        <PriorityGlyph value={value} />
      </IconButton>
    </Tooltip>
  );
}

/** Searchable single-select; input focus stays put through arrow navigation. */
export function PrioritySelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const matches = PRIORITY_LEVELS.map((level, rank) => ({
    ...level,
    rank,
  })).filter((level) =>
    `${level.name} ${level.label}`.includes(query.trim().toLowerCase()),
  );
  const selected = matches.find((level) => level.rank === active) ?? matches[0];
  const choose = (rank: number) => {
    onChange(rank);
    setOpen(false);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
        setActive(value);
      }}
    >
      <Popover.Trigger asChild>
        <Button
          type="button"
          className="priority-select quiet"
          aria-label={`优先级：${PRIORITY_LEVELS[value]?.label ?? "无"}`}
        >
          <PriorityGlyph value={value} />
          <span>{PRIORITY_LEVELS[value]?.label ?? "无"}</span>
          <ChevronDownIcon aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="popover-content priority-menu"
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
        >
          <Input
            className="priority-search"
            ref={input}
            role="combobox"
            aria-label="搜索优先级"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              selected ? `${listId}-${selected.rank}` : undefined
            }
            placeholder="搜索优先级…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!matches.length) return;
                const index = matches.findIndex(
                  (level) => level.rank === selected?.rank,
                );
                setActive(
                  matches[
                    (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      matches.length) %
                      matches.length
                  ]?.rank ?? value,
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (selected) choose(selected.rank);
              }
            }}
          />
          <div id={listId} role="listbox" aria-label="优先级">
            {matches.map((level) => (
              <div
                key={level.rank}
                id={`${listId}-${level.rank}`}
                role="option"
                aria-selected={value === level.rank}
                tabIndex={-1}
                className={`priority-option${selected?.rank === level.rank ? " active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(level.rank)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ")
                    choose(level.rank);
                }}
              >
                <PriorityGlyph value={level.rank} />
                <span>{level.label}</span>
                <span className="priority-check" aria-hidden="true">
                  {value === level.rank ? "✓" : ""}
                </span>
              </div>
            ))}
          </div>
          {!matches.length && <p className="hint">没有匹配的优先级</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
