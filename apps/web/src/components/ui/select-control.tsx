import {
  type ButtonHTMLAttributes,
  Children,
  isValidElement,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select.js";

interface Option {
  value: string;
  label: ReactNode;
  disabled: boolean;
}
// Existing forms can retain <option> data declarations; no visible native select is rendered.
function collect(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{
        value?: string | number;
        disabled?: boolean;
        children?: ReactNode;
      }>(child)
    )
      return [];
    if (child.type === "option")
      return [
        {
          value: String(child.props.value ?? child.props.children ?? ""),
          label: child.props.children,
          disabled: child.props.disabled ?? false,
        },
      ];
    return collect(child.props.children);
  });
}
const encode = (value: string) => `value:${value}`;
export interface SelectControlProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "onChange" | "value" | "defaultValue" | "type"
  > {
  value: string | number;
  onValueChange: (value: string) => void;
  prefix?: string;
  required?: boolean;
}
export function SelectControl({
  children,
  value,
  onValueChange,
  prefix,
  id,
  name,
  disabled,
  required,
  className,
  "aria-label": label,
  "aria-labelledby": labelledby,
  "aria-describedby": describedby,
  ...rest
}: SelectControlProps) {
  const [validationRequested, setValidationRequested] = useState(false);
  const errorId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const options = collect(children);
  const current = String(value);
  const invalid = Boolean(validationRequested && required && !current);
  return (
    <>
      <Select
        value={encode(current)}
        onValueChange={(v) => {
          setValidationRequested(false);
          onValueChange(v.slice(6));
        }}
        {...(disabled !== undefined ? { disabled } : {})}
        {...(required !== undefined ? { required } : {})}
      >
        <SelectTrigger
          ref={trigger}
          id={id}
          aria-label={label}
          aria-labelledby={labelledby}
          aria-invalid={invalid || undefined}
          aria-describedby={
            [describedby, invalid ? errorId : undefined]
              .filter(Boolean)
              .join(" ") || undefined
          }
          className={className}
          {...rest}
        >
          {prefix && <span className="ui-select-prefix">{prefix}：</span>}
          <SelectValue data-ui="select-value" placeholder="请选择" />
        </SelectTrigger>
        <SelectContent
          position="popper"
          align="start"
          onCloseAutoFocus={(event) => {
            const active = document.activeElement;
            if (
              active &&
              active !== document.body &&
              active !== trigger.current
            )
              event.preventDefault();
          }}
        >
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={encode(option.value)}
              data-value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(name || required) && (
        <select
          value={current}
          className="ui-native-select"
          name={name}
          disabled={disabled}
          required={required}
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => onValueChange(event.target.value)}
          onInvalid={(event) => {
            event.preventDefault();
            setValidationRequested(true);
            trigger.current?.focus();
          }}
        >
          {options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </option>
          ))}
        </select>
      )}
      {invalid && (
        <span id={errorId} role="alert" className="ui-field-error">
          请选择一项。
        </span>
      )}
    </>
  );
}
