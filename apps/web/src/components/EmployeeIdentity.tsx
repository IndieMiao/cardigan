import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import type { AuthorView, NextOwnerItem } from "../api.js";
import { Tooltip } from "./Tooltip.js";

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
export function SystemAvatar({ size }: { size?: 32 | 64 | 128 | undefined }) {
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
  size,
}: {
  src: string | undefined;
  initial: string | undefined;
  color: number | "role";
  size?: 32 | 64 | 128 | undefined;
}) {
  const [failedImage, setFailedImage] = useState<string>();
  const pixels = (size ?? 32) > 64 ? 128 : 64;
  const image = avatarVariant(src, pixels);
  const retina = avatarVariant(src, pixels === 64 ? 128 : 256);
  return (
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
}: { [K in keyof AuthorView]?: AuthorView[K] | undefined } & {
  showTitle?: boolean;
  avatarOnly?: boolean;
  avatarSize?: 32 | 64 | 128;
  metadata?: string;
}) {
  const [open, setOpen] = useState<"hover" | "click" | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const returnFocus = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      clearTimeout(closeTimer.current);
      clearTimeout(focusTimer.current);
    },
    [],
  );
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
  const keepOpen = () => clearTimeout(closeTimer.current);
  const leave = () => {
    keepOpen();
    closeTimer.current = setTimeout(
      () => setOpen((mode) => (mode === "hover" ? null : mode)),
      180,
    );
  };
  const identity = (
    <>
      {system ? (
        <SystemAvatar size={avatarSize} />
      ) : (
        <EmployeeAvatar
          src={src}
          initial={initial}
          color={color}
          size={avatarSize}
        />
      )}
      {!avatarOnly && (
        <span className="employee-label">
          <strong>{name}</strong>
          {showTitle && profile?.title && (
            <span className="employee-title">{profile.title}</span>
          )}
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
            className="employee-identity employee-trigger"
            aria-label={name}
          >
            {identity}
          </button>
        </Tooltip>
      );
    return avatarOnly ? (
      <span
        className="employee-identity"
        role="img"
        aria-label={name}
        title={name}
      >
        {identity}
      </span>
    ) : (
      <span className="employee-identity">{identity}</span>
    );
  }
  return (
    <Popover.Root
      open={open !== null}
      onOpenChange={(value) => setOpen(value ? "click" : null)}
    >
      <Popover.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          className="employee-identity employee-trigger"
          aria-label={`${name}的${member ? "成员" : "员工"}卡片`}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            keepOpen();
            if (!open) returnFocus.current = false;
            setOpen((mode) => mode ?? "hover");
          }}
          onPointerLeave={leave}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            keepOpen();
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
            if (!returnFocus.current) return;
            const target = trigger.current;
            const restore = () => {
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
            <p className="employee-card-meta">角色：{role}</p>
            {metadata && <p className="employee-card-meta">{metadata}</p>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function NextOwners({ owners }: { owners: readonly NextOwnerItem[] }) {
  if (!owners.length) return <>无人</>;
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
        />
      ))}
    </span>
  );
}

export function ProduceOwners({
  owners,
  label = "产出负责人",
}: {
  owners: readonly AuthorView[];
  label?: string;
}) {
  if (!owners.length) return null;
  return (
    <fieldset className="employee-group employee-owners" aria-label={label}>
      {owners.slice(0, 3).map((owner, index) => (
        <EmployeeIdentity
          key={owner.employee?.id ?? owner.author ?? index}
          {...owner}
          avatarOnly
        />
      ))}
      {owners.length > 3 && (
        <Tooltip
          content={owners
            .slice(3)
            .map(
              (owner) =>
                owner.employee?.name ??
                owner.author_display ??
                `未命名的 ${owner.author_role ?? "未知角色"}`,
            )
            .join("、")}
        >
          <button
            type="button"
            className="quiet employee-overflow"
            aria-label={`另有 ${owners.length - 3} 位${label}`}
          >
            +{owners.length - 3}
          </button>
        </Tooltip>
      )}
    </fieldset>
  );
}
