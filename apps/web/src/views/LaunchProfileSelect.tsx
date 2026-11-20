import { SelectControl } from "../components/ui/select-control.js";

/** The empty value: no pinned profile, the employee follows its role's. */
export const FOLLOW_ROLE = "";

/**
 * C-516: an employee's launch profile — one of the host's valid profiles
 * (C-515 `GET /api/launch-settings/profiles`), or cleared to follow the role.
 * A saved name the host no longer accepts stays visible as “已失效” so an
 * unrelated save does not silently change it.
 */
export function LaunchProfileSelect({
  value,
  profiles,
  roleProfile,
  disabled,
  onChange,
  "aria-label": label,
}: {
  /** When the select is not inside a visible label. */
  "aria-label"?: string;
  /** Pinned profile, or null when following the role. */
  value: string | null;
  profiles: readonly string[];
  /** The role's profile, named in the follow option when known. */
  roleProfile?: string | undefined;
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const current = value ?? FOLLOW_ROLE;
  const stale = value !== null && !profiles.includes(value);
  return (
    <SelectControl
      value={current}
      {...(label === undefined ? {} : { "aria-label": label })}
      {...(disabled === undefined ? {} : { disabled })}
      onValueChange={(next) => onChange(next === FOLLOW_ROLE ? null : next)}
    >
      <option value={FOLLOW_ROLE}>
        {roleProfile ? `跟随角色（${roleProfile}）` : "跟随角色"}
      </option>
      {stale && <option value={value}>{value}（已失效）</option>}
      {profiles.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </SelectControl>
  );
}
