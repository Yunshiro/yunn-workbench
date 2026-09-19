import type { ReactNode } from "react";
import { Check, CircleNotch, type Icon } from "@phosphor-icons/react";

/* ---------- 状态圆点 ---------- */

export function StatusDot({ state }: { state: "ok" | "err" | "idle" | "run" }) {
  return <span className={`status-dot status-dot--${state}`} />;
}

/* ---------- 标签 ---------- */

const TAG_COLORS: Record<string, string> = {
  blue: "blue",
  green: "green",
  red: "red",
  yellow: "yellow",
  gray: "gray",
  ink: "ink",
};

export function Tag({
  color = "gray",
  children,
}: {
  color?: keyof typeof TAG_COLORS | string;
  children: ReactNode;
}) {
  return <span className={`tag tag--${TAG_COLORS[color] ?? color}`}>{children}</span>;
}

/* ---------- 复选框 ---------- */

export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`checkbox${checked ? " checkbox--on" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      {checked && <Check size={12} weight="bold" aria-hidden="true" />}
    </button>
  );
}

/* ---------- 加载骨架 ---------- */

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton skeleton--item" />
      ))}
    </div>
  );
}

/* ---------- 空状态 ---------- */

export function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: Icon;
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  const IconEl = icon;
  return (
    <div className="empty fade-in">
      <div className="empty__icon">
        <IconEl size={24} weight="light" />
      </div>
      <div className="empty__title">{title}</div>
      {desc && <div className="empty__desc">{desc}</div>}
      {action}
    </div>
  );
}

/* ---------- 加载指示 ---------- */

export function Spinner({ size = 16 }: { size?: number }) {
  return <CircleNotch className="spinner" size={size} weight="bold" />;
}

/* ---------- 错误提示 ---------- */

export function ErrorBanner({ message }: { message: string }) {
  return <div className="error-banner">{message}</div>;
}
