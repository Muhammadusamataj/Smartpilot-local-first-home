import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { format, isToday, isValid, isYesterday } from "date-fns";
import {
  Ban,
  Bot,
  CalendarClock,
  CheckCircle2,
  Cpu,
  History,
  Info,
  RefreshCw,
  Search,
  SearchX,
  Settings2,
  ShieldAlert,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, LiveBadge, PageHeader, Panel } from "@/components/sp/primitives";
import { getEvents, messageOf } from "@/lib/smartpilot/backend-api";
import { useSmartPilot } from "@/lib/smartpilot/store";
import type { ActivityEvent, ActivityKind, ActivityStatus } from "@/lib/smartpilot/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/activity")({
  head: () => ({
    meta: [
      { title: "Activity — Smart Pilot Titanium Control" },
      {
        name: "description",
        content:
          "Searchable timeline of real local backend events and confirmed UI commands.",
      },
      { property: "og:title", content: "Activity — Smart Pilot Titanium Control" },
      {
        property: "og:description",
        content: "Searchable, filterable timeline of real local events and commands.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ActivityPage,
});

const KIND_META: Record<ActivityKind, { label: string; icon: LucideIcon }> = {
  device: { label: "Device", icon: Cpu },
  automation: { label: "Automation", icon: CalendarClock },
  assistant: { label: "Assistant", icon: Bot },
  safety: { label: "Safety", icon: ShieldAlert },
  system: { label: "System", icon: Settings2 },
};

const KIND_KEYS = ["all", ...(Object.keys(KIND_META) as ActivityKind[])] as const;

const STATUS_META: Record<ActivityStatus, { icon: LucideIcon; cls: string; label: string }> = {
  info: { icon: Info, cls: "bg-primary/12 text-primary ring-1 ring-primary/20", label: "Info" },
  success: {
    icon: CheckCircle2,
    cls: "bg-status-ok/12 text-status-ok ring-1 ring-status-ok/20",
    label: "Success",
  },
  warning: {
    icon: TriangleAlert,
    cls: "bg-warning/12 text-warning ring-1 ring-warning/20",
    label: "Warning",
  },
  blocked: {
    icon: Ban,
    cls: "bg-status-offline/12 text-status-offline ring-1 ring-status-offline/20",
    label: "Blocked",
  },
};

type Origin = "local" | "backend";
type TimelineEvent = ActivityEvent & { origin: Origin; timestamp: number };
type OriginFilter = "all" | Origin;

const ORIGIN_OPTIONS: ReadonlyArray<{ value: OriginFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "local", label: "Commands" },
  { value: "backend", label: "Backend" },
];

interface BackendEvent {
  id: number;
  kind: string;
  title: string;
  body?: string;
  at: number;
}

function asText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function parseBackendEvents(raw: unknown): BackendEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const rows = (raw as { events?: unknown })["events"];
  if (!Array.isArray(rows)) return [];
  const out: BackendEvent[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const id = Number(item["id"]);
    const at = Number(item["at"]);
    const title = asText(item["title"]).trim();
    if (!Number.isFinite(id) || !Number.isFinite(at) || !title) continue;
    const body = asText(item["body"]).trim();
    out.push({
      id,
      at,
      title,
      kind: asText(item["kind"]),
      ...(body ? { body } : {}),
    });
  }
  return out;
}

function mapKind(kind: string): ActivityKind {
  const k = kind.toLowerCase();
  if (/safety|alarm|block/.test(k)) return "safety";
  if (/scene|schedul|rule|auto|approval/.test(k)) return "automation";
  if (/assistant|chat/.test(k)) return "assistant";
  if (/device|haier|tuya|local|lan/.test(k)) return "device";
  return "system";
}

function mapStatus(text: string): ActivityStatus {
  const t = text.toLowerCase();
  if (/fail|error|block|refus|denied|reject/.test(t)) return "blocked";
  if (/warn|caution/.test(t)) return "warning";
  if (/\b(success|complete|confirm|done|ok)\b/.test(t)) return "success";
  return "info";
}

function toTimeline(event: BackendEvent): TimelineEvent | null {
  const stamp = event.at * 1000;
  const date = new Date(stamp);
  if (!isValid(date)) return null;
  const text = `${event.title} ${event.body ?? ""}`;
  return {
    id: `be-${event.id}`,
    at: date.toISOString(),
    timestamp: stamp,
    kind: mapKind(event.kind),
    source: "system",
    status: mapStatus(text),
    title: event.title,
    ...(event.body ? { detail: event.body } : {}),
    origin: "backend",
  };
}

function dayLabel(timestamp: number): string {
  const d = new Date(timestamp);
  if (!isValid(d)) return "Unknown date";
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEEE, d MMM");
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return isValid(d) ? format(d, "HH:mm") : "—";
}

function ActivityPage() {
  const { t, state, hydrated } = useSmartPilot();
  const [backendEvents, setBackendEvents] = useState<BackendEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<ActivityKind | "all">("all");
  const [origin, setOrigin] = useState<OriginFilter>("all");

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const parsed = parseBackendEvents(await getEvents(0));
      if (!mountedRef.current) return;
      setBackendEvents(parsed);
      setLastSyncedAt(Date.now());
      setError(null);
    } catch (cause) {
      if (!mountedRef.current) return;
      setError(messageOf(cause));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => void load(false), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // Step 1: Normalize & sort only when raw data changes
  const allEvents = useMemo<TimelineEvent[]>(() => {
    const local: TimelineEvent[] = [];
    for (const event of state.activity) {
      const ts = Date.parse(event.at);
      if (!Number.isFinite(ts)) continue;
      local.push({ ...event, origin: "local", timestamp: ts });
    }
    const remote: TimelineEvent[] = [];
    for (const event of backendEvents) {
      const mapped = toTimeline(event);
      if (mapped) remote.push(mapped);
    }
    return [...local, ...remote].sort((a, b) => b.timestamp - a.timestamp);
  }, [state.activity, backendEvents]);

  // Step 2: Filter cheaply on search/filter interactions
  const filteredEvents = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allEvents.filter(
      (event) =>
        (kind === "all" || event.kind === kind) &&
        (origin === "all" || event.origin === origin) &&
        (!needle || `${event.title} ${event.detail ?? ""}`.toLowerCase().includes(needle)),
    );
  }, [allEvents, q, kind, origin]);

  // Step 3: O(n) grouping by day
  const grouped = useMemo(() => {
    const map = new Map<string, TimelineEvent[]>();
    for (const event of filteredEvents) {
      const key = dayLabel(event.timestamp);
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(event);
      } else {
        map.set(key, [event]);
      }
    }
    return [...map.entries()];
  }, [filteredEvents]);

  const hasActiveFilters = Boolean(q.trim()) || kind !== "all" || origin !== "all";
  const resetFilters = () => {
    setQ("");
    setKind("all");
    setOrigin("all");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("activity_title")}
        sub="Real events from the local backend, merged with commands confirmed in this app."
        eyebrow={
          <div className="flex items-center gap-2">
            <LiveBadge />
            {lastSyncedAt && (
              <span className="text-[11px] text-muted-foreground tabular">
                Synced {formatTime(lastSyncedAt)}
              </span>
            )}
          </div>
        }
        actions={
          <Button
            variant="glass"
            size="touch"
            disabled={refreshing}
            onClick={() => void load(true)}
            aria-label="Refresh activity"
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            {refreshing ? "Syncing…" : "Refresh"}
          </Button>
        }
      />

      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-2xl border border-status-offline/25 bg-status-offline/10 px-4 py-3 text-sm text-status-offline"
        >
          <div className="flex items-center gap-2.5">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            <span>Could not load backend events: {error}</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load(true)}
            className="shrink-0 text-status-offline hover:bg-status-offline/15"
          >
            Retry
          </Button>
        </div>
      )}

      {/* Filter Bar */}
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`${t("search")} events…`}
              aria-label="Search events"
              className="glass h-11 rounded-2xl pl-10 pr-10"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ("")}
                aria-label="Clear search"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {/* Apple-style Segmented Control for Origin */}
          <div
            className="inline-flex shrink-0 items-center rounded-2xl bg-muted/60 p-1 ring-1 ring-border/50"
            role="group"
            aria-label="Filter by source"
          >
            {ORIGIN_OPTIONS.map((option) => {
              const active = origin === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setOrigin(option.value)}
                  className={cn(
                    "min-h-11 rounded-xl px-3.5 text-xs font-medium transition-all",
                    active
                      ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Category Chips */}
        <div
          className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 scrollbar-none sm:mx-0 sm:flex-wrap sm:px-0"
          role="group"
          aria-label="Filter by type"
        >
          {KIND_KEYS.map((key) => {
            const active = kind === key;
            const Icon = key === "all" ? null : KIND_META[key].icon;
            return (
              <Button
                key={key}
                variant="chip"
                size="touch"
                aria-pressed={active}
                onClick={() => setKind(key)}
                className={cn(
                  "h-11 shrink-0 rounded-full px-3.5 text-xs transition-all",
                  active && "border-primary/50 bg-primary/12 text-primary shadow-xs",
                )}
              >
                {Icon && <Icon className="size-3.5 opacity-80" aria-hidden />}
                {key === "all" ? t("all") : KIND_META[key].label}
              </Button>
            );
          })}
        </div>
      </div>

      {/* Timeline Content */}
      {!hydrated || loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading activity">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[4.5rem] rounded-3xl" />
          ))}
        </div>
      ) : grouped.length === 0 ? (
        <div className="space-y-4">
          <EmptyState
            icon={hasActiveFilters ? SearchX : History}
            title={hasActiveFilters ? t("noResults") : "No events yet"}
            body={
              hasActiveFilters
                ? "Try adjusting your search or clearing active filters."
                : "Real backend events and confirmed commands appear here as soon as they are recorded."
            }
          />
          {hasActiveFilters && (
            <div className="flex justify-center">
              <Button variant="glass" size="touch" onClick={resetFilters}>
                Reset filters
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-7" aria-live="polite">
          {grouped.map(([day, list]) => (
            <section key={day} aria-label={day}>
              <div className="mb-2.5 flex items-baseline justify-between px-1">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {day}
                </h2>
                <span className="text-[11px] text-muted-foreground/75 tabular">
                  {list.length} {list.length === 1 ? "event" : "events"}
                </span>
              </div>

              <Panel pad="sm" className="overflow-hidden">
                <ol className="divide-y divide-border/50">
                  {list.map((event) => {
                    const status = STATUS_META[event.status];
                    const kindMeta = KIND_META[event.kind];
                    return (
                      <li
                        key={event.id}
                        className="group flex items-start gap-3.5 rounded-2xl px-2.5 py-3 transition-colors hover:bg-accent/40"
                      >
                        <span
                          className={cn(
                            "mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl transition-transform group-hover:scale-[1.03]",
                            status.cls,
                          )}
                          title={status.label}
                        >
                          <status.icon className="size-4" aria-hidden />
                          <span className="sr-only">{status.label}</span>
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <p className="text-sm font-medium leading-snug text-foreground">
                              {event.title}
                            </p>
                            <time
                              dateTime={event.at}
                              className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular"
                            >
                              {formatTime(event.timestamp)}
                            </time>
                          </div>

                          {event.detail && (
                            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                              {event.detail}
                            </p>
                          )}

                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="h-5 gap-1 px-2 text-[11px] font-normal">
                              <kindMeta.icon className="size-3 opacity-75" aria-hidden />
                              {kindMeta.label}
                            </Badge>
                            <span className="text-[11px] text-muted-foreground/80">
                              {event.origin === "backend" ? "Backend" : "Command"}
                            </span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Panel>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
