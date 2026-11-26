import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AuthorView, NextOwnerItem } from "../api.js";
import {
  type RunPresence,
  runPresence,
  runPresenceLabel,
  runRing,
} from "../run-presence.js";
import { useInlineIdentity } from "./IdentityRow.js";
import { RunRing } from "./layout/RunRingLayout.js";
import { Tooltip } from "./Tooltip.js";
import { Button } from "./ui/button.js";
import * as Popover from "./ui/popover.js";

// Only hover-opened profiles participate; clicked profiles remain pinned.
let dismissHoveredProfile: (() => void) | undefined;

/** Only root-relative, same-origin image paths supplied by the read API. */
function avatarPath(value: string | null | undefined) {
  return value && /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : undefined;
}

function colorIndex(id: string) {
  let hash = 0;
  for (const character of id)
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return hash % 5;
}

function avatarVariant(src: string | undefined, size: 64 | 128 | 256) {
  return src?.replace(
    /^(\/avatars\/v1\/[a-z0-9-]+\/)head-(64|128|256)\.webp$/,
    `$1head-${size}.webp`,
  );
}

/**
 * Cardigan's own rule logic (scheduler, merge gate, reconciliation, timers)
 * is not a person: it gets one fixed gear icon instead of a lettered avatar.
 */
export function SystemAvatar({
  size,
}: {
  size?: 24 | 32 | 64 | 128 | undefined;
}) {
  return (
    <span
      className="employee-avatar employee-system"
      data-system-icon="gear"
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      </svg>
    </span>
  );
}

function EmployeeAvatar({
  src,
  initial,
  color,
  size: requested,
  ring,
}: {
  src: string | undefined;
  initial: string | undefined;
  color: number | "role";
  size?: 24 | 32 | 64 | 128 | undefined;
  ring?: "running" | "queued" | null | undefined;
}) {
  const [failedImage, setFailedImage] = useState<string>();
  const pixels = (requested ?? 32) > 64 ? 128 : 64;
  const image = avatarVariant(src, pixels);
  const retina = avatarVariant(src, pixels === 64 ? 128 : 256);
  // Inside a ring the slot carries the size and the face shrinks within it.
  const size = ring ? undefined : requested;
  const face = (
    <span
      className={`employee-avatar employee-color-${color}`}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    >
      {image && failedImage !== image ? (
        <img
          src={image}
          srcSet={retina !== image ? `${image} 1x, ${retina} 2x` : undefined}
          alt=""
          onError={() => setFailedImage(image)}
        />
      ) : (
        <span>{initial}</span>
      )}
    </span>
  );
  return ring ? (
    <RunRing state={ring} size={requested}>
      {face}
    </RunRing>
  ) : (
    face
  );
}

/** The avatar alone (decorative), e.g. beside a name in a suggestion list. */
export function EmployeeFace({
  employee,
  size,
}: {
  employee: { id: string; name: string; avatar: string | null };
  size?: 24 | 32;
}) {
  return (
    <EmployeeAvatar
      src={avatarPath(employee.avatar)}
      initial={Array.from(employee.name)[0]?.toUpperCase()}
      color={colorIndex(employee.id)}
      size={size}
    />
  );
}

export function EmployeeIdentity({
  employee,
  member,
  author,
  author_role,
  author_display,
  metadata,
  showTitle = true,
  avatarOnly = false,
  avatarSize,
  presence,
}: { [K in keyof AuthorView]?: AuthorView[K] | undefined } & {
  showTitle?: boolean;
  avatarOnly?: boolean;
  avatarSize?: 24 | 32 | 64 | 128;
  metadata?: string;
  /**
   * C-531: only hosts scoped to "this card + this person" pass it (board
   * participants, a work item's owner, an execution row). It adds the run
   * ring and makes the hover text and accessible name "姓名，状态".
   */
  presence?: RunPresence | undefined;
}) {
  const inline = useInlineIdentity();
  const inlineSize = inline ? 24 : avatarSize;
  const identityClass = `employee-identity${inline ? " employee-inline" : ""}`;
  const [open, setOpen] = useState<"hover" | "click" | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const returnFocus = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const mounted = useRef(false);
  const statusId = useId();
  const closeHover = useCallback(() => {
    clearTimeout(closeTimer.current);
    setOpen((mode) => (mode === "hover" ? null : mode));
    if (dismissHoveredProfile === closeHover) dismissHoveredProfile = undefined;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
      clearTimeout(focusTimer.current);
      if (dismissHoveredProfile === closeHover)
        dismissHoveredProfile = undefined;
    };
  }, [closeHover]);
  const profile = member ?? employee;
  const role = member
    ? "所有者"
    : (employee?.role_id ?? author_role ?? "未知角色");
  const name =
    profile?.name ??
    author_display ??
    (author === "human"
      ? "所有者"
      : author === "system"
        ? "系统"
        : `未命名的 ${role}`);
  const system = !profile && author === "system";
  const src = avatarPath(profile?.avatar);
  const initial = Array.from(
    profile?.name ?? (author === "human" ? name : role),
  )[0]?.toUpperCase();
  const color = profile ? colorIndex(profile.id) : "role";
  const status = presence ? runPresenceLabel(name, presence) : undefined;
  const ring = presence ? runRing(presence) : null;
  const keepOpen = () => clearTimeout(closeTimer.current);
  const leave = () => {
    clearTimeout(openTimer.current);
    keepOpen();
    closeTimer.current = setTimeout(closeHover, 180);
  };
  const identity = (
    <>
      {system ? (
        <SystemAvatar size={inlineSize} />
      ) : (
        <EmployeeAvatar
          src={src}
          initial={initial}
          color={color}
          size={inlineSize}
          ring={ring}
        />
      )}
      {!avatarOnly && (
        <span className="employee-label">
          <strong>{name}</strong>
          {showTitle && !inline && profile?.title && (
            <span className="employee-title">{profile.title}</span>
          )}
        </span>
      )}
      {status && profile && (
        <span id={statusId} className="visually-hidden">
          {status}
        </span>
      )}
    </>
  );
  if (!profile) {
    if (metadata)
      return (
        <Tooltip content={metadata}>
          <button
            type="button"
            className={`${identityClass} employee-trigger`}
            aria-label={name}
          >
            {identity}
          </button>
        </Tooltip>
      );
    return avatarOnly || status ? (
      <Tooltip content={status ?? name}>
        <span
          className={identityClass}
          role="img"
          aria-label={status ?? name}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Tooltip content must be reachable by keyboard.
          tabIndex={0}
        >
          {identity}
        </span>
      </Tooltip>
    ) : (
      <span className={identityClass}>{identity}</span>
    );
  }
  return (
    <Popover.Root
      open={open !== null}
      onOpenChange={(value) => {
        clearTimeout(openTimer.current);
        closeHover();
        setOpen(value ? "click" : null);
      }}
    >
      {/* The status label outranks the trigger's own aria-label (C-531). */}
      <Popover.Trigger asChild aria-labelledby={status ? statusId : undefined}>
        <button
          ref={trigger}
          type="button"
          className={`${identityClass} employee-trigger`}
          aria-label={`${name}的${member ? "成员" : "员工"}卡片`}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            keepOpen();
            clearTimeout(openTimer.current);
            if (open) return;
            openTimer.current = setTimeout(() => {
              dismissHoveredProfile?.();
              dismissHoveredProfile = closeHover;
              returnFocus.current = false;
              setOpen("hover");
            }, 1000);
          }}
          onPointerLeave={leave}
          onPointerCancel={leave}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            clearTimeout(openTimer.current);
            keepOpen();
            if (dismissHoveredProfile === closeHover)
              dismissHoveredProfile = undefined;
            returnFocus.current = true;
            setOpen((mode) => (mode === "click" ? null : "click"));
          }}
        >
          {identity}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="popover-content employee-card"
          // C-136: open upward so the profile never covers the row it was
          // opened from (Radix flips it below when there is no room above).
          side="top"
          collisionPadding={8}
          sideOffset={6}
          align="start"
          aria-label={`${name}的${member ? "成员" : "员工"}卡片`}
          onPointerEnter={keepOpen}
          onPointerLeave={leave}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            // Radix skips focus return after an outside click. Restore it
            // (now and after the click's own default focus) unless the click
            // deliberately focused another control, which keeps its focus.
            event.preventDefault();
            // Radix defers this callback and can invoke it after our cleanup.
            if (!mounted.current || !returnFocus.current) return;
            const target = trigger.current;
            const restore = () => {
              if (!mounted.current) return;
              const active = document.activeElement;
              if (target?.isConnected && (!active || active === document.body))
                target.focus();
            };
            restore();
            clearTimeout(focusTimer.current);
            focusTimer.current = setTimeout(restore, 0);
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <EmployeeAvatar src={src} initial={initial} color={color} size={64} />
          <div className="employee-card-body">
            <p className="employee-card-heading">
              <strong>{profile.name}</strong>
              {profile.title && (
                <span className="employee-title">{profile.title}</span>
              )}
            </p>
            {employee?.bio?.trim() && (
              <p className="employee-card-bio">{employee.bio}</p>
            )}
            {status && <p className="employee-card-meta">{status}</p>}
            <p className="employee-card-meta">角色：{role}</p>
            {metadata && <p className="employee-card-meta">{metadata}</p>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function NextOwners({
  owners,
  empty = "无人",
  avatarSize,
}: {
  owners: readonly NextOwnerItem[];
  empty?: string;
  avatarSize?: 24 | 32 | 64 | 128;
}) {
  if (!owners.length) return <>{empty}</>;
  return (
    <span className="employee-group">
      {owners.map((owner) => (
        <EmployeeIdentity
          key={`${owner.kind}-${owner.ref}`}
          {...owner}
          author={owner.kind === "human" ? "human" : undefined}
          author_role={
            owner.author_role ?? (owner.kind === "role" ? owner.ref : undefined)
          }
          showTitle={false}
          {...(avatarSize ? { avatarSize } : {})}
        />
      ))}
    </span>
  );
}

export function ProduceOwners({
  owners,
  label = "产出负责人",
  presence = false,
}: {
  owners: readonly (AuthorView & { readonly run_presence?: unknown })[];
  label?: string;
  /** C-531: board participants show what each person does for this card. */
  presence?: boolean;
}) {
  if (!owners.length) return null;
  // C-765: runners take the visible slots first. The server already orders
  // them by Run start; this stable split keeps that order and leaves the rest
  // as given, so with nobody running nothing moves.
  const ordered = presence
    ? [
        ...owners.filter(
          (owner) => runPresence(owner.run_presence).state === "running",
        ),
        ...owners.filter(
          (owner) => runPresence(owner.run_presence).state !== "running",
        ),
      ]
    : owners;
  const ownerName = (owner: AuthorView) =>
    owner.employee?.name ??
    owner.author_display ??
    `未命名的 ${owner.author_role ?? "未知角色"}`;
  const hidden = ordered.slice(3).map((owner) => ({
    name: ownerName(owner),
    presence: presence ? runPresence(owner.run_presence) : undefined,
  }));
  // +N never spins; hidden runners are named in its hover text and name.
  const hiddenRunners = hidden
    .filter((owner) => owner.presence?.state === "running")
    .map((owner) => owner.name);
  return (
    <fieldset className="employee-group employee-owners" aria-label={label}>
      {ordered.slice(0, 3).map((owner, index) => (
        <EmployeeIdentity
          key={owner.employee?.id ?? owner.author ?? index}
          {...owner}
          avatarOnly
          presence={presence ? runPresence(owner.run_presence) : undefined}
        />
      ))}
      {owners.length > 3 && (
        <Tooltip
          content={hidden
            .map((owner) =>
              owner.presence
                ? runPresenceLabel(owner.name, owner.presence)
                : owner.name,
            )
            .join(presence ? "；" : "、")}
        >
          <Button
            type="button"
            variant="ghost"
            size="avatar"
            className="employee-overflow ui-avatar-overflow"
            aria-label={`另有 ${owners.length - 3} 位${label}${
              hiddenRunners.length
                ? `，其中正在为这张卡运行：${hiddenRunners.join("、")}`
                : ""
            }`}
          >
            +{owners.length - 3}
          </Button>
        </Tooltip>
      )}
    </fieldset>
  );
}
