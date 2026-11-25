import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  CalendarClock,
  Clock,
  Cpu,
  Eye,
  EyeOff,
  History,
  Leaf,
  Network,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Thermometer,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AcSummaryCard } from "@/components/sp/AcControl";
import { ConnectionPill, DeviceGlyph, Panel, PanelTitle } from "@/components/sp/primitives";
import {
  getEvents,
  getLocalDevices,
  getPreferences,
  getScenes,
  getUsage,
  messageOf,
  runScene,
  type LocalPreferences,
} from "@/lib/smartpilot/backend-api";
import { AC_DEVICES, DEVICES, getDevice } from "@/lib/smartpilot/devices";
import { useSmartPilot } from "@/lib/smartpilot/store";
import { useNow } from "@/hooks/use-now";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overview — Smart Pilot Titanium Control" },
      {
        name: "description",
        content:
          "Home dashboard for your Haier ACs and Smart Life devices. Preview-only prototype.",
      },
      { property: "og:title", content: "Overview — Smart Pilot Titanium Control" },
      {
        property: "og:description",
        content: "Overview of verified local status and quick controls for your devices.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Overview,
});

type TileId =
  | "usage"
  | "scenes"
  | "ac-cards"
  | "device-groups"
  | "safe-actions"
  | "freshness"
  | "activity"
  | "quick-nav";

interface HomeTile {
  id: TileId;
  label: string;
  visible: boolean;
  favorite: boolean;
}

interface UsageResponse {
  today?: string;
  total_kwh?: number;
  devices?: Array<{ id: string; kwh: number }>;
  ac?: unknown;
}

interface SceneRow {
  id: string;
  name: string;
}

interface BackendEvent {
  id: number;
  kind: string;
  title: string;
  at: number;
  body?: string;
}

const HOME_LAYOUT_KEY = "smartpilot:home-layout";
const DEFAULT_TILES: HomeTile[] = [
  { id: "usage", label: "Live readings", visible: true, favorite: false },
  { id: "scenes", label: "Quick scenes", visible: true, favorite: false },
  { id: "ac-cards", label: "AC cards", visible: true, favorite: true },
  { id: "device-groups", label: "Device groups", visible: true, favorite: false },
  { id: "safe-actions", label: "Suggested actions", visible: true, favorite: false },
  { id: "freshness", label: "Data freshness", visible: true, favorite: false },
  { id: "activity", label: "Recent events", visible: true, favorite: false },
  { id: "quick-nav", label: "Quick access", visible: true, favorite: false },
];

function asText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function kwhLabel(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(3)} kWh` : "—";
}

function parseScenes(raw: unknown): SceneRow[] {
  if (!raw || typeof raw !== "object") return [];
  const rows = (raw as { scenes?: unknown })["scenes"];
  if (!Array.isArray(rows)) return [];
  const out: SceneRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const id = asText(item["id"]);
    const name = asText(item["name"]);
    if (id && name) out.push({ id, name });
  }
  return out;
}

function parseEvents(raw: unknown): BackendEvent[] {
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

/**
 * Home tile layout is local UI state only. It is kept in localStorage so it
 * cannot overwrite the backend `homes`/`rooms`/`favorites` fields used by the
 * Devices screen for device organization.
 */
function applyPreferences(base: HomeTile[], prefs: LocalPreferences): HomeTile[] {
  const favorites = new Set(Array.isArray(prefs.favorites) ? prefs.favorites : []);
  const rooms =
    prefs.rooms && typeof prefs.rooms === "object" ? prefs.rooms : ({} as Record<string, string>);
  const homes = Array.isArray(prefs.homes) ? prefs.homes : [];
  const byId = new Map<string, HomeTile>(base.map((tile) => [tile.id, { ...tile }]));
  const ordered: HomeTile[] = [];
  const decorate = (tile: HomeTile): HomeTile => ({
    ...tile,
    favorite: favorites.has(tile.id),
    visible: rooms[tile.id] !== "hidden",
  });
  for (const home of homes) {
    const tile = byId.get(home.id);
    if (!tile) continue;
    byId.delete(home.id);
    ordered.push(decorate(tile));
  }
  for (const tile of byId.values()) ordered.push(decorate(tile));
  return ordered;
}

function Overview() {
  const { t, state, devices, connection, refreshDevices } = useSmartPilot();
  const now = useNow(60_000);
  const hour = now ? new Date(now).getHours() : 12;
  const greet =
    hour < 12 ? t("greeting_morning") : hour < 17 ? t("greeting_afternoon") : t("greeting_evening");
  const connected = devices.filter((d) => d.connection === "online").length;
  const pending = state.approvals.filter((a) => a.status === "pending").length;
  const groups = [
    { name: "Porch", devices: devices.filter((d) => d.location === "Porch") },
    { name: "Terrace", devices: devices.filter((d) => d.location === "Terrace") },
    { name: t("room_not_set"), devices: devices.filter((d) => d.location === null) },
  ];
  const backendLabel =
    connection.state === "live"
      ? "Local backend verified"
      : connection.state === "refreshing"
        ? "Checking local backend"
        : "Local backend unavailable";

  // --- Home customization (local state + saved preferences) ----------------
  const [tiles, setTiles] = useState<HomeTile[]>(DEFAULT_TILES);
  const [draft, setDraft] = useState<HomeTile[]>(DEFAULT_TILES);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // --- Real backend reads --------------------------------------------------
  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [scenesError, setScenesError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [backendNames, setBackendNames] = useState<Record<string, string>>({});
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [events, setEvents] = useState<BackendEvent[]>([]);
  const [confirmScene, setConfirmScene] = useState<SceneRow | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [runningSceneId, setRunningSceneId] = useState<string | null>(null);

  const loadScenes = useCallback(async () => {
    try {
      setScenes(parseScenes(await getScenes()));
      setScenesError(null);
    } catch (error) {
      setScenesError(messageOf(error));
    }
  }, []);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      setUsage((await getUsage()) as unknown as UsageResponse);
      setUsageError(null);
    } catch (error) {
      setUsageError(messageOf(error));
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      setEvents(parseEvents(await getEvents(0)));
    } catch {
      // Recent events are optional here; the Activity screen reports errors.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    try {
      const saved = window.localStorage.getItem(HOME_LAYOUT_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as HomeTile[];
        if (Array.isArray(parsed) && parsed.length === DEFAULT_TILES.length) {
          setTiles(parsed);
          return;
        }
      }
    } catch {
      // Corrupt local state must never break the dashboard.
    }
    void getPreferences()
      .then((prefs) => {
        if (alive) setTiles(applyPreferences(DEFAULT_TILES, prefs));
      })
      .catch(() => {
        // Keep the default layout when preferences are unavailable.
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void loadScenes();
    void loadUsage();
    void loadEvents();
    void getLocalDevices()
      .then((reply) => {
        const map: Record<string, string> = {};
        for (const row of reply.devices ?? []) map[row.id] = row.name;
        setBackendNames(map);
      })
      .catch(() => { /* names are cosmetic; keep the raw id as fallback */ });
  }, [loadScenes, loadUsage, loadEvents]);

  useEffect(() => {
    if (!customizeOpen) return;
    setDraft(tiles.map((tile) => ({ ...tile })));
    setPrefsError(null);
  }, [customizeOpen, tiles]);

  const persistLayout = useCallback(async (next: HomeTile[]) => {
    setSaving(true);
    setPrefsError(null);
    try {
      window.localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify(next));
      setTiles(next.map((tile) => ({ ...tile })));
      setCustomizeOpen(false);
      toast("Home layout saved on this device");
    } catch (error) {
      setPrefsError(messageOf(error));
    } finally {
      setSaving(false);
    }
  }, []);

  const moveDraft = (index: number, delta: number) => {
    setDraft((current) => {
      const next = current.map((tile) => ({ ...tile }));
      const target = index + delta;
      if (target < 0 || target >= next.length) return next;
      const from = next[index];
      const to = next[target];
      if (!from || !to) return next;
      next[index] = to;
      next[target] = from;
      return next;
    });
  };

  const toggleDraft = (index: number, field: "visible" | "favorite") => {
    setDraft((current) =>
      current.map((tile, i) => (i === index ? { ...tile, [field]: !tile[field] } : tile)),
    );
  };

  const runConfirmedScene = async () => {
    const scene = confirmScene;
    if (!scene) return;
    setRunningSceneId(scene.id);
    setSceneError(null);
    try {
      await runScene(scene.id);
      toast(`Scene “${scene.name}” ran`, {
        description: "Real commands were sent by the local backend. Refreshing verified status.",
      });
      setConfirmScene(null);
      await Promise.allSettled([loadScenes(), loadUsage(), loadEvents(), refreshDevices()]);
    } catch (error) {
      const message = messageOf(error);
      setSceneError(message);
      toast.error(`Could not run “${scene.name}”`, { description: message });
    } finally {
      setRunningSceneId(null);
    }
  };

  const visibleTiles = tiles.filter((tile) => tile.visible);
  const favoriteTiles = visibleTiles.filter((tile) => tile.favorite);

  const renderTile = (tile: HomeTile) => {
    switch (tile.id) {
      case "usage":
        return (
          <Panel>
            <PanelTitle
              icon={Zap}
              action={
                <Button variant="ghost" size="sm" onClick={() => void loadUsage()}>
                  <RefreshCw /> Refresh
                </Button>
              }
            >
              Live readings · {usage?.today ?? "today"}
            </PanelTitle>
            {usageLoading ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading verified readings…
              </p>
            ) : usageError ? (
              <p role="alert" className="text-sm text-status-offline">
                Could not load usage: {usageError}
              </p>
            ) : usage && (usage.devices?.length ?? 0) > 0 ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                <Reading label="Total today" value={kwhLabel(usage.total_kwh)} />
                {usage.devices?.map((device) => (
                  <Reading
                    key={device.id}
                    label={backendNames[device.id] ?? getDevice(device.id)?.name ?? device.id}
                    value={kwhLabel(device.kwh)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No verified energy readings recorded today. Real values appear after the local
                backend samples a power reading.
              </p>
            )}
          </Panel>
        );
      case "scenes":
        return (
          <Panel>
            <PanelTitle
              icon={Play}
              action={
                <Button asChild variant="ghost" size="sm">
                  <Link to="/automations">
                    {t("viewAll")} <ArrowRight />
                  </Link>
                </Button>
              }
            >
              Quick scenes
            </PanelTitle>
            {scenesError ? (
              <p role="alert" className="text-sm text-status-offline">
                Could not load scenes: {scenesError}
              </p>
            ) : scenes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No scenes saved on this device yet. Create one on the Automations screen.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {scenes.map((scene) => (
                  <Button
                    key={scene.id}
                    variant="chip"
                    size="touch"
                    disabled={runningSceneId !== null}
                    onClick={() => {
                      setSceneError(null);
                      setConfirmScene(scene);
                    }}
                  >
                    <Play /> {scene.name}
                  </Button>
                ))}
              </div>
            )}
          </Panel>
        );
      case "ac-cards":
        return (
          <div className="grid gap-4 md:grid-cols-2">
            {AC_DEVICES.map((d) => (
              <AcSummaryCard key={d.id} device={d} />
            ))}
          </div>
        );
      case "device-groups":
        return (
          <Panel>
            <PanelTitle
              icon={Cpu}
              action={
                <Button asChild variant="ghost" size="sm">
                  <Link to="/devices">
                    {t("viewAll")} <ArrowRight />
                  </Link>
                </Button>
              }
            >
              {t("device_groups")}
            </PanelTitle>
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.name}>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {g.name} · {g.devices.length}
                  </p>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {g.devices.map((d) => (
                      <li
                        key={d.id}
                        className="flex items-center gap-3 rounded-2xl border border-glass-border bg-muted/30 p-2.5"
                      >
                        <DeviceGlyph device={d} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.name}</span>
                        <ConnectionPill status={d.connection} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Panel>
        );
      case "safe-actions":
        return (
          <Panel>
            <PanelTitle icon={Leaf}>{t("safe_actions")}</PanelTitle>
            <ul className="space-y-2">
              <SafeAction
                to="/climate"
                title="Review Manual/Auto for both ACs"
                body="Manual is never overridden by Auto-Pilot."
              />
              <SafeAction
                to="/automations"
                title={`Review ${pending} approval request${pending === 1 ? "" : "s"}`}
                body="High-risk loads always wait for you."
              />
              <SafeAction
                to="/settings"
                title="Review local backend status"
                body="See integration status and the adapter contract."
              />
            </ul>
          </Panel>
        );
      case "freshness":
        return (
          <Panel>
            <PanelTitle icon={Clock}>{t("freshness")}</PanelTitle>
            <ul className="space-y-2 text-sm">
              {devices.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{d.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      className={
                        "size-1.5 rounded-full " +
                        (d.connection === "online" ? "bg-status-ok" : "bg-status-unknown")
                      }
                      aria-hidden
                    />
                    {d.lastSeen.known
                      ? new Date(d.lastSeen.value).toLocaleTimeString()
                      : t("status_unknown")}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              {connection.message}. Last checked:{" "}
              {connection.refreshedAt ? new Date(connection.refreshedAt).toLocaleTimeString() : "—"}.
            </p>
          </Panel>
        );
      case "activity":
        return (
          <Panel>
            <PanelTitle
              icon={History}
              action={
                <Button asChild variant="ghost" size="sm">
                  <Link to="/activity">
                    {t("viewAll")} <ArrowRight />
                  </Link>
                </Button>
              }
            >
              Recent events
            </PanelTitle>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No events recorded by the local backend yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {events.slice(0, 4).map((event) => (
                  <li
                    key={event.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-glass-border bg-muted/30 p-3"
                  >
                    <span className="min-w-0 truncate text-sm">{event.title}</span>
                    <time
                      dateTime={new Date(event.at * 1000).toISOString()}
                      className="shrink-0 text-xs text-muted-foreground"
                    >
                      {new Date(event.at * 1000).toLocaleTimeString()}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        );
      case "quick-nav":
        return (
          <nav aria-label={t("quick_nav")}>
            <h2 className="mb-3 text-base font-semibold">{t("quick_nav")}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  { to: "/automations", icon: CalendarClock, label: t("nav_automations") },
                  { to: "/energy", icon: Zap, label: t("nav_energy") },
                  { to: "/activity", icon: Activity, label: t("nav_activity") },
                  { to: "/devices", icon: Cpu, label: t("nav_devices") },
                ] as const
              ).map((q) => (
                <Link
                  key={q.to}
                  to={q.to}
                  className="glass group flex h-24 flex-col justify-between rounded-3xl p-4 transition-colors hover:border-primary/40"
                >
                  <q.icon className="size-5 text-primary" aria-hidden />
                  <span className="flex items-center justify-between text-sm font-medium">
                    {q.label}{" "}
                    <ArrowRight
                      className="size-4 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden
                    />
                  </span>
                </Link>
              ))}
            </div>
          </nav>
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      <Panel variant="hero" className="relative overflow-hidden animate-rise">
        <div className="relative z-10 grid gap-6 lg:grid-cols-[1.4fr_1fr] lg:items-center">
          <div>
            <p className="text-sm text-muted-foreground">{greet}</p>
            <h1 className="mt-1 text-3xl font-semibold sm:text-4xl">
              <span className="text-gradient">Titanium Control</span>
            </h1>
            <div className="mt-4 rounded-2xl border border-glass-border bg-background/40 p-4">
              <p className="mb-1 flex flex-wrap items-center gap-2 text-sm font-semibold">
                <Sparkles className="size-4 text-primary" aria-hidden /> {t("overview_summary_title")}
                <Badge variant="info">Live local</Badge>
              </p>
              <p className="text-sm text-muted-foreground">
                Verified local reads. Critical devices need approval before any command.
              </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button asChild variant="hero" size="touch">
                <Link to="/assistant">
                  <Bot /> Ask Smart Pilot
                </Link>
              </Button>
              <Button asChild variant="glass" size="touch">
                <Link to="/climate">
                  <Thermometer /> {t("nav_climate")}
                </Link>
              </Button>
              <Button
                variant="glass"
                size="touch"
                disabled={connection.state === "refreshing"}
                onClick={() => void refreshDevices()}
              >
                <Activity /> Refresh status
              </Button>
              <Dialog open={customizeOpen} onOpenChange={setCustomizeOpen}>
                <DialogTrigger asChild>
                  <Button variant="glass" size="touch">
                    <SlidersHorizontal /> Customize
                  </Button>
                </DialogTrigger>
                <DialogContent className="glass max-h-[85vh] overflow-y-auto sm:max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Customize Home</DialogTitle>
                    <DialogDescription>
                      Reorder sections, hide the ones you do not need, and mark favorites. Favorites
                      get a shortcut at the top of Home. Saved on this device.
                    </DialogDescription>
                  </DialogHeader>
                  <ul className="space-y-2">
                    {draft.map((tile, index) => (
                      <li
                        key={tile.id}
                        className="flex flex-wrap items-center gap-2 rounded-2xl border border-glass-border bg-muted/30 p-2"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {tile.label}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-touch"
                          aria-label={`Move ${tile.label} up`}
                          disabled={index === 0}
                          onClick={() => moveDraft(index, -1)}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-touch"
                          aria-label={`Move ${tile.label} down`}
                          disabled={index === draft.length - 1}
                          onClick={() => moveDraft(index, 1)}
                        >
                          <ArrowDown />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-touch"
                          aria-label={`${tile.visible ? "Hide" : "Show"} ${tile.label}`}
                          aria-pressed={!tile.visible}
                          onClick={() => toggleDraft(index, "visible")}
                        >
                          {tile.visible ? <EyeOff /> : <Eye />}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-touch"
                          aria-label={`${tile.favorite ? "Remove" : "Add"} ${tile.label} favorite`}
                          aria-pressed={tile.favorite}
                          onClick={() => toggleDraft(index, "favorite")}
                        >
                          <Star className={tile.favorite ? "fill-warning text-warning" : ""} />
                        </Button>
                      </li>
                    ))}
                  </ul>
                  {prefsError && (
                    <p role="alert" className="text-xs text-status-offline">
                      Could not save layout: {prefsError}
                    </p>
                  )}
                  <DialogFooter className="flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="touch"
                      disabled={saving}
                      onClick={() => {
                        setDraft(DEFAULT_TILES.map((tile) => ({ ...tile })));
                      }}
                    >
                      <RotateCcw /> Reset
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="touch"
                      disabled={saving}
                      onClick={() => setCustomizeOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="hero"
                      size="touch"
                      disabled={saving}
                      onClick={() => void persistLayout(draft)}
                    >
                      {saving ? "Saving…" : "Save layout"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <HealthTile
              icon={Plug}
              label={t("connection_health")}
              value={t("connected_count", { n: connected, total: devices.length })}
              tone={connection.state === "live" ? "ok" : "unknown"}
            />
            <HealthTile
              icon={Network}
              label="Backend"
              value={backendLabel}
              tone={connection.state === "live" ? "ok" : "unknown"}
            />
            <HealthTile
              icon={ShieldCheck}
              label="Safety"
              value="Approval-gated writes"
              tone="ok"
            />
            <HealthTile
              icon={CalendarClock}
              label="Approvals"
              value={`${pending} pending`}
              tone={pending ? "preview" : "ok"}
            />
          </div>
        </div>
      </Panel>

      {favoriteTiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Favorite sections">
          <Star className="size-4 fill-warning text-warning" aria-hidden />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Favorites
          </span>
          {favoriteTiles.map((tile) => (
            <Button
              key={tile.id}
              variant="chip"
              size="touch"
              onClick={() =>
                document.getElementById(`tile-${tile.id}`)?.scrollIntoView({ block: "start" })
              }
            >
              {tile.label}
            </Button>
          ))}
        </div>
      )}

      {visibleTiles.length === 0 ? (
        <Panel>
          <PanelTitle icon={SlidersHorizontal}>Home layout</PanelTitle>
          <p className="text-sm text-muted-foreground">
            All sections are hidden. Use Customize above to show them again.
          </p>
        </Panel>
      ) : (
        <div className="space-y-6">
          {visibleTiles.map((tile) => (
            <div key={tile.id} id={`tile-${tile.id}`} className="scroll-mt-4">
              {renderTile(tile)}
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={confirmScene !== null}
        onOpenChange={(open) => {
          if (!open && runningSceneId === null) setConfirmScene(null);
        }}
      >
        <DialogContent className="glass sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Run “{confirmScene?.name ?? "scene"}”?</DialogTitle>
            <DialogDescription>
              This sends real ON/OFF and setting commands to your physical devices through the local
              backend. It cannot be undone from this screen. Only run it if you are present and it
              is safe to do so.
            </DialogDescription>
          </DialogHeader>
          {sceneError && (
            <p role="alert" className="text-sm text-status-offline">
              Could not run scene: {sceneError}
            </p>
          )}
          <DialogFooter className="flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              size="touch"
              disabled={runningSceneId !== null}
              onClick={() => setConfirmScene(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="warning"
              size="touch"
              disabled={runningSceneId !== null}
              onClick={() => void runConfirmedScene()}
            >
              <Play /> {runningSceneId === null ? "Run scene · send commands" : "Sending…"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Reading({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-glass-border bg-background/40 p-3">
      <p className="min-w-0 truncate text-xs text-muted-foreground" title={label}>
        {label}
      </p>
      <p className="mt-1 font-display text-lg font-semibold tabular">{value}</p>
    </div>
  );
}

function HealthTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Plug;
  label: string;
  value: string;
  tone: "ok" | "unknown" | "preview";
}) {
  const toneCls =
    tone === "ok"
      ? "text-status-ok"
      : tone === "preview"
        ? "text-status-preview"
        : "text-status-unknown";
  return (
    <div className="rounded-2xl border border-glass-border bg-background/40 p-3">
      <Icon className={`size-4 ${toneCls}`} aria-hidden />
      <p className="mt-2 text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold leading-snug">{value}</p>
    </div>
  );
}

function SafeAction({
  to,
  title,
  body,
}: {
  to: "/climate" | "/automations" | "/settings";
  title: string;
  body: string;
}) {
  return (
    <li>
      <Link
        to={to}
        className="flex items-center gap-3 rounded-2xl border border-glass-border bg-muted/30 p-3 transition-colors hover:border-primary/40"
      >
        <ShieldCheck className="size-4 shrink-0 text-emerald" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{body}</span>
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  );
}
