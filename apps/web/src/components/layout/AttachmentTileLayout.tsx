import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { Tooltip } from "../Tooltip.js";
import { IconButton } from "../ui/button.js";
import { DownloadIcon } from "../ui/icons.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import styles from "./AttachmentTileLayout.module.css";

/**
 * C-820: attachments as a grid of equal tiles. Columns follow the container
 * (each at least `--ui-attachment-tile` wide, one or two on a phone). Put
 * media tiles first: the first file tile starts a new row, so every row holds
 * tiles of one height.
 */
export function AttachmentTileGrid({
  label,
  flow = false,
  more,
  children,
}: {
  label?: string | undefined;
  /** Inside flowing content (a timeline entry, a decision): space around. */
  flow?: boolean;
  /** A last entry on a row of its own, e.g. “还有 N 个”. */
  more?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ul className={cn(styles.grid, flow && styles.flow)} aria-label={label}>
      {children}
      {more && <li className={styles.more}>{more}</li>}
    </ul>
  );
}

/**
 * One attachment: thumbnail (or a slim type strip for other files), one line
 * of name with the download button, one line of facts and at most two lines
 * of note. The full name is in the tooltips, the full note opens from it.
 */
export function AttachmentTile({
  id,
  attachmentId,
  kind,
  media,
  name,
  uploader,
  facts,
  factsTip,
  note,
  download,
  footer,
}: {
  id?: string | undefined;
  attachmentId?: string | undefined;
  /** `media` has a thumbnail area; `file` a slim icon-and-type strip. */
  kind: "media" | "file";
  media: ReactNode;
  name: string;
  /** The uploader's small avatar. */
  uploader: ReactNode;
  /** Time and size, one line; `factsTip` spells them out in full. */
  facts: ReactNode;
  factsTip: string;
  note?: string | undefined;
  download: string;
  /** e.g. the decision the file rests on. */
  footer?: ReactNode;
}) {
  return (
    <li
      id={id}
      className={styles.tile}
      data-ui="attachment-tile"
      data-attachment-id={attachmentId}
      data-kind={kind}
    >
      <div className={styles.media} data-attachment-media>
        {media}
      </div>
      <div className={styles.body}>
        <div className={styles.head}>
          <Tooltip content={name}>
            <span className={styles.name} data-attachment-name>
              {name}
            </span>
          </Tooltip>
          <Tooltip content={`下载 ${name}`}>
            <IconButton asChild variant="ghost" aria-label={`下载 ${name}`}>
              <a href={download} download>
                <DownloadIcon aria-hidden="true" />
                <span className="visually-hidden">下载 {name}</span>
              </a>
            </IconButton>
          </Tooltip>
        </div>
        <div className={styles.meta} data-attachment-meta>
          {uploader}
          <Tooltip content={factsTip}>
            <span className={styles.facts}>{facts}</span>
          </Tooltip>
        </div>
        <AttachmentNote name={name} note={note} />
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </li>
  );
}

/** Two lines of note; pressing it shows the whole note beside the tile. */
function AttachmentNote({
  name,
  note,
}: {
  name: string;
  note: string | undefined;
}) {
  if (!note) return <span className={styles.note} />;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(styles.note, styles.noteButton)}
          data-attachment-note
        >
          {note}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={12}
        className={styles.notePanel}
        aria-label={`${name} 的说明`}
      >
        <p className={styles.noteHeading}>{name}</p>
        <p className={styles.noteText}>{note}</p>
      </PopoverContent>
    </Popover>
  );
}

/** The thumbnail button of a bitmap (`compact`: a 40px square in a line). */
export const AttachmentThumb = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { compact?: boolean }
>(({ compact = false, className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(styles.thumb, compact && styles.thumbCompact, className)}
    {...props}
  />
));
AttachmentThumb.displayName = "AttachmentThumb";

/** A file without a preview: its type icon and a short type name. */
export function AttachmentFileMark({
  icon,
  label,
}: {
  icon: ReactNode;
  label: string;
}) {
  return (
    <span className={styles.fileMark}>
      {icon}
      <span>{label}</span>
    </span>
  );
}
