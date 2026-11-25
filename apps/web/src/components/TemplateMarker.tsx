import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CardTemplateInfo, CardView } from "../api.js";
import { IconButton } from "./ui/button.js";

/** C-411 B: neutral shapes express template identity, never priority or gates. */
export const TEMPLATE_GLYPHS = {
  dev: {
    name: "开发卡",
    shape: "代码括号",
    path: "m7 5-5 5 5 5m6-10 5 5-5 5m-2-12-2 14",
  },
  product: {
    name: "产品卡",
    shape: "立方体",
    path: "m10 2 7 4v8l-7 4-7-4V6Zm-7 4 7 4 7-4m-7 4v8",
  },
  integration: {
    name: "集成验证",
    shape: "相连方块",
    path: "M3 3h5v6H3zM12 11h5v6h-5zM8 6h5v5M7 14h5M5 9v5h2",
  },
  fast_patch: {
    name: "快速补丁",
    shape: "闪电",
    path: "m11 2-7 9h5l-1 7 8-10h-6Z",
  },
  design: {
    name: "设计稿",
    shape: "画笔",
    path: "m3 13 9-9 4 4-9 9-5 1Zm7-7 4 4M3 13l4 4m6-14 1-1 4 4-1 1",
  },
  artifact: {
    name: "产出物",
    shape: "折角文档",
    path: "M4 2h8l4 4v12H4Zm8 0v5h4M7 11h6m-6 3h4",
  },
  general: {
    name: "通用任务",
    shape: "夹板",
    path: "M5 4H3v14h14V4h-2M7 2h6v4H7ZM6 10h8m-8 4h5",
  },
  custom: {
    name: "自定义或未知模板",
    shape: "六边形内框",
    path: "m10 2 7 4v8l-7 4-7-4V6ZM7 7h6v6H7Z",
  },
} as const;
type Glyph = keyof typeof TEMPLATE_GLYPHS;

export function TemplateGlyph({ kind }: { kind: Glyph }) {
  return (
    <span className="template-marker-ink" data-template-glyph={kind}>
      <svg
        viewBox="0 0 20 20"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={TEMPLATE_GLYPHS[kind].path} />
      </svg>
    </span>
  );
}

export function templateIdentity(
  card: Pick<CardView, "template" | "template_version">,
  info?: CardTemplateInfo | null,
) {
  const version = card.template_version;
  const matched =
    info?.id === card.template && info?.version === version ? info : undefined;
  const builtin = matched?.builtin === true;
  const kind: Glyph =
    builtin && card.template && Object.hasOwn(TEMPLATE_GLYPHS, card.template)
      ? (card.template as Glyph)
      : "custom";
  const name =
    matched?.title ||
    (card.template ? `未识别模板（${card.template}）` : "未知模板");
  return {
    kind,
    name,
    label: `模板：${name} · ${version === undefined ? "版本未记录" : `v${version}`}`,
    omitted: builtin && card.template === "dev" && version === 2,
  };
}

export function TemplateMarker({
  card,
  info,
  force = false,
}: {
  card: Pick<CardView, "template" | "template_version">;
  info?: CardTemplateInfo | null | undefined;
  force?: boolean;
}) {
  const { kind, label, omitted } = templateIdentity(card, info);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const visible = (force || !omitted) && open;
  const close = () => {
    setOpen(false);
    setPinned(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed card/template must dismiss the pinned hint.
  useEffect(() => {
    setOpen(false);
    setPinned(false);
  }, [label, omitted]);
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    const dismiss = () => {
      setOpen(false);
      setPinned(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Hover does not move focus. Handle Escape before Radix's document
      // capture listener, even when focus remains on the drawer's close button.
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", handleEscape, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", handleEscape, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [visible]);
  useLayoutEffect(() => {
    if (!visible || !trigger.current || !tip.current) return;
    const a = trigger.current.getBoundingClientRect(),
      t = tip.current.getBoundingClientRect();
    setPosition({
      left: Math.max(
        12,
        Math.min(a.right - t.width, window.innerWidth - t.width - 12),
      ),
      top:
        a.bottom + t.height + 8 < window.innerHeight
          ? a.bottom + 6
          : Math.max(12, a.top - t.height - 6),
    });
  }, [visible]);
  if (omitted && !force) return null;
  return (
    <>
      <IconButton
        variant="ghost"
        ref={trigger}
        type="button"
        className="template-marker"
        aria-label={label}
        data-state={visible ? "open" : "closed"}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") setOpen(true);
        }}
        onPointerLeave={() => {
          if (!pinned && document.activeElement !== trigger.current)
            setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={() => {
          setPinned(!pinned);
          setOpen(!pinned);
        }}
      >
        <TemplateGlyph kind={kind} />
      </IconButton>
      {/* The button already has the complete accessible name; no duplicate description. */}
      {visible &&
        createPortal(
          <span
            ref={tip}
            className="template-marker-tip ui-tip"
            style={position}
            aria-hidden="true"
          >
            {label}
          </span>,
          document.body,
        )}
    </>
  );
}
