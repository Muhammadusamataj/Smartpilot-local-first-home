
import type { ComponentProps, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  AirVent,
  Ban,
  CircleDashed,
  FlaskConical,
  Flame,
  Lock,
  PlugZap,
  ShieldAlert,
  ShieldCheck,
  Unplug,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useSmartPilot } from "@/lib/smartpilot/store";
import type { CapabilityStatus, ConnectionStatus, Device } from "@/lib/smartpilot/types";

const panelVariants = cva("rounded-3xl text-card-foreground transition-colors", {
  variants: {
    variant: {
      glass: "glass",
      strong: "glass-strong",
      hero: "glass bg-gradient-hero",
      inset: "rounded-2xl border border-glass-border bg-muted/40",
    },
    pad: { none: "", sm: "p-4", md: "p-5 sm:p-6" },
  },
  defaultVariants: { variant: "glass", pad: "md" },
});

export function Panel({
  className,
  variant,
  pad,
  ...props
}: ComponentProps<"section"> & VariantProps<typeof panelVariants>) {
  return <section className={cn(panelVariants({ variant, pad }), className)} {...props} />;
}

export function PanelTitle({
  icon: Icon,
  children,
  action,
  className,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 flex items-center justify-between gap-3", className)}>
      <h2 className="flex min-w-0 items-center gap-2.5 text-base font-semibold tracking-tight">
        {Icon && (
          <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
            <Icon className="size-4" aria-hidden />
          </span>
        )}
        <span className="truncate">{children}</span>
      </h2>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  sub,
  actions,
  eyebrow,
  className,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between animate-rise",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && <div className="mb-2 flex flex-wrap gap-2">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {sub && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function DemoBadge({ className }: { className?: string }) {
  const { t } = useSmartPilot();
  return (
    <Badge variant="demo" className={className}>
      <FlaskConical className="size-3" aria-hidden /> {t("demoData")}
    </Badge>
  );
}

export function PreviewBadge({ className }: { className?: string }) {
  return (
    <Badge variant="preview" className={className}>
      <ShieldCheck className="size-3" aria-hidden /> Preview only
    </Badge>
  );
}

/** Live-control badge for screens that now use the real local backend. */
export function LiveBadge({ className }: { className?: string }) {
  return (
    <Badge variant="info" className={className}>
      <ShieldCheck className="size-3" aria-hidden /> Live local
    </Badge>
  );
}

export function PreviewNotice({ className }: { className?: string }) {
  const { t } = useSmartPilot();
  return (
    <p className={cn("flex items-start gap-2 text-xs text-status-preview", className)} role="note">
      <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{t("previewOnly")}</span>
    </p>
  );
}

/** Honest live-control notice: a short context hint after the global banner. */
export function LiveNotice({ className }: { className?: string }) {
  const { connection } = useSmartPilot();
  return (
    <p className={cn("flex items-start gap-2 text-xs text-muted-foreground", className)} role="note">
      <ShieldCheck className="mt-px size-3.5 shrink-0 text-primary" aria-hidden />
      <span>
        {connection.state === "live"
          ? "Critical devices still require your approval."
          : "Local backend not verified yet — commands are held."}
      </span>
    </p>
  );
}

export function ConnectionPill({ status }: { status: ConnectionStatus }) {
  const { t } = useSmartPilot();
  const map = {
    online: { v: "ok", icon: PlugZap, label: t("status_online") },
    offline: { v: "offline", icon: Unplug, label: t("status_offline") },
    disconnected: { v: "unknown", icon: Unplug, label: t("status_disconnected") },
    unknown: { v: "unknown", icon: CircleDashed, label: t("status_unknown") },
  } as const;
  const m = map[status];
  return (
    <Badge variant={m.v}>
      <m.icon className="size-3" aria-hidden /> {m.label}
    </Badge>
  );
}

export function ApprovalPill() {
  const { t } = useSmartPilot();
  return (
    <Badge variant="preview">
      <ShieldAlert className="size-3" aria-hidden /> {t("requiresApproval")}
    </Badge>
  );
}

export function CapabilityPill({ status }: { status: CapabilityStatus }) {
  const { t } = useSmartPilot();
  if (status === "supported") return <Badge variant="info">{t("supported")}</Badge>;
  if (status === "unverified")
    return (
      <Badge variant="unknown">
        <Lock className="size-3" aria-hidden /> {t("unverified")}
      </Badge>
    );
  return (
    <Badge variant="unknown">
      <Ban className="size-3" aria-hidden /> {t("unsupported")}
    </Badge>
  );
}

const ICONS: Record<Device["kind"], LucideIcon> = {
  air_conditioner: AirVent,
  water_pump: Waves,
  breaker: Zap,
  water_heater: Flame,
};

const TONE: Record<Device["category"], string> = {
  climate: "bg-primary/14 text-primary",
  water: "bg-cobalt/16 text-cobalt",
  power: "bg-warning/16 text-warning",
  heating: "bg-status-offline/14 text-status-offline",
};

export function DeviceGlyph({
  device,
  size = "md",
}: {
  device: Device;
  size?: "sm" | "md" | "lg";
}) {
  const Icon = ICONS[device.kind];
  const s =
    size === "lg"
      ? "size-14 rounded-2xl"
      : size === "sm"
        ? "size-9 rounded-xl"
        : "size-11 rounded-2xl";
  return (
    <span className={cn("grid shrink-0 place-items-center", s, TONE[device.category])}>
      <Icon className={size === "lg" ? "size-7" : "size-5"} aria-hidden />
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-glass-border bg-muted/20 px-6 py-10 text-center",
        className,
      )}
    >
      <span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Icon className="size-6" aria-hidden />
      </span>
      <div>
        <p className="font-medium tracking-tight">{title}</p>
        {body && <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 truncate font-display text-lg font-semibold tracking-tight tabular">
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
