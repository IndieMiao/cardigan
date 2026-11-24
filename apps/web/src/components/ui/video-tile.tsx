import { Film } from "lucide-react";
import { forwardRef, useState } from "react";
import { cn } from "../../lib/utils.js";

/**
 * C-683: a video's tile — its cover frame (or a film icon when the host has
 * none) with the duration and size over it. A button: the caller opens the
 * player.
 */
export const VideoTile = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    poster?: string | undefined;
    alt: string;
    /** e.g. `1:14 · 12.4 MiB`; omitted in compact rows. */
    facts?: string | undefined;
  }
>(({ poster, alt, facts, className, ...props }, ref) => {
  const [failed, setFailed] = useState<string>();
  return (
    <button
      ref={ref}
      type="button"
      data-ui="video-tile"
      className={cn("ui-video-tile", className)}
      {...props}
    >
      {poster && failed !== poster ? (
        <img
          src={poster}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(poster)}
        />
      ) : (
        <Film className="ui-video-tile-icon" aria-hidden="true" />
      )}
      {facts && <span className="ui-video-tile-facts">{facts}</span>}
    </button>
  );
});
VideoTile.displayName = "VideoTile";
