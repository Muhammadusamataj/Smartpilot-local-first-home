// Live automations route backed by the EXISTING Flask endpoints.
// Nothing here invents device data: scenes, DPs, rules, events and usage all
// come from the local backend. Every write is gated by an explicit user action
// and every operator action (run / tick) is confirmed in a dialog first.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  Check,
  Clock,
  Inbox,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EmptyState,
  LiveBadge,
  PageHeader,
  Panel,
  PanelTitle,
  Stat,
} from "@/components/sp/primitives";
import { DAY_SHORT, describeDays } from "@/lib/smartpilot/describe";
import { useSmartPilot } from "@/lib/smartpilot/store";
import {
  createRule,
  createScene,
  deleteRule,
  deleteScene,
  getEvents,
  getRules,
  getScheduler,
  getScenes,
  getUsage,
  messageOf,
  runScene,
  tickScheduler,
  type SceneInput,
} from "@/lib/smartpilot/backend-api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/automations")({
  head: () => ({
    meta: [
      { title: "Automations — Smart Pilot Titanium Control" },
      {
        name: "description",
        content:
          "Scenes, schedules, safety rules and activity from the local Smart Pilot backend.",
      },
      { property: "og:title", content: "Automations — Smart Pilot Titanium Control" },
      {
        property: "og:description",
        content: "Run local scenes and schedules with explicit confirmation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AutomationsPage,
});

// --- Narrowing helpers: backend payloads are plain JSON ---------------------
// Explicit optional keys keep dot access valid under the pinned tsconfig's
// `noPropertyAccessFromIndexSignature` without weakening strict mode.
interface JsonRecord {
  id?: unknown;
  name?: unknown;
  icon?: unknown;
  actions?: unknown;
  schedule?: unknown;
  device_id?: unknown;
  dp?: unknown;
  value?: unknown;
  enabled?: unknown;
  time?: unknown;
  days?: unknown;
  last_run?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  active?: unknown;
  scenes?: unknown;
  scheduled?: unknown;
  next_run_at?: unknown;
  next_run?: unknown;
  next_scene?: unknown;
  note?: unknown;
  kind?: unknown;
  minutes?: unknown;
  action?: unknown;
  at?: unknown;
  title?: unknown;
  body?: unknown;
  today?: unknown;
  total_kwh?: unknown;
  devices?: unknown;
  kwh?: unknown;
  ac?: unknown;
  verified?: unknown;
  lan_known?: unknown;
  last_read?: unknown;
  power_on?: unknown;
  target_c?: unknown;
  mode?: unknown;
  points?: unknown;
  code?: unknown;
  type?: unknown;
  options?: unknown;
  min?: unknown;
  max?: unknown;
  step?: unknown;
  ok?: unknown;
  error?: unknown;
  succeeded?: unknown;
  failed?: unknown;
  results?: unknown;
  ran?: unknown;
  events?: unknown;
  rules?: unknown;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function formatRunTime(value: string): string {
  if (!value || value === "0") return "never";
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "never";
  return new Date(seconds * 1000).toLocaleString();
}
function asBool(value: unknown): boolean {
  return value === true;
}
function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function asStringArray(value: unknown): string[] {
  return asArray(value).map(asText).filter(Boolean);
}
function asDays(value: unknown): number[] {
  return asArray(value)
    .filter(
      (item): item is number =>
        typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 6,
    )
    .map((item) => item)
    .sort((a, b) => a - b);
}
function formatValue(value: unknown): string {
  if (value === true) return "On";
  if (value === false) return "Off";
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}
function formatAt(value: unknown): string {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "Unknown";
  return new Date(seconds * 1000).toLocaleString();
}

// --- Backend shapes ---------------------------------------------------------
interface SceneActionView {
  device_id: string;
  dp: string;
  value: unknown;
}
interface SceneView {
  id: string;
  name: string;
  icon: string;
  actions: SceneActionView[];
  schedule: { enabled: boolean; time: string; days: number[] };
  last_run: string;
}
interface SchedulerView {
  active: boolean;
  scenes: number;
  scheduled: number;
  next_run_at: number | null;
  next_run: string | null;
  next_scene: string | null;
  note: string;
}
interface RuleView {
  id: string;
  name: string;
  kind: "on_duration" | "off_duration";
  device_id: string;
  dp: string;
  minutes: number;
  action: boolean;
  enabled: boolean;
}
interface EventView {
  id: number;
  kind: string;
  title: string;
  body: string;
  at: number;
}
interface AcUsageRow {
  id: string;
  name: string;
  verified: boolean;
  last_read: number;
  power_on: boolean | null;
  target_c: number | null;
  mode: string | null;
}
interface UsageView {
  today: string;
  total_kwh: number;
  devices: Array<{ id: string; kwh: number }>;
  ac: AcUsageRow[];
}
interface DevicePoint {
  dp: string;
  code: string;
  type: string;
  value?: unknown;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}
interface DeviceOption {
  id: string;
  name: string;
  verified: boolean;
  lanKnown: boolean;
  points: DevicePoint[];
}

function parseScene(value: unknown): SceneView | null {
  const row = asRecord(value);
  const id = asText(row.id);
  const name = asText(row.name);
  if (!id || !name) return null;
  const actions = asArray(row.actions)
    .map((item) => {
      const action = asRecord(item);
      return {
        device_id: asText(action.device_id),
        dp: asText(action.dp),
        value: action.value,
      };
    })
    .filter((action) => action.device_id && action.dp);
  const schedule = asRecord(row.schedule);
  return {
    id,
    name,
    icon: asText(row.icon),
    actions,
    schedule: {
      enabled: asBool(schedule.enabled),
      time: asText(schedule.time),
      days: asDays(schedule.days),
    },
    last_run: asText(row.last_run),
  };
}

function parseScheduler(value: unknown): SchedulerView {
  const row = asRecord(value);
  return {
    active: asBool(row.active),
    scenes: asNumber(row.scenes),
    scheduled: asNumber(row.scheduled),
    next_run_at: typeof row.next_run_at === "number" ? row.next_run_at : null,
    next_run: asText(row.next_run) || null,
    next_scene: asText(row.next_scene) || null,
    note: asText(row.note),
  };
}

function parseRule(value: unknown): RuleView | null {
  const row = asRecord(value);
  const id = asText(row.id);
  const name = asText(row.name);
  if (!id || !name) return null;
  const kind = asText(row.kind) === "off_duration" ? "off_duration" : "on_duration";
  return {
    id,
    name,
    kind,
    device_id: asText(row.device_id),
    dp: asText(row.dp),
    minutes: asNumber(row.minutes),
    action: asBool(row.action),
    enabled: asBool(row.enabled),
  };
}

function parseEvent(value: unknown): EventView | null {
  const row = asRecord(value);
  const id = Number(row.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    kind: asText(row.kind),
    title: asText(row.title),
    body: asText(row.body),
    at: Number(row.at) || 0,
  };
}

function parseUsage(value: unknown): UsageView {
  const row = asRecord(value);
  return {
    today: asText(row.today),
    total_kwh: asNumber(row.total_kwh),
    devices: asArray(row.devices)
      .map((item) => {
        const device = asRecord(item);
        return { id: asText(device.id), kwh: asNumber(device.kwh) };
      })
      .filter((device) => device.id),
    ac: asArray(row.ac).map((item) => {
      const ac = asRecord(item);
      const verified = asBool(ac.verified);
      return {
        id: asText(ac.id),
        name: asText(ac.name),
        verified,
        last_read: Number(ac.last_read) || 0,
        power_on: verified && typeof ac.power_on === "boolean" ? ac.power_on : null,
        target_c: verified && typeof ac.target_c === "number" ? ac.target_c : null,
        mode: asText(ac.mode) || null,
      };
    }),
  };
}

function parseDeviceOption(value: unknown): DeviceOption | null {
  const row = asRecord(value);
  const id = asText(row.id);
  if (!id) return null;
  const points = asArray(row.points)
    .map((item) => {
      const point = asRecord(item);
      const result: DevicePoint = {
        dp: asText(point.dp),
        code: asText(point.code) || asText(point.dp),
        type: asText(point.type),
      };
      if ("value" in point) result.value = point.value;
      if (Array.isArray(point.options)) result.options = asStringArray(point.options);
      if (typeof point.min === "number") result.min = point.min;
      if (typeof point.max === "number") result.max = point.max;
      if (typeof point.step === "number") result.step = point.step;
      return result;
    })
    .filter((point) => point.dp);
  return {
    id,
    name: asText(row.name) || id,
    verified: asBool(row.verified),
    lanKnown: asBool(row.lan_known),
    points,
  };
}

/** Read-only catalogue: real backend device IDs and their cached DP metadata. */
async function fetchDeviceCatalogue(): Promise<DeviceOption[]> {
  const response = await fetch("/api/local/devices", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const body: unknown = await response.json();
  return asArray(asRecord(body).devices)
    .map(parseDeviceOption)
    .filter((device): device is DeviceOption => device !== null);
}

function scheduleLabel(schedule: SceneView["schedule"]): string {
  if (!schedule.enabled || !schedule.time) return "Manual";
  const days = [...schedule.days].sort((a, b) => a - b);
  if (days.length === 0 || days.length === 7) return `Daily ${schedule.time}`;
  return `${days.map((day) => DAY_SHORT[day] ?? "").join(", ")} ${schedule.time}`;
}

// --- Page ------------------------------------------------------------------
function AutomationsPage() {
  const { t, log, devices, points } = useSmartPilot();
  const [scenes, setScenes] = useState<SceneView[]>([]);
  const [scheduler, setScheduler] = useState<SchedulerView | null>(null);
  const [rules, setRules] = useState<RuleView[]>([]);
  const [events, setEvents] = useState<EventView[]>([]);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [catalogue, setCatalogue] = useState<DeviceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [runSummary, setRunSummary] = useState("");

  const [createSceneOpen, setCreateSceneOpen] = useState(false);
  const [createRuleOpen, setCreateRuleOpen] = useState(false);
  const [runTarget, setRunTarget] = useState<SceneView | null>(null);
  const [deleteSceneTarget, setDeleteSceneTarget] = useState<SceneView | null>(null);
  const [deleteRuleTarget, setDeleteRuleTarget] = useState<RuleView | null>(null);
  const [tickOpen, setTickOpen] = useState(false);
  const [busy, setBusy] = useState("");

  const refreshAll = useCallback(async () => {
    setLoading(true);
    const errors: string[] = [];
    try {
      const data = asRecord(await getScenes());
      setScenes(
        asArray(data.scenes)
          .map(parseScene)
          .filter((scene): scene is SceneView => scene !== null),
      );
    } catch (error) {
      errors.push(`scenes: ${messageOf(error)}`);
    }
    try {
      setScheduler(parseScheduler(await getScheduler()));
    } catch (error) {
      errors.push(`scheduler: ${messageOf(error)}`);
    }
    try {
      setRules(
        asArray(asRecord(await getRules()).rules)
          .map(parseRule)
          .filter((rule): rule is RuleView => rule !== null),
      );
    } catch (error) {
      errors.push(`rules: ${messageOf(error)}`);
    }
    try {
      setEvents(
        asArray(asRecord(await getEvents()).events)
          .map(parseEvent)
          .filter((event): event is EventView => event !== null),
      );
    } catch (error) {
      errors.push(`events: ${messageOf(error)}`);
    }
    try {
      setUsage(parseUsage(await getUsage()));
    } catch (error) {
      errors.push(`usage: ${messageOf(error)}`);
    }
    try {
      setCatalogue(await fetchDeviceCatalogue());
    } catch (error) {
      errors.push(`devices: ${messageOf(error)}`);
    }
    setLoadError(errors.join(" · "));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // The store's `points` are keyed by the Lovable device ID; the backend scene
  // API needs the real device ID. Match by exact device name (the names are a
  // fixed contract) and use the verified store points for live values/types.
  const deviceOptions = useMemo<DeviceOption[]>(() => {
    return catalogue.map((device) => {
      const local = devices.find((item) => item.name === device.name);
      const live = local ? points[local.id] ?? [] : [];
      const liveByDp = new Map(live.map((point) => [String(point.dp), point]));
      const merged = device.points.map((point) => {
        const verified = liveByDp.get(point.dp);
        if (!verified) return point;
        return {
          ...point,
          code: point.code || verified.code,
          type: point.type || verified.type,
          value: verified.value,
        };
      });
      return { ...device, points: merged };
    });
  }, [catalogue, devices, points]);

  const deviceName = useCallback(
    (id: string) =>
      catalogue.find((device) => device.id === id)?.name ||
      devices.find((device) => device.id === id)?.name ||
      id,
    [catalogue, devices],
  );

  const reloadScenes = useCallback(async () => {
    try {
      const data = asRecord(await getScenes());
      setScenes(
        asArray(data.scenes)
          .map(parseScene)
          .filter((scene): scene is SceneView => scene !== null),
      );
    } catch (error) {
      toast.error(messageOf(error));
    }
    try {
      setScheduler(parseScheduler(await getScheduler()));
    } catch {
      // Scheduler status is informational; keep the last known value.
    }
  }, []);

  const confirmRunScene = async () => {
    if (!runTarget) return;
    const scene = runTarget;
    setBusy("run");
    try {
      const result = asRecord(await runScene(scene.id));
      const succeeded = asNumber(result.succeeded);
      const failed = asNumber(result.failed);
      const failures = asArray(result.results)
        .map(asRecord)
        .filter((item) => item.ok !== true)
        .map((item) => {
          const id = asText(item.device_id);
          return `${deviceName(id)} DP ${asText(item.dp)}: ${asText(item.error) || "failed"}`;
        });
      const summary = `${scene.name}: ${succeeded} succeeded, ${failed} failed of ${scene.actions.length} action(s).`;
      setRunSummary(failures.length ? `${summary} ${failures.join(" · ")}` : summary);
      if (failed > 0) {
        toast.warning(summary, { description: failures.join(" · ") || undefined });
      } else {
        toast.success(summary);
      }
      log({
        kind: "automation",
        status: failed > 0 ? "warning" : "success",
        title: `Scene run: ${scene.name}`,
        detail: `${succeeded} succeeded, ${failed} failed — real commands were sent through the local backend.`,
      });
      setRunTarget(null);
      await reloadScenes();
    } catch (error) {
      toast.error(messageOf(error));
      log({
        kind: "automation",
        status: "blocked",
        title: `Scene run refused: ${scene.name}`,
        detail: messageOf(error),
      });
    } finally {
      setBusy("");
    }
  };

  const confirmDeleteScene = async () => {
    if (!deleteSceneTarget) return;
    const scene = deleteSceneTarget;
    setBusy("delete-scene");
    try {
      await deleteScene(scene.id);
      toast.success(`Scene deleted: ${scene.name}`);
      log({ kind: "automation", status: "info", title: `Scene deleted: ${scene.name}` });
      setDeleteSceneTarget(null);
      await reloadScenes();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy("");
    }
  };

  const confirmTick = async () => {
    setBusy("tick");
    try {
      const result = asRecord(await tickScheduler());
      const ran = asArray(result.ran).map(asRecord);
      const failed = ran.reduce((total, row) => total + (asNumber(row.failed) > 0 ? 1 : 0), 0);
      const names = ran.map((row) => `${asText(row.name) || asText(row.id)} (${asBool(row.ok) ? "ok" : "failed"})`);
      setRunSummary(
        ran.length
          ? `Due scenes run: ${ran.length}, scenes with failures: ${failed}. ${names.join(" · ")}`
          : "No scenes were due.",
      );
      if (failed > 0) toast.warning(`${ran.length} due scene(s) run — ${failed} with failures.`);
      else if (ran.length) toast.success(`${ran.length} due scene(s) run.`);
      else toast.info("No scenes were due.");
      log({
        kind: "automation",
        status: failed > 0 ? "warning" : "success",
        title: "Scheduler tick requested",
        detail: names.length ? names.join(" · ") : "No scenes were due.",
      });
      setTickOpen(false);
      await reloadScenes();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy("");
    }
  };

  const confirmDeleteRule = async () => {
    if (!deleteRuleTarget) return;
    const rule = deleteRuleTarget;
    setBusy("delete-rule");
    try {
      await deleteRule(rule.id);
      setRules((current) => current.filter((item) => item.id !== rule.id));
      toast.success(`Rule deleted: ${rule.name}`);
      log({ kind: "safety", status: "info", title: `Rule deleted: ${rule.name}` });
      setDeleteRuleTarget(null);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <PageHeader
        title={t("automations_title")}
        sub="Scenes, schedules and rules stored by the local backend. Running a scene sends real device commands."
        eyebrow={<LiveBadge />}
        actions={
          <>
            <Button variant="glass" size="touch" onClick={() => void refreshAll()} disabled={loading}>
              <RefreshCw /> Refresh
            </Button>
            <Button variant="hero" size="touch" onClick={() => setCreateSceneOpen(true)}>
              <Plus /> New scene
            </Button>
          </>
        }
      />

      {loadError && (
        <p
          className="mb-4 flex flex-wrap items-start gap-2 rounded-2xl border border-status-preview/30 bg-status-preview/8 p-3 text-xs text-status-preview"
          role="status"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          Some backend panels could not be loaded: {loadError}
        </p>
      )}
      {runSummary && (
        <p
          className="mb-4 flex flex-wrap items-start gap-2 rounded-2xl border border-primary/30 bg-primary/8 p-3 text-xs"
          role="status"
        >
          <Check className="mt-px size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 break-words">{runSummary}</span>
          <button
            type="button"
            className="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-muted-foreground hover:text-foreground"
            onClick={() => setRunSummary("")}
            aria-label="Dismiss result"
          >
            <X className="size-4" aria-hidden />
          </button>
        </p>
      )}

      <Tabs defaultValue="scenes">
        <TabsList className="mb-5 flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-2xl glass p-1 scrollbar-none sm:w-fit">
          <TabsTrigger value="scenes" className="h-10 shrink-0 rounded-xl px-4">
            Scenes
          </TabsTrigger>
          <TabsTrigger value="scheduler" className="h-10 shrink-0 rounded-xl px-4">
            Scheduler
          </TabsTrigger>
          <TabsTrigger value="rules" className="h-10 shrink-0 rounded-xl px-4">
            Rules
          </TabsTrigger>
          <TabsTrigger value="activity" className="h-10 shrink-0 rounded-xl px-4">
            Activity &amp; usage
          </TabsTrigger>
        </TabsList>
        <TabsContent value="scenes">
          <ScenesTab
            scenes={scenes}
            deviceName={deviceName}
            loading={loading}
            busy={busy}
            onCreate={() => setCreateSceneOpen(true)}
            onRun={setRunTarget}
            onDelete={setDeleteSceneTarget}
          />
        </TabsContent>
        <TabsContent value="scheduler">
          <SchedulerTab
            scheduler={scheduler}
            loading={loading}
            busy={busy === "tick"}
            onTick={() => setTickOpen(true)}
          />
        </TabsContent>
        <TabsContent value="rules">
          <RulesTab
            rules={rules}
            deviceName={deviceName}
            loading={loading}
            busy={busy === "delete-rule"}
            onCreate={() => setCreateRuleOpen(true)}
            onDelete={setDeleteRuleTarget}
          />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTab events={events} usage={usage} deviceName={deviceName} loading={loading} />
        </TabsContent>
      </Tabs>

      <CreateSceneDialog
        open={createSceneOpen}
        onOpenChange={setCreateSceneOpen}
        deviceOptions={deviceOptions}
        onCreated={() => void reloadScenes()}
      />
      <CreateRuleDialog
        open={createRuleOpen}
        onOpenChange={setCreateRuleOpen}
        deviceOptions={deviceOptions}
        onCreated={() =>
          void getRules()
            .then((data) =>
              setRules(
                asArray(asRecord(data).rules)
                  .map(parseRule)
                  .filter((rule): rule is RuleView => rule !== null),
              ),
            )
            .catch((error) => toast.error(messageOf(error)))
        }
      />

      <Dialog open={!!runTarget} onOpenChange={(open) => !open && setRunTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run “{runTarget?.name ?? ""}” now?</DialogTitle>
            <DialogDescription>
              This sends REAL device commands through the local backend. Nothing is simulated and
              the action cannot be undone. The backend refuses critical safety devices, busy
              devices and unverified writes.
            </DialogDescription>
          </DialogHeader>
          {runTarget && (
            <ul className="max-h-64 space-y-2 overflow-y-auto">
              {runTarget.actions.map((action, index) => (
                <li
                  key={`${action.device_id}-${action.dp}-${index}`}
                  className="flex items-start gap-2 rounded-2xl border border-glass-border bg-muted/30 p-3 text-sm"
                >
                  <Zap className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <div className="min-w-0 break-words">
                    <p className="font-medium">{deviceName(action.device_id)}</p>
                    <p className="text-xs text-muted-foreground">
                      DP {action.dp} → {formatValue(action.value)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setRunTarget(null)} disabled={!!busy}>
              Cancel
            </Button>
            <Button variant="warning" onClick={() => void confirmRunScene()} disabled={!!busy}>
              <Play /> Run scene — send commands
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!tickOpen}
        onOpenChange={(open) => !open && setTickOpen(false)}
        title="Run all due scenes now?"
        description="This immediately runs every scene whose schedule is due and sends REAL device commands through the local backend. It cannot be undone; the backend still blocks critical safety devices."
        confirmLabel="Run due scenes — send commands"
        confirmVariant="warning"
        busy={busy === "tick"}
        onConfirm={() => void confirmTick()}
      />

      <ConfirmDialog
        open={!!deleteSceneTarget}
        onOpenChange={(open) => !open && setDeleteSceneTarget(null)}
        title={`Delete scene “${deleteSceneTarget?.name ?? ""}”?`}
        description="This removes the saved scene from the local backend. No device command is sent."
        confirmLabel="Delete scene"
        confirmVariant="destructive"
        busy={busy === "delete-scene"}
        onConfirm={() => void confirmDeleteScene()}
      />

      <ConfirmDialog
        open={!!deleteRuleTarget}
        onOpenChange={(open) => !open && setDeleteRuleTarget(null)}
        title={`Delete rule “${deleteRuleTarget?.name ?? ""}”?`}
        description="This removes the safety rule from the local backend. No device command is sent."
        confirmLabel="Delete rule"
        confirmVariant="destructive"
        busy={busy === "delete-rule"}
        onConfirm={() => void confirmDeleteRule()}
      />
    </div>
  );
}

// --- Reusable confirmation dialog ------------------------------------------
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmVariant,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant: "warning" | "destructive";
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Scenes ----------------------------------------------------------------
function ScenesTab({
  scenes,
  deviceName,
  loading,
  busy,
  onCreate,
  onRun,
  onDelete,
}: {
  scenes: SceneView[];
  deviceName: (id: string) => string;
  loading: boolean;
  busy: string;
  onCreate: () => void;
  onRun: (scene: SceneView) => void;
  onDelete: (scene: SceneView) => void;
}) {
  if (loading)
    return <p className="text-sm text-muted-foreground">Loading scenes from the local backend…</p>;
  if (scenes.length === 0)
    return (
      <EmptyState
        icon={CalendarClock}
        title="No scenes yet"
        body="Create a scene from real device controls. Running it sends commands through the local backend."
        action={
          <Button variant="glass" onClick={onCreate}>
            <Plus /> New scene
          </Button>
        }
      />
    );
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-start gap-2 rounded-2xl border border-glass-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <ShieldAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
        Scenes and schedules never operate critical safety devices — the backend refuses those
        actions automatically.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {scenes.map((scene) => (
          <Panel key={scene.id} pad="sm" className="flex flex-col gap-3 animate-rise">
            <div className="flex items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary/12 text-primary">
                <Zap className="size-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words font-semibold leading-snug">{scene.name}</p>
                <p className="text-xs text-muted-foreground tabular">
                  <Clock className="mr-1 inline size-3" aria-hidden />
                  {scheduleLabel(scene.schedule)} · {scene.actions.length} action(s)
                </p>
              </div>
            </div>
            <ul className="space-y-1 text-sm">
              {scene.actions.map((action, index) => (
                <li key={`${action.device_id}-${action.dp}-${index}`} className="break-words">
                  <span className="font-medium">{deviceName(action.device_id)}</span> · DP{" "}
                  {action.dp} → {formatValue(action.value)}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={scene.schedule.enabled ? "info" : "outline"}>
                <CalendarClock className="size-3" aria-hidden />
                {scene.schedule.enabled ? describeDays(scene.schedule.days) : "Manual"}
              </Badge>
              {scene.last_run && scene.last_run !== "0" && (
              <Badge variant="outline">Last run {formatRunTime(scene.last_run)}</Badge>
            )}
            </div>
            <div className="mt-auto flex flex-wrap gap-2 pt-1">
              <Button
                variant="warning"
                size="touch"
                onClick={() => onRun(scene)}
                disabled={!!busy}
              >
                <Play /> Run (real commands)
              </Button>
              <Button
                variant="ghost"
                size="touch"
                className="text-muted-foreground"
                onClick={() => onDelete(scene)}
                disabled={!!busy}
                aria-label={`Delete ${scene.name}`}
              >
                <Trash2 /> Delete
              </Button>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

// --- Scheduler -------------------------------------------------------------
function SchedulerTab({
  scheduler,
  loading,
  busy,
  onTick,
}: {
  scheduler: SchedulerView | null;
  loading: boolean;
  busy: boolean;
  onTick: () => void;
}) {
  if (loading)
    return <p className="text-sm text-muted-foreground">Loading scheduler status…</p>;
  if (!scheduler)
    return (
      <EmptyState
        icon={CalendarClock}
        title="Scheduler unavailable"
        body="The local backend did not return scheduler information."
      />
    );
  return (
    <Panel className="space-y-5">
      <PanelTitle icon={CalendarClock}>Scheduler status</PanelTitle>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Scheduler" value={scheduler.active ? "Active" : "Inactive"} />
        <Stat label="Scenes" value={scheduler.scenes} />
        <Stat label="Scheduled" value={scheduler.scheduled} />
        <Stat label="Next run" value={scheduler.next_run ?? "None"} />
      </div>
      {scheduler.next_scene && (
        <p className="text-sm text-muted-foreground">
          Next scene: <span className="font-medium text-foreground">{scheduler.next_scene}</span>
          {scheduler.next_run_at ? ` at ${formatAt(scheduler.next_run_at)}` : ""}
        </p>
      )}
      {scheduler.note && (
        <p className="flex items-start gap-2 rounded-2xl border border-glass-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 break-words">{scheduler.note}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="warning" size="touch" onClick={onTick} disabled={busy}>
          <Play /> Run due scenes now
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        This is an explicit, confirmation-gated action. Due scenes send real device commands; no
        scene is run automatically by this screen.
      </p>
    </Panel>
  );
}

// --- Rules -----------------------------------------------------------------
function RulesTab({
  rules,
  deviceName,
  loading,
  busy,
  onCreate,
  onDelete,
}: {
  rules: RuleView[];
  deviceName: (id: string) => string;
  loading: boolean;
  busy: boolean;
  onCreate: () => void;
  onDelete: (rule: RuleView) => void;
}) {
  if (loading) return <p className="text-sm text-muted-foreground">Loading rules…</p>;
  return (
    <Panel className="space-y-4">
      <PanelTitle
        icon={ShieldAlert}
        action={
          <Button variant="glass" size="sm" className="h-10" onClick={onCreate}>
            <Plus /> New rule
          </Button>
        }
      >
        Duration rules
      </PanelTitle>
      {rules.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No rules yet"
          body="Create a rule that switches a device after a fixed on/off duration. The backend evaluates it."
          action={
            <Button variant="glass" onClick={onCreate}>
              <Plus /> New rule
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-start gap-3 py-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary/12 text-primary">
                <ShieldAlert className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{rule.name}</p>
                <p className="break-words text-xs text-muted-foreground">
                  {deviceName(rule.device_id)} · DP {rule.dp} · after {rule.minutes} min →{" "}
                  {rule.action ? "On" : "Off"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">{rule.kind}</Badge>
                <Badge variant={rule.enabled ? "ok" : "unknown"}>
                  {rule.enabled ? "Enabled" : "Disabled"}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon-touch"
                  onClick={() => onDelete(rule)}
                  disabled={busy}
                  aria-label={`Delete ${rule.name}`}
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Rules are evaluated by the local backend. Safety devices are refused by the backend even
        if a rule is saved.
      </p>
    </Panel>
  );
}

// --- Activity & usage ------------------------------------------------------
function ActivityTab({
  events,
  usage,
  deviceName,
  loading,
}: {
  events: EventView[];
  usage: UsageView | null;
  deviceName: (id: string) => string;
  loading: boolean;
}) {
  if (loading) return <p className="text-sm text-muted-foreground">Loading activity…</p>;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Panel>
        <PanelTitle icon={Activity}>Recent activity</PanelTitle>
        {events.length === 0 ? (
          <EmptyState icon={Inbox} title="No events" body="Backend activity will appear here." />
        ) : (
          <ul className="max-h-96 space-y-2 overflow-y-auto">
            {events.map((event) => (
              <li
                key={event.id}
                className="rounded-2xl border border-glass-border bg-muted/30 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={event.kind.includes("error") ? "preview" : "outline"}>
                    {event.kind}
                  </Badge>
                  <span className="font-medium">{event.title}</span>
                </div>
                {event.body && <p className="mt-1 break-words text-xs text-muted-foreground">{event.body}</p>}
                <p className="mt-1 text-xs text-muted-foreground tabular">{formatAt(event.at)}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel>
        <PanelTitle icon={Zap}>
          Usage {usage?.today ? `· ${usage.today}` : ""}
        </PanelTitle>
        {!usage ? (
          <EmptyState icon={Inbox} title="No usage data" body="The backend has not reported usage." />
        ) : (
          <div className="space-y-5">
            <Stat label="Today total" value={`${usage.total_kwh} kWh`} hint="Measured by the local backend" />
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Devices</p>
              {usage.devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No device samples yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {usage.devices.map((device) => (
                    <li key={device.id} className="flex justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0 break-words">{deviceName(device.id)}</span>
                      <span className="shrink-0 tabular">{device.kwh} kWh</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {usage.ac.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">AC last verified</p>
                <ul className="divide-y divide-border">
                  {usage.ac.map((ac) => (
                    <li key={ac.id} className="flex flex-wrap justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0 break-words">{ac.name || ac.id}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular">
                        {ac.verified
                          ? `${ac.power_on === null ? "power unknown" : ac.power_on ? "on" : "off"}${ac.target_c !== null ? ` · ${ac.target_c}°C` : ""} · ${formatAt(ac.last_read)}`
                          : "Not verified"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}

// --- Scene editor ----------------------------------------------------------
const SCENE_ICONS = ["bolt", "light", "fan", "curtain", "plug"];

function pointKind(point: DevicePoint): "bool" | "number" | "enum" | "text" {
  const type = point.type.toLowerCase();
  if (type.includes("bool")) return "bool";
  if (type.includes("int") || type.includes("float") || type.includes("number")) return "number";
  if (type.includes("enum") || (point.options?.length ?? 0) > 0) return "enum";
  return "text";
}

function defaultValueFor(point: DevicePoint): string {
  const kind = pointKind(point);
  if (kind === "bool") return "true";
  if (kind === "number") return String(point.value ?? point.min ?? 0);
  if (kind === "enum") return point.options?.[0] ?? "";
  return point.value === undefined || point.value === null ? "" : String(point.value);
}

function coerceValue(point: DevicePoint, text: string): unknown {
  const kind = pointKind(point);
  if (kind === "bool") return text === "true";
  if (kind === "number") {
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error("invalid_value");
    return value;
  }
  return text;
}

function CreateSceneDialog({
  open,
  onOpenChange,
  deviceOptions,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceOptions: DeviceOption[];
  onCreated: () => void;
}) {
  const { log } = useSmartPilot();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("bolt");
  const [deviceId, setDeviceId] = useState("");
  const [dp, setDp] = useState("");
  const [value, setValue] = useState("");
  const [actions, setActions] = useState<SceneInput["actions"]>([]);
  const [scheduled, setScheduled] = useState(false);
  const [time, setTime] = useState("07:30");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const device = deviceOptions.find((item) => item.id === deviceId);
  const point = device?.points.find((item) => item.dp === dp);

  useEffect(() => {
    if (!deviceId && deviceOptions.length) {
      const first = deviceOptions[0];
      if (!first) return;
      setDeviceId(first.id);
      setDp(first.points[0]?.dp ?? "");
    }
  }, [deviceId, deviceOptions]);

  const selectDevice = (id: string) => {
    setDeviceId(id);
    const next = deviceOptions.find((item) => item.id === id);
    const firstPoint = next?.points[0];
    setDp(firstPoint?.dp ?? "");
    setValue(firstPoint ? defaultValueFor(firstPoint) : "");
  };

  const selectPoint = (id: string) => {
    setDp(id);
    const nextPoint = device?.points.find((item) => item.dp === id);
    setValue(nextPoint ? defaultValueFor(nextPoint) : "");
  };

  const addAction = () => {
    if (!device || !point) {
      setError("Choose a device and a real data point first.");
      return;
    }
    if (actions.length >= 20) {
      setError("A scene can contain at most 20 actions.");
      return;
    }
    try {
      setActions((current) => [
        ...current,
        { device_id: device.id, dp: point.dp, value: coerceValue(point, value) },
      ]);
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const submit = async () => {
    if (!name.trim()) {
      setError("Give the scene a name.");
      return;
    }
    if (actions.length < 1 || actions.length > 20) {
      setError("Add between 1 and 20 actions.");
      return;
    }
    if (scheduled && (!time || days.length === 0)) {
      setError("A enabled schedule needs a time and at least one day.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await createScene({
        name: name.trim(),
        icon,
        actions,
        schedule: {
          enabled: scheduled,
          time: scheduled ? time : "",
          days: scheduled ? [...days].sort((a, b) => a - b) : [],
        },
      });
      toast.success(`Scene saved: ${name.trim()}`);
      log({
        kind: "automation",
        status: "success",
        title: `Scene created: ${name.trim()}`,
        detail: `${actions.length} action(s) saved to the local backend.`,
      });
      setName("");
      setActions([]);
      setScheduled(false);
      onCreated();
      onOpenChange(false);
    } catch (cause) {
      setError(messageOf(cause));
      toast.error(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New scene</DialogTitle>
          <DialogDescription>
            Actions are chosen from the local backend&apos;s real device data points. Saving a
            scene does not run it — running sends real commands and always asks first.
          </DialogDescription>
        </DialogHeader>
        <form
          className="max-h-[70vh] space-y-4 overflow-y-auto"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="scene-name">Name</Label>
              <Input
                id="scene-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Evening shut-down"
                maxLength={60}
                className="h-11 rounded-xl"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="scene-icon">Icon</Label>
              <Select value={icon} onValueChange={setIcon}>
                <SelectTrigger id="scene-icon" className="h-11 rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCENE_ICONS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2 rounded-2xl border border-glass-border bg-muted/30 p-3">
            <p className="text-sm font-medium">Actions ({actions.length}/20)</p>
            {deviceOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No local devices with data points were returned by the backend.
              </p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="scene-device">Device</Label>
                    <Select value={deviceId} onValueChange={selectDevice}>
                      <SelectTrigger id="scene-device" className="h-11 rounded-xl">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {deviceOptions.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="scene-dp">Data point</Label>
                    <Select value={dp} onValueChange={selectPoint}>
                      <SelectTrigger id="scene-dp" className="h-11 rounded-xl">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(device?.points ?? []).map((item) => (
                          <SelectItem key={item.dp} value={item.dp}>
                            {item.code} (DP {item.dp})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="scene-value">Value</Label>
                    {point && pointKind(point) === "bool" ? (
                      <Select value={value} onValueChange={setValue}>
                        <SelectTrigger id="scene-value" className="h-11 rounded-xl">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">On</SelectItem>
                          <SelectItem value="false">Off</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : point && pointKind(point) === "enum" && point.options?.length ? (
                      <Select value={value} onValueChange={setValue}>
                        <SelectTrigger id="scene-value" className="h-11 rounded-xl">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {point.options.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id="scene-value"
                        type={point && pointKind(point) === "number" ? "number" : "text"}
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        className="h-11 rounded-xl"
                      />
                    )}
                  </div>
                </div>
                <Button type="button" variant="glass" size="touch" onClick={addAction}>
                  <Plus /> Add action
                </Button>
              </>
            )}
            {actions.length > 0 && (
              <ul className="space-y-1">
                {actions.map((action, index) => (
                  <li
                    key={`${action.device_id}-${action.dp}-${index}`}
                    className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs"
                  >
                    <span className="min-w-0 flex-1 break-words">
                      {deviceNameFor(deviceOptions, action.device_id)} · DP {action.dp} →{" "}
                      {formatValue(action.value)}
                    </span>
                    <button
                      type="button"
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-muted-foreground hover:text-foreground"
                      onClick={() => setActions((current) => current.filter((_, i) => i !== index))}
                      aria-label={`Remove action ${index + 1}`}
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <fieldset className="space-y-3 rounded-2xl border border-glass-border p-3">
            <legend className="px-1 text-sm font-medium">Schedule</legend>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="scene-scheduled" className="text-sm text-muted-foreground">
                Enable schedule
              </Label>
              <Switch
                id="scene-scheduled"
                checked={scheduled}
                onCheckedChange={setScheduled}
                aria-label="Enable schedule"
              />
            </div>
            {scheduled && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="scene-time">Time</Label>
                  <Input
                    id="scene-time"
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    className="h-11 rounded-xl"
                    required
                  />
                </div>
                <div>
                  <p className="mb-1.5 text-sm font-medium">Days ({describeDays(days)})</p>
                  <div className="grid grid-cols-7 gap-1">
                    {DAY_SHORT.map((label, index) => {
                      const on = days.includes(index);
                      return (
                        <button
                          key={label}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            setDays((current) =>
                              on ? current.filter((day) => day !== index) : [...current, index],
                            )
                          }
                          className={cn(
                            "h-11 rounded-xl border border-glass-border text-xs font-medium",
                            on
                              ? "border-primary/60 bg-primary/15 text-primary"
                              : "bg-muted/30 text-muted-foreground",
                          )}
                        >
                          {label.slice(0, 2)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
            <p className="text-xs text-muted-foreground">
              Schedules run on the server while it is running. Critical safety devices are refused
              by the backend.
            </p>
          </fieldset>

          {error && (
            <p className="flex items-start gap-2 rounded-2xl border border-status-preview/30 bg-status-preview/8 p-3 text-xs text-status-preview" role="alert">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="hero" disabled={saving}>
              <Check /> Save scene
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function deviceNameFor(options: DeviceOption[], id: string): string {
  return options.find((item) => item.id === id)?.name || id;
}

// --- Rule editor -----------------------------------------------------------
function CreateRuleDialog({
  open,
  onOpenChange,
  deviceOptions,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceOptions: DeviceOption[];
  onCreated: () => void;
}) {
  const { log } = useSmartPilot();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"on_duration" | "off_duration">("on_duration");
  const [deviceId, setDeviceId] = useState("");
  const [dp, setDp] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [action, setAction] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const device = deviceOptions.find((item) => item.id === deviceId);

  useEffect(() => {
    if (!deviceId && deviceOptions.length) {
      const first = deviceOptions[0];
      if (!first) return;
      setDeviceId(first.id);
      setDp(first.points[0]?.dp ?? "");
    }
  }, [deviceId, deviceOptions]);

  const submit = async () => {
    if (!name.trim()) {
      setError("Give the rule a name.");
      return;
    }
    if (!deviceId || !dp) {
      setError("Choose a device and data point returned by the backend.");
      return;
    }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      setError("Minutes must be between 1 and 1440.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await createRule({
        name: name.trim(),
        kind,
        device_id: deviceId,
        dp,
        minutes,
        action,
        enabled: true,
      });
      toast.success(`Rule saved: ${name.trim()}`);
      log({
        kind: "safety",
        status: "success",
        title: `Rule created: ${name.trim()}`,
        detail: `${kind} · ${deviceNameFor(deviceOptions, deviceId)} DP ${dp} · ${minutes} min → ${action ? "On" : "Off"}`,
      });
      setName("");
      onCreated();
      onOpenChange(false);
    } catch (cause) {
      setError(messageOf(cause));
      toast.error(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New duration rule</DialogTitle>
          <DialogDescription>
            The local backend evaluates this rule against verified device state. Saving it does not
            send a command. Safety devices are refused by the backend.
          </DialogDescription>
        </DialogHeader>
        <form
          className="max-h-[70vh] space-y-4 overflow-y-auto"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              placeholder="e.g. Pump off after 20 min"
              className="h-11 rounded-xl"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rule-kind">Condition</Label>
              <Select
                value={kind}
                onValueChange={(value) =>
                  setKind(value === "off_duration" ? "off_duration" : "on_duration")
                }
              >
                <SelectTrigger id="rule-kind" className="h-11 rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="on_duration">On for N minutes</SelectItem>
                  <SelectItem value="off_duration">Off for N minutes</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-minutes">Minutes (1–1440)</Label>
              <Input
                id="rule-minutes"
                type="number"
                min={1}
                max={1440}
                value={minutes}
                onChange={(event) => setMinutes(Number(event.target.value))}
                className="h-11 rounded-xl"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rule-device">Device</Label>
              <Select
                value={deviceId}
                onValueChange={(id) => {
                  setDeviceId(id);
                  const next = deviceOptions.find((item) => item.id === id);
                  setDp(next?.points[0]?.dp ?? "");
                }}
              >
                <SelectTrigger id="rule-device" className="h-11 rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {deviceOptions.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-dp">Data point</Label>
              <Select value={dp} onValueChange={setDp}>
                <SelectTrigger id="rule-dp" className="h-11 rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(device?.points ?? []).map((item) => (
                    <SelectItem key={item.dp} value={item.dp}>
                      {item.code} (DP {item.dp})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-action">Then set</Label>
            <Select
              value={action ? "on" : "off"}
              onValueChange={(value) => setAction(value === "on")}
            >
              <SelectTrigger id="rule-action" className="h-11 rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="on">On</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && (
            <p className="flex items-start gap-2 rounded-2xl border border-status-preview/30 bg-status-preview/8 p-3 text-xs text-status-preview" role="alert">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="hero" disabled={saving}>
              <Check /> Save rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
