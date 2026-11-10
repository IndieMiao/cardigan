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
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const role = employee?.role_id ?? author_role ?? "Agent";
  const name =
    employee?.name ??
    (author === "human"
      ? "你"
      : author === "system"
        ? "系统"
        : (author_display ?? `未命名的 ${role}`));
  const src = avatarPath(employee?.avatar);
  const initial = Array.from(
    employee?.name ?? (name === "你" ? "人" : name === "系统" ? "系" : role),
  )[0]?.toUpperCase();
  const color = employee ? colorIndex(employee.id) : "role";
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
      <EmployeeAvatar
        src={src}
        initial={initial}
        color={color}
        size={avatarSize}
      />
      {!avatarOnly && (
        <span className="employee-label">
          <strong>{name}</strong>
          {showTitle && employee?.title && (
            <span className="employee-title">{employee.title}</span>
          )}
        </span>
      )}
    </>
  );
  if (!employee) {
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
          type="button"
          className="employee-identity employee-trigger"
          aria-label={`${name}的员工卡片`}
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
          aria-label={`${name}的员工卡片`}
          onPointerEnter={keepOpen}
          onPointerLeave={leave}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            if (!returnFocus.current) event.preventDefault();
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <EmployeeAvatar src={src} initial={initial} color={color} size={64} />
          <div className="employee-card-body">
            <p className="employee-card-heading">
              <strong>{employee.name}</strong>
              {employee.title && (
                <span className="employee-title">{employee.title}</span>
              )}
            </p>
            {employee.bio?.trim() && (
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
                `未命名的 ${owner.author_role ?? "Agent"}`,
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
