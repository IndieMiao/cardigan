// biome-ignore-all lint/security/noDangerouslySetInnerHtml: `html` is
// `renderMarkdown` output (html off, filtered links), never the raw body.
import { type MouseEvent, useState } from "react";
import { Lightbox, type LightboxImage } from "./Lightbox.js";

/**
 * C-615: a rendered Markdown body whose attachment chips open in place. An
 * image chip opens the preview (all image chips of the body, in order); a PDF
 * or text chip opens the file in a new tab; any other chip downloads.
 * Modified clicks on an image keep the browser's own behaviour.
 */
export function AttachmentRefBody({
  html,
  className,
}: {
  readonly html: string;
  readonly className: string;
}) {
  const [images, setImages] = useState<readonly LightboxImage[]>([]);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const chip = (event.target as Element).closest?.<HTMLAnchorElement>(
      "a[data-attachment-ref]",
    );
    if (!chip || !event.currentTarget.contains(chip)) return;
    const kind = chip.dataset.kind;
    const href = chip.getAttribute("href") ?? "";
    const name =
      chip.querySelector(".ui-attachment-ref-name")?.textContent ?? href;
    const modified =
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey;
    if (kind === "image" && !modified) {
      event.preventDefault();
      const chips = [
        ...event.currentTarget.querySelectorAll<HTMLAnchorElement>(
          'a[data-attachment-ref][data-kind="image"]',
        ),
      ];
      setImages(
        chips.map((c) => {
          const label =
            c.querySelector(".ui-attachment-ref-name")?.textContent ?? "";
          return {
            src: c.getAttribute("href") ?? "",
            alt: `附件 ${label}`,
            caption: (
              <>
                <strong>{label}</strong>{" "}
                <a href={c.getAttribute("href") ?? ""} download>
                  下载
                </a>
              </>
            ),
          };
        }),
      );
      setIndex(Math.max(chips.indexOf(chip), 0));
      setOpen(true);
    } else if (kind === "pdf" || kind === "text") {
      event.preventDefault();
      setError(undefined);
      openInTab(href, kind).catch(() => setError(`未能打开 ${name}`));
    }
  };
  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the chips are links; Enter on a link fires this click. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: delegation for the links inside. */}
      <div
        className={className}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {error && (
        <p className="ui-file-problems" role="alert">
          {error}
        </p>
      )}
      {open && (
        <Lightbox
          open={open}
          onOpenChange={setOpen}
          images={images}
          index={index}
          onIndexChange={setIndex}
        />
      )}
    </>
  );
}

const TAB_TYPES = {
  pdf: "application/pdf",
  text: "text/plain;charset=utf-8",
} as const;

/**
 * Open a stored file in a new tab. The server sends anything but bitmaps as a
 * download, so the bytes are fetched and shown from a local copy typed as PDF
 * or plain text: Markdown and JSON read as text, nothing runs as a page here.
 * The tab is opened before the read so the click still counts as the user's.
 */
export async function openInTab(
  href: string,
  kind: keyof typeof TAB_TYPES,
): Promise<void> {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  try {
    const response = await fetch(href, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = new Blob([await response.arrayBuffer()], {
      type: TAB_TYPES[kind],
    });
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.open(url, "_blank", "noopener");
    // Long enough for the tab to load; a reload afterwards reopens from here.
    setTimeout(() => URL.revokeObjectURL(url), 300_000);
  } catch (failure) {
    tab?.close();
    throw failure;
  }
}
