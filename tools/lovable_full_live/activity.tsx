import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { format, isToday, isYesterday } from "date-fns";
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

const STATUS_META: Record<ActivityStatus, { icon: LucideIcon; cls: string; label: string }> = {
  info: { icon: Info, cls: "bg-primary/14 text-primary", label: "Info" },
  success: { icon: CheckCircle2, cls: "bg-status-ok/14 text-status-ok", label: "Success" },
  warning: {
    icon: TriangleAlert,
    cls: "bg-warning/14 text-warning",
    label: "Warning",
  },
  blocked: { icon: Ban, cls: "bg-status-offline/14 text-status-offline", label: "Blocked" },
};

type Origin = "local" | "backend";
type TimelineEvent = ActivityEvent & { origin: Origin };
type OriginFilter = "all" | Origin;

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
    const title = asText(item["title"]);
    if (!Number.isFinite(id) || !Number.isFinite(at) || !title) continue;
    const body = asText(item["body"]);
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
  if (/success|complete|confirm|done|ok/.test(t)) return "success";
  return "info";
}

function toTimeline(event: BackendEvent): TimelineEvent | null {
  const stamp = event.at * 1000;
  if (!Number.isFinite(stamp)) return null;
  const text = `${event.title} ${event.body ?? ""}`;
  const detail = event.body;
  return {
    id: `be-${event.id}`,
    at: new Date(stamp).toISOString(),
    kind: mapKind(event.kind),
    source: "system",
    status: mapStatus(text),
    title: event.title,
    ...(detail ? { detail } : {}),
    origin: "backend",
  };
}

function dayLabel(d: Date) {
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEE, d MMM");
}

function ActivityPage() {
  const { t, state, hydrated } = useSmartPilot();
  const [backendEvents, setBackendEvents] = useState<BackendEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<ActivityKind | "all">("all");
  const [origin, setOrigin] = useState<OriginFilter>("all");

  const load = useCallback(async () => {
    try {
      setBackendEvents(parseBackendEvents(await getEvents(0)));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const events = useMemo(() => {
    const local: TimelineEvent[] = state.activity.map((event) => ({ ...event, origin: "local" }));
    const remote: TimelineEvent[] = backendEvents.flatMap((event) => {
      const mapped = toTimeline(event);
      return mapped ? [mapped] : [];
    });
    const all = [...local, ...remote].sort((a, b) => b.at.localeCompare(a.at));
    const needle = q.trim().toLowerCase();
    return all.filter(
      (event) =>
        (kind === "all" || event.kind === kind) &&
        (origin === "all" || event.origin === origin) &&
        (!needle || `${event.title} ${event.detail ?? ""}`.toLowerCase().includes(needle)),
    );
  }, [state.activity, backendEvents, q, kind, origin]);

  const grouped = useMemo(() => {
    const map = new Map<string, TimelineEvent[]>();
    for (const event of events) {
      const key = dayLabel(new Date(event.at));
      map.set(key, [...(map.get(key) ?? []), event]);
    }
    return [...map.entries()];
  }, [events]);

  return (
    <div>
      <PageHeader
        title={t("activity_title")}
        sub="Real events from the local backend, merged with commands confirmed in this app."
        eyebrow={<LiveBadge />}
        actions={
          <Button variant="glass" size="touch" onClick={() => void load()}>
            <RefreshCw /> Refresh
          </Button>
        }
      />
      {error && (
        <p role="alert" className="mb-4 text-sm text-status-offline">
          Could not load backend events: {error}
        </p>
      )}
      <div className="mb-6 space-y-3">
        <div className="relative">
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
            className="glass h-12 rounded-2xl pl-10"
          />
        </div>
        <div
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:mx-0 sm:flex-wrap sm:px-0"
          role="group"
          aria-label="Filter by type"
        >
          {(["all", ...Object.keys(KIND_META)] as (ActivityKind | "all")[]).map((key) => (
            <Button
              key={key}
              variant="chip"
              size="touch"
              aria-pressed={kind === key}
              onClick={() => setKind(key)}
              className={cn(
                "shrink-0",
                kind === key && "border-primary/60 bg-primary/15 text-primary",
              )}
            >
              {key === "all" ? t("all") : KIND_META[key].label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by source">
          {(
            [
              { value: "all", label: "All sources" },
              { value: "local", label: "Command log" },
              { value: "backend", label: "Backend events" },
            ] as Array<{ value: OriginFilter; label: string }>
          ).map((option) => (
            <Button
              key={option.value}
              variant="ghost"
              size="touch"
              aria-pressed={origin === option.value}
              onClick={() => setOrigin(option.value)}
              className={cn(origin === option.value && "bg-accent text-accent-foreground")}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {!hydrated || loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading activity">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 rounded-3xl" />
          ))}
        </div>
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={q || kind !== "all" || origin !== "all" ? SearchX : History}
          title={q || kind !== "all" || origin !== "all" ? t("noResults") : "No events yet"}
          body="Real backend events and confirmed commands appear here as soon as they are recorded."
        />
      ) : (
        <div className="space-y-8">
          {grouped.map(([day, list]) => (
            <section key={day} aria-label={day}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {day}
              </h2>
              <Panel pad="sm">
                <ol className="relative space-y-1">
                  {list.map((event, i) => {
                    const status = STATUS_META[event.status];
                    const kindMeta = KIND_META[event.kind];
                    return (
                      <li key={event.id} className="relative flex gap-3 rounded-2xl p-2">
                        {i < list.length - 1 && (
                          <span
                            className="absolute bottom-[-0.25rem] left-[1.6rem] top-12 w-px bg-border"
                            aria-hidden
                          />
                        )}
                        <span
                          className={cn(
                            "relative grid size-9 shrink-0 place-items-center rounded-xl",
                            status.cls,
                          )}
                          title={status.label}
                        >
                          <status.icon className="size-4" aria-hidden />
                          <span className="sr-only">{status.label}</span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium leading-snug">{event.title}</p>
                          {event.detail && (
                            <p className="text-xs text-muted-foreground">{event.detail}</p>
                          )}
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline">
                              <kindMeta.icon className="size-3" aria-hidden /> {kindMeta.label}
                            </Badge>
                            <LiveBadge />
                            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              {event.origin === "backend" ? "Backend event" : "Command log"}
                            </span>
                            <time
                              dateTime={event.at}
                              className="text-[11px] text-muted-foreground tabular"
                            >
                              {format(new Date(event.at), "HH:mm")}
                            </time>
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
