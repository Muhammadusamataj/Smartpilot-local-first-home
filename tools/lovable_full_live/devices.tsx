import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Clock,
  LayoutGrid,
  Loader2,
  Pencil,
  PlugZap,
  Power,
  Plus,
  Radar,
  RefreshCw,
  Search,
  SearchX,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ApprovalPill,
  ConnectionPill,
  DeviceGlyph,
  EmptyState,
  LiveBadge,
  PageHeader,
  Panel,
} from "@/components/sp/primitives";
import { DeviceSheet, ECOSYSTEM_LABEL, KIND_LABEL } from "@/components/sp/DeviceSheet";
import {
  addDevice,
  cancelLanScan,
  deleteDevice,
  ensureLocal,
  getDiagnostics,
  getLanScan,
  getPreferences,
  messageOf,
  savePreferences,
  startLanScan,
  updateDevice,
  type DeviceInput,
  type LocalPreferences,
} from "@/lib/smartpilot/backend-api";
import { useSmartPilot } from "@/lib/smartpilot/store";
import type { Device, DeviceCategory, SwitchDevice } from "@/lib/smartpilot/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/devices")({
  head: () => ({
    meta: [
      { title: "Devices — Smart Pilot Titanium Control" },
      {
        name: "description",
        content:
          "Catalog of the seven Haier and Smart Life devices with connectivity and control details.",
      },
      { property: "og:title", content: "Devices — Smart Pilot Titanium Control" },
      { property: "og:description", content: "Catalog of the seven Haier and Smart Life devices." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DevicesPage,
});

const CATS: ReadonlyArray<{ v: DeviceCategory | "all"; label: string }> = [
  { v: "all", label: "All" },
  { v: "climate", label: "Climate" },
  { v: "water", label: "Water" },
  { v: "power", label: "Power" },
  { v: "heating", label: "Heating" },
];

type JsonObj = Record<string, unknown>;
type ScanJob = JsonObj;
type ManageKind = SwitchDevice["kind"];

interface FormState {
  name: string;
  id: string;
  local_key: string;
  ip: string;
  version: string;
  dp: string;
  kind: ManageKind;
}

const EMPTY_FORM: FormState = {
  name: "",
  id: "",
  local_key: "",
  ip: "",
  version: "auto",
  dp: "1",
  kind: "water_pump",
};

const asRecord = (value: unknown): JsonObj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObj) : {};
const str = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const validId = (v: string) => /^[A-Za-z0-9_-]{1,64}$/.test(v);
const validKey = (v: string) => /^[!-~]{16,32}$/.test(v);
const validDp = (v: string) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 255;
const validIp = (v: string) =>
  /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split(".").every((part) => Number(part) <= 255);

function jobSummary(job: ScanJob | null): string {
  if (!job) return "No LAN scan has been started in this session.";
  const state = str(job["state"]);
  if (state === "running") {
    const progress = asRecord(job["progress"]);
    const done = str(progress["scanned"]) || str(progress["checked"]);
    return done ? `Scanning… ${done}` : "Scanning…";
  }
  if (state === "done") {
    const summary = asRecord(job["summary"]);
    const matched = str(summary["matched"]);
    return `Scan complete${matched ? ` — ${matched} matched` : ""}.`;
  }
  if (state === "failed") return `Scan failed: ${str(job["error"]) || "unknown error"}`;
  if (state === "cancelled") return "Scan cancelled.";
  return state ? `Scan status: ${state}` : "Scan status is no longer available.";
}

function DeviceFormFields({
  form,
  onChange,
  fixedId,
  keyPlaceholder,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  fixedId: boolean;
  keyPlaceholder: string;
}) {
  return (
    <div className="space-y-3.5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="dev-name">Device name</Label>
          <Input
            id="dev-name"
            value={form.name}
            maxLength={60}
            placeholder="e.g. Kitchen plug"
            className="h-11 rounded-xl"
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dev-id">Device ID</Label>
          <Input
            id="dev-id"
            value={form.id}
            disabled={fixedId}
            placeholder="letters, numbers, _ or -"
            className="h-11 rounded-xl"
            onChange={(e) => onChange({ id: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dev-ip">IP address</Label>
          <Input
            id="dev-ip"
            value={form.ip}
            inputMode="decimal"
            placeholder="192.168.1.23"
            className="h-11 rounded-xl tabular"
            onChange={(e) => onChange({ ip: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dev-version">Protocol version</Label>
          <Select value={form.version} onValueChange={(v) => onChange({ version: v })}>
            <SelectTrigger id="dev-version" className="h-11 rounded-xl">
              <SelectValue placeholder="Auto (detect)" />
            </SelectTrigger>
            <SelectContent>
              {["auto", "3.5", "3.4", "3.3", "3.2", "3.1"].map((v) => (
                <SelectItem key={v} value={v}>
                  {v === "auto" ? "Auto (detect)" : v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dev-dp">ON/OFF data point</Label>
          <Input
            id="dev-dp"
            value={form.dp}
            inputMode="numeric"
            placeholder="1"
            className="h-11 rounded-xl tabular"
            onChange={(e) => onChange({ dp: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dev-kind">Type (display only)</Label>
          <Select value={form.kind} onValueChange={(v) => onChange({ kind: v as ManageKind })}>
            <SelectTrigger id="dev-kind" className="h-11 rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="water_pump">Water motor</SelectItem>
              <SelectItem value="breaker">Circuit breaker</SelectItem>
              <SelectItem value="water_heater">Water heater</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="dev-key">Local key</Label>
        <Input
          id="dev-key"
          type="password"
          value={form.local_key}
          maxLength={32}
          autoComplete="new-password"
          placeholder={keyPlaceholder}
          className="h-11 rounded-xl"
          onChange={(e) => onChange({ local_key: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">Keys are never displayed after saving.</p>
      </div>
    </div>
  );
}

function DevicesPage() {
  const { t, devices, connection, refreshDevices, log } = useSmartPilot();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<DeviceCategory | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [added, setAdded] = useState<Device[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [meta, setMeta] = useState<Record<string, FormState>>({});
  const [prefs, setPrefs] = useState<LocalPreferences | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState<Device | null>(null);
  const [deleteAck, setDeleteAck] = useState(false);

  const [scanOpen, setScanOpen] = useState(false);
  const [scanTargets, setScanTargets] = useState("");
  const [scanJob, setScanJob] = useState<ScanJob | null>(null);
  const [scanPolling, setScanPolling] = useState(false);
  const pollInFlight = useRef(false);

  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [orgHomes, setOrgHomes] = useState<string[]>([]);
  const [orgRooms, setOrgRooms] = useState<Record<string, string>>({});
  const [orgError, setOrgError] = useState("");

  const [diagDevice, setDiagDevice] = useState<Device | null>(null);
  const [diagData, setDiagData] = useState<JsonObj | null>(null);
  const [diagError, setDiagError] = useState("");

  const withBusy = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy((old) => ({ ...old, [key]: true }));
    try {
      await action();
    } finally {
      setBusy((old) => ({ ...old, [key]: false }));
    }
  }, []);

  const allDevices = useMemo(() => {
    const liveIds = new Set(
      devices.filter((d) => !removed.includes(d.id)).map((d) => d.id),
    );
    const result: Device[] = [];
    // First, add live devices (preserving their order from the store)
    devices.filter((d) => !removed.includes(d.id)).forEach((d) => result.push(d));
    // Then, add added devices that aren't already in the live set
    added
      .filter((d) => !removed.includes(d.id) && !liveIds.has(d.id))
      .forEach((d) => result.push(d));
    return result;
  }, [devices, added, removed]),

  const selected = useMemo(
    () => (selectedId ? allDevices.find((d) => d.id === selectedId) ?? null : null),
    [allDevices, selectedId],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allDevices.filter(
      (d) =>
        (cat === "all" || d.category === cat) &&
        (!needle ||
          `${d.name} ${prefs?.rooms?.[d.id] ?? d.location ?? ""} ${KIND_LABEL[d.kind]}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [allDevices, q, cat, prefs]);

  const groups = useMemo(() => {
    const m = new Map<string, Device[]>();
    for (const d of filtered) {
      const k = prefs?.rooms?.[d.id] || d.location || t("room_not_set");
      const bucket = m.get(k);
      if (bucket) {
        bucket.push(d);
      } else {
        m.set(k, [d]);
      }
    }
    return [...m.entries()];
  }, [filtered, prefs, t]);

  useEffect(() => {
    let alive = true;
    void getPreferences()
      .then((p) => {
        if (!alive) return;
        setPrefs(p);
        setFavorites(Array.isArray(p.favorites) ? p.favorites : []);
      })
      .catch(() => {
        /* preferences are optional; keep local defaults */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Deep link: /devices?device=<id> opens the matching device once per query change.
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const handledQueryId = useRef<string | null>(null);
  useEffect(() => {
    const raw = searchStr || window.location.search;
    const id = new URLSearchParams(raw).get("device");
    if (!id) {
      handledQueryId.current = null;
      return;
    }
    if (handledQueryId.current === id) return;
    if (allDevices.some((d) => d.id === id)) {
      handledQueryId.current = id;
      setSelectedId(id);
    }
  }, [searchStr, allDevices]);

  // LAN scan polling. One request at a time; stops as soon as the job ends.
  useEffect(() => {
    if (!scanOpen || !scanPolling) return;
    let alive = true;
    const poll = async () => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      try {
        const reply = asRecord(await getLanScan());
        if (!alive) return;
        const job = asRecord(reply["job"]);
        setScanJob(Object.keys(job).length > 0 ? job : null);
        const state = str(job["state"]);
        if (!state) {
          setScanPolling(false);
          toast.error("Scan result is no longer available — start a new scan.");
        } else if (state === "running") {
          // keep polling
        } else if (state === "done") {
          setScanPolling(false);
          toast.success("LAN scan complete — device list updated");
          void refreshDevices();
        } else if (state === "cancelled") {
          setScanPolling(false);
          toast("LAN scan cancelled");
        } else if (state === "failed") {
          setScanPolling(false);
          toast.error(`LAN scan failed: ${str(job["error"]) || "unknown error"}`);
        } else {
          setScanPolling(false);
          toast(`LAN scan ${state}`);
        }
      } catch (error) {
        if (alive) {
          setScanPolling(false);
          toast.error(`Scan status: ${messageOf(error)}`);
        }
      } finally {
        pollInFlight.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [scanOpen, scanPolling, refreshDevices]);

  const formFor = (d: Device): FormState => {
    const m = meta[d.id];
    return {
      name: d.name,
      id: d.id,
      local_key: "",
      ip: m?.ip ?? "",
      version: m?.version ?? "auto",
      dp: m?.dp ?? "1",
      kind: d.kind === "air_conditioner" ? "water_pump" : d.kind,
    };
  };

  const submitAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload: DeviceInput = {
      name: form.name.trim(),
      id: form.id.trim(),
      local_key: form.local_key.trim(),
      ip: form.ip.trim(),
      version: form.version || "auto",
      dp: Number(form.dp || "1"),
    };
    if (!payload.name) {
      toast.error("Enter a device name.");
      return;
    }
    if (!validId(payload.id)) {
      toast.error("Device ID must be 1–64 letters, numbers, _ or - characters.");
      return;
    }
    if (!validKey(payload.local_key)) {
      toast.error("Local key must be 16–32 printable ASCII characters.");
      return;
    }
    if (!validIp(payload.ip)) {
      toast.error("Enter a valid IPv4 address.");
      return;
    }
    if (!validDp(form.dp.trim())) {
      toast.error("ON/OFF DP must be a number from 1 to 255.");
      return;
    }
    await withBusy("add", async () => {
      try {
        await addDevice(payload);
        const created: SwitchDevice = {
          id: payload.id,
          name: payload.name,
          kind: form.kind,
          category:
            form.kind === "breaker" ? "power" : form.kind === "water_heater" ? "heating" : "water",
          ecosystem: "tuya_smart_life",
          location: null,
          requiresApproval: true,
          connection: "unknown",
          lastSeen: { known: false },
          power: { known: false },
          capabilities: { power: "unverified", timer: "unverified", energyMetering: "unverified" },
        };
        setAdded((old) => (old.some((d) => d.id === created.id) ? old : [...old, created]));
        setMeta((old) => ({ ...old, [payload.id]: { ...form, local_key: "" } }));
        setAddOpen(false);
        setForm(EMPTY_FORM);
        await refreshDevices();
        log({
          kind: "system",
          status: "success",
          title: `Device saved: ${payload.name}`,
          detail: "Stored locally; status stays unknown until a fresh verified read.",
        });
        toast.success("Device saved — waiting for the first live reply");
      } catch (error) {
        toast.error(messageOf(error));
      }
    });
  };

  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const name = form.name.trim() || editing.name;
    if (form.local_key.trim() && !validKey(form.local_key.trim())) {
      toast.error("Local key must be 16–32 printable ASCII characters, or leave it blank.");
      return;
    }
    if (form.ip.trim() && !validIp(form.ip.trim())) {
      toast.error("Enter a valid IPv4 address.");
      return;
    }
    if (form.dp.trim() && !validDp(form.dp.trim())) {
      toast.error("ON/OFF DP must be a number from 1 to 255.");
      return;
    }
    const payload: Partial<DeviceInput> & { id: string } = {
      id: editing.id,
      name,
      version: form.version || "auto",
    };
    if (form.local_key.trim()) payload.local_key = form.local_key.trim();
    if (form.dp.trim()) payload.dp = Number(form.dp.trim());
    if (form.ip.trim()) payload.ip = form.ip.trim();
    await withBusy("edit", async () => {
      try {
        await updateDevice(payload);
        const patch: Partial<FormState> = {
          name,
          ip: form.ip.trim(),
          version: form.version || "auto",
          dp: form.dp.trim(),
          local_key: "",
          kind: form.kind,
        };
        setMeta((old) => ({ ...old, [editing.id]: { ...formFor(editing), ...patch } }));
        setAdded((old) =>
          old.map((d) =>
            d.id === editing.id
              ? ({
                  ...d,
                  name,
                  kind: form.kind,
                  category:
                    form.kind === "breaker"
                      ? "power"
                      : form.kind === "water_heater"
                        ? "heating"
                        : "water",
                } as SwitchDevice)
              : d,
          ),
        );
        setEditing(null);
        await refreshDevices();
        log({
          kind: "system",
          status: "success",
          title: `Device settings saved: ${name}`,
          detail: "Waiting for the next verified read before any status is shown.",
        });
        toast.success("Device settings saved");
      } catch (error) {
        toast.error(messageOf(error));
      }
    });
  };

  const confirmDelete = async () => {
    if (!deleting || !deleteAck) return;
    await withBusy("delete", async () => {
      try {
        await deleteDevice(deleting.id);
        setRemoved((old) => [...new Set([...old, deleting.id])]);
        setSelectedId((current) => (current === deleting.id ? null : current));
        setDeleting(null);
        setDeleteAck(false);
        await refreshDevices();
        log({ kind: "system", status: "success", title: `Device removed: ${deleting.name}` });
        toast.success("Device removed from the local list");
      } catch (error) {
        toast.error(messageOf(error));
      }
    });
  };

  const reloadAll = async () => {
    await withBusy("refresh", async () => {
      await refreshDevices();
      toast(connection.state === "live" ? "Device statuses refreshed" : connection.message);
    });
  };

  const reconnect = async () => {
    await withBusy("ensure", async () => {
      try {
        const reply = asRecord(await ensureLocal());
        await refreshDevices();
        const detail = str(reply["message"]) || str(reply["status"]);
        toast.success(detail || "LAN reconnect requested — saved addresses reused");
        log({
          kind: "system",
          status: "info",
          title: "LAN reconnect requested",
          detail: detail || "No device command was sent.",
        });
      } catch (error) {
        toast.error(messageOf(error));
      }
    });
  };

  const startScan = async () => {
    const targets = scanTargets.trim();
    if (!targets) {
      toast.error("Enter a subnet or IP list to scan.");
      return;
    }
    setScanJob(null);
    setScanPolling(true);
    try {
      const reply = asRecord(await startLanScan(targets));
      const job = asRecord(reply["job"]);
      if (Object.keys(job).length > 0) setScanJob(job);
      toast("LAN scan started — read-only network probes only");
    } catch (error) {
      setScanPolling(false);
      toast.error(`LAN scan could not start: ${messageOf(error)}`);
    }
  };

  const stopScan = async () => {
    await withBusy("cancelScan", async () => {
      try {
        await cancelLanScan();
        setScanPolling(false);
        setScanJob((old) => (old ? { ...old, state: "cancelled" } : null));
        toast("Cancelling LAN scan…");
      } catch (error) {
        toast.error(messageOf(error));
      }
    });
  };

  const openDiagnostics = async (d: Device) => {
    setDiagDevice(d);
    setDiagData(null);
    setDiagError("");
    await withBusy("diag", async () => {
      try {
        setDiagData(asRecord(await getDiagnostics(d.id)));
      } catch (error) {
        setDiagError(messageOf(error));
      }
    });
  };

  const openOrganize = async () => {
    setOrganizeOpen(true);
    setOrgError("");
    await withBusy("orgLoad", async () => {
      try {
        const p = await getPreferences();
        setPrefs(p);
        setFavorites(Array.isArray(p.favorites) ? p.favorites : []);
        setOrgHomes((p.homes ?? []).map((h) => h.name));
        setOrgRooms({ ...(p.rooms ?? {}) });
      } catch (error) {
        setOrgError(messageOf(error));
      }
    });
  };

  const saveOrganize = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const rooms: Record<string, string> = {};
    for (const [id, room] of Object.entries(orgRooms)) {
      if (room.trim()) rooms[id] = room.trim();
    }
    const homes = orgHomes
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "home",
        name,
      }));
    const payload: LocalPreferences = {
      favorites,
      rooms,
      homes,
      ...(prefs?.updated_at !== undefined ? { updated_at: prefs.updated_at } : {}),
    };
    await withBusy("orgSave", async () => {
      try {
        const saved = await savePreferences(payload);
        setPrefs(saved);
        setOrgError("");
        setOrganizeOpen(false);
        toast.success("Homes and rooms saved");
      } catch (error) {
        setOrgError(messageOf(error));
      }
    });
  };

  const toggleFavorite = async (d: Device) => {
    const previous = favorites;
    const next = previous.includes(d.id)
      ? previous.filter((id) => id !== d.id)
      : [...previous, d.id];
    setFavorites(next);
    try {
      const saved = await savePreferences({
        favorites: next,
        rooms: { ...(prefs?.rooms ?? {}) },
        homes: (prefs?.homes ?? []).map((h) => ({ ...h })),
        ...(prefs?.updated_at !== undefined ? { updated_at: prefs.updated_at } : {}),
      });
      setPrefs(saved);
      toast.success(next.includes(d.id) ? "Added to favorites" : "Removed from favorites");
    } catch (error) {
      setFavorites(previous);
      toast.error(`Favorite was not saved: ${messageOf(error)}`);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("devices_title")}
        sub={t("devices_sub")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="hero"
              size="touch"
              onClick={() => {
                setForm(EMPTY_FORM);
                setAddOpen(true);
              }}
            >
              <Plus /> Add device
            </Button>
            <details className="group relative">
              <summary
                aria-label="More device management options"
                className="glass flex h-11 cursor-pointer list-none items-center rounded-full px-4 text-sm font-medium transition-colors hover:bg-accent/40 [&::-webkit-details-marker]:hidden"
              >
                Manage
              </summary>
              <div className="absolute right-0 z-30 mt-2 flex w-52 flex-col gap-1.5 rounded-2xl border border-glass-border bg-card p-2 shadow-glass">
                <Button
                  variant="glass"
                  size="touch"
                  className="w-full justify-start"
                  onClick={() => setScanOpen(true)}
                >
                  <Radar /> LAN scan
                </Button>
                <Button
                  variant="glass"
                  size="touch"
                  className="w-full justify-start"
                  onClick={() => void openOrganize()}
                >
                  <LayoutGrid /> Homes &amp; rooms
                </Button>
              </div>
            </details>
            <Button
              variant="glass"
              size="icon-touch"
              aria-label="Refresh all devices"
              title="Refresh all devices"
              disabled={connection.state === "refreshing" || !!busy["refresh"]}
              onClick={() => void reloadAll()}
            >
              <RefreshCw className={cn(connection.state === "refreshing" && "animate-spin")} />
            </Button>
            <Button
              variant="glass"
              size="icon-touch"
              aria-label="Reconnect using saved LAN addresses"
              title="Reconnect / ensure"
              disabled={!!busy["ensure"]}
              onClick={() => void reconnect()}
            >
              {busy["ensure"] ? <Loader2 className="animate-spin" /> : <PlugZap />}
            </Button>
          </div>
        }
      />

      <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            connection.state === "live"
              ? "bg-primary"
              : connection.state === "refreshing"
                ? "animate-pulse bg-warning"
                : "bg-muted-foreground/50",
          )}
          aria-hidden
        />
        <span>{connection.message}</span>
      </div>

      {connection.state === "degraded" && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-status-offline/30 bg-status-offline/8 px-4 py-3 text-sm"
        >
          <AlertTriangle className="size-4 shrink-0 text-status-offline" aria-hidden />
          <span className="min-w-0 flex-1 break-words">{connection.message}</span>
          <Button
            type="button"
            size="touch"
            variant="glass"
            disabled={!!busy["refresh"]}
            onClick={() => void reloadAll()}
          >
            <RefreshCw /> Retry
          </Button>
        </div>
      )}

      {connection.state === "refreshing" && allDevices.length === 0 && (
        <div role="status" className="space-y-2" aria-busy="true">
          <div className="h-12 animate-pulse rounded-2xl bg-muted/50" />
          <div className="h-12 animate-pulse rounded-2xl bg-muted/50" />
          <p className="text-xs text-muted-foreground">Loading verified device status…</p>
        </div>
      )}

      <div className="space-y-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`${t("search")}: name, location, type…`}
            aria-label={t("search")}
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

        <div
          className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 scrollbar-none sm:mx-0 sm:flex-wrap sm:px-0"
          role="group"
          aria-label="Filter by category"
        >
          {CATS.map((c) => {
            const n =
              c.v === "all"
                ? allDevices.length
                : allDevices.filter((d) => d.category === c.v).length;
            const active = cat === c.v;
            return (
              <Button
                key={c.v}
                variant="chip"
                size="touch"
                aria-pressed={active}
                onClick={() => setCat(c.v)}
                className={cn(
                  "h-11 shrink-0 rounded-full px-3.5 text-xs transition-all",
                  active && "border-primary/50 bg-primary/12 text-primary shadow-xs",
                )}
              >
                {c.label} <span className="text-muted-foreground tabular">{n}</span>
              </Button>
            );
          })}
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t("noResults")}
          action={
            <Button
              variant="glass"
              size="touch"
              onClick={() => {
                setQ("");
                setCat("all");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="space-y-8">
          {groups.map(([loc, list]) => (
            <section key={loc} aria-label={loc}>
              <h2 className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                <span>{loc}</span>
                <span className="tabular">· {list.length}</span>
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {list.map((d) => (
                  <DeviceCard
                    key={d.id}
                    device={d}
                    onOpen={() => setSelectedId(d.id)}
                    favorite={favorites.includes(d.id)}
                    onFavorite={() => void toggleFavorite(d)}
                    onEdit={() => {
                      setForm(formFor(d));
                      setEditing(d);
                    }}
                    onDelete={() => {
                      setDeleteAck(false);
                      setDeleting(d);
                    }}
                    onDiagnostics={() => void openDiagnostics(d)}
                    managing={d.kind !== "air_conditioner"}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <DeviceSheet device={selected} onOpenChange={(o) => !o && setSelectedId(null)} />

      {/* Add device */}
      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) setForm(EMPTY_FORM);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a device</DialogTitle>
            <DialogDescription>
              Saves credentials to the existing local device list. No command is sent and status
              stays unknown until a fresh verified read.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void submitAdd(e)} className="space-y-4">
            <DeviceFormFields
              form={form}
              onChange={(patch) => setForm((old) => ({ ...old, ...patch }))}
              fixedId={false}
              keyPlaceholder="16–32 printable characters"
            />
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" size="touch" onClick={() => setAddOpen(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" variant="hero" size="touch" disabled={!!busy["add"]} aria-busy={!!busy["add"]}>
                {busy["add"] ? <Loader2 className="animate-spin" /> : <Plus />} Save device
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit device */}
      <Dialog
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.name ?? "device"}</DialogTitle>
            <DialogDescription>
              Updates name, address, protocol, key or ON/OFF DP through the existing device editor.
              A blank key keeps the saved one.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void submitEdit(e)} className="space-y-4">
            <DeviceFormFields
              form={form}
              onChange={(patch) => setForm((old) => ({ ...old, ...patch }))}
              fixedId
              keyPlaceholder="Unchanged — leave blank"
            />
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" size="touch" onClick={() => setEditing(null)}>
                {t("cancel")}
              </Button>
              <Button type="submit" variant="hero" size="touch" disabled={!!busy["edit"]} aria-busy={!!busy["edit"]}>
                {busy["edit"] ? <Loader2 className="animate-spin" /> : <Pencil />} Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete device — explicit confirmation */}
      <Dialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) {
            setDeleting(null);
            setDeleteAck(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 aria-hidden /> Remove {deleting?.name ?? "device"}?
            </DialogTitle>
            <DialogDescription>
              This removes the saved device from the local list. It does not send any command to the
              hardware and cannot be undone from this screen.
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-glass-border bg-muted/40 p-3 text-sm">
            <Checkbox
              checked={deleteAck}
              onCheckedChange={(v) => setDeleteAck(v === true)}
              className="mt-0.5"
            />
            <span>I understand this device will be removed from the saved local list.</span>
          </label>
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="touch" onClick={() => setDeleting(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              size="touch"
              disabled={!deleteAck || !!busy["delete"]}
              aria-busy={!!busy["delete"]}
              onClick={() => void confirmDelete()}
            >
              {busy["delete"] ? <Loader2 className="animate-spin" /> : <Trash2 />} Remove device
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* LAN scan */}
      <Dialog
        open={scanOpen}
        onOpenChange={(o) => {
          setScanOpen(o);
          if (!o) setScanPolling(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>LAN scan</DialogTitle>
            <DialogDescription>
              Read-only network probes using the existing scanner. No device state is changed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="scan-targets">Subnet or IP list</Label>
            <Input
              id="scan-targets"
              value={scanTargets}
              placeholder="192.168.1.0/24 or 192.168.1.23, 192.168.1.24"
              className="h-11 rounded-xl tabular"
              onChange={(e) => setScanTargets(e.target.value)}
              disabled={scanPolling}
            />
          </div>
          <div
            className="rounded-2xl border border-glass-border bg-muted/40 p-3"
            role="status"
            aria-live="polite"
          >
            <p className="text-sm font-medium">{jobSummary(scanJob)}</p>
            {scanJob && !scanPolling && (
              <p className="mt-1 text-xs text-muted-foreground tabular">
                {str(scanJob["targets"]) || "Scan finished"}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="touch" onClick={() => setScanOpen(false)}>
              Close
            </Button>
            {scanPolling ? (
              <Button
                variant="warning"
                size="touch"
                onClick={() => void stopScan()}
                disabled={!!busy["cancelScan"]}
                aria-busy={!!busy["cancelScan"]}
              >
                {busy["cancelScan"] ? <Loader2 className="animate-spin" /> : <X />} Cancel scan
              </Button>
            ) : (
              <Button variant="hero" size="touch" onClick={() => void startScan()}>
                <Radar /> Start scan
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Homes and rooms */}
      <Dialog
        open={organizeOpen}
        onOpenChange={(o) => {
          setOrganizeOpen(o);
          if (!o) setOrgError("");
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Homes &amp; rooms</DialogTitle>
            <DialogDescription>
              Organizes devices in local preferences. Favorites are toggled on each device card.
            </DialogDescription>
          </DialogHeader>
          {orgError && (
            <p className="text-sm text-status-offline" role="alert">
              {orgError}
            </p>
          )}
          <form onSubmit={(e) => void saveOrganize(e)} className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Homes</p>
              {orgHomes.map((home, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={home}
                    maxLength={60}
                    placeholder="Home name"
                    aria-label={`Home ${index + 1}`}
                    className="h-11 rounded-xl"
                    onChange={(e) =>
                      setOrgHomes((old) => old.map((h, i) => (i === index ? e.target.value : h)))
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-touch"
                    aria-label={`Remove home ${index + 1}`}
                    onClick={() => setOrgHomes((old) => old.filter((_, i) => i !== index))}
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="glass"
                size="touch"
                onClick={() => setOrgHomes((old) => [...old, ""])}
              >
                <Plus /> Add home
              </Button>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Rooms</p>
              {allDevices.map((d) => (
                <div key={d.id} className="grid items-center gap-2 sm:grid-cols-[1fr_1fr]">
                  <span className="min-w-0 truncate text-sm">{d.name}</span>
                  <Input
                    value={orgRooms[d.id] ?? ""}
                    maxLength={60}
                    placeholder="Room (blank = default)"
                    aria-label={`Room for ${d.name}`}
                    className="h-11 rounded-xl"
                    onChange={(e) =>
                      setOrgRooms((old) => ({ ...old, [d.id]: e.target.value }))
                    }
                  />
                </div>
              ))}
              {allDevices.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Add a device first, then assign rooms here.
                </p>
              )}
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" size="touch" onClick={() => setOrganizeOpen(false)}>
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                variant="hero"
                size="touch"
                disabled={!!busy["orgSave"]}
                aria-busy={!!busy["orgSave"]}
              >
                {busy["orgSave"] ? <Loader2 className="animate-spin" /> : <LayoutGrid />} Save
                organization
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Per-device diagnostics (read-only) */}
      <Dialog
        open={!!diagDevice}
        onOpenChange={(o) => {
          if (!o) setDiagDevice(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity aria-hidden /> Diagnostics: {diagDevice?.name ?? ""}
            </DialogTitle>
            <DialogDescription>
              Read-only reachability facts from the existing diagnostics endpoint. No probe here
              sends a device command.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="glass"
              size="touch"
              disabled={!!busy["diag"]}
              aria-busy={!!busy["diag"]}
              onClick={() => diagDevice && void openDiagnostics(diagDevice)}
            >
              {busy["diag"] ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-run
            </Button>
          </div>
          {diagError && (
            <p className="text-sm text-status-offline" role="alert">
              {diagError}
            </p>
          )}
          {diagData && (
            <>
              <div className="grid gap-2 rounded-2xl border border-glass-border bg-muted/40 p-3 text-sm sm:grid-cols-2">
                <Fact
                  label="Saved IP"
                  value={str(asRecord(diagData["addresses"])["saved_ip"]) || "unknown"}
                />
                <Fact
                  label="TCP port"
                  value={str(asRecord(diagData["tcp6668"])["state"]) || "unknown"}
                />
                <Fact
                  label="Protocol match"
                  value={(() => {
                    const match = asRecord(asRecord(diagData["protocol"])["handshake"])["match"];
                    return typeof match === "boolean"
                      ? String(match)
                      : str(match) || "unverified";
                  })()}
                />
                <Fact
                  label="Status result"
                  value={str(asRecord(diagData["status"])["result"]) || "unknown"}
                />
                <Fact
                  label="Failed reads"
                  value={str(asRecord(diagData["history"])["fail_count"]) || "0"}
                />
              </div>
              <pre className="max-h-72 overflow-auto rounded-2xl border border-glass-border bg-muted/30 p-3 text-xs leading-relaxed tabular">
                {JSON.stringify(diagData, null, 2)}
              </pre>
            </>
          )}
          {!diagData && !diagError && !busy["diag"] && (
            <p className="text-sm text-muted-foreground">No diagnostics available.</p>
          )}
          <DialogFooter>
            <Button variant="ghost" size="touch" onClick={() => setDiagDevice(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate font-medium tabular">{value}</p>
    </div>
  );
}

/** Quick power on the device card. Critical loads keep a two-tap arm gate. */
function CardPowerToggle({ device }: { device: Device }) {
  const { connection, sendDeviceCommand, log } = useSmartPilot();
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const target: "on" | "off" =
    device.power.known && device.power.value === "on" ? "off" : "on";

  const fire = async () => {
    setBusy(true);
    try {
      await sendDeviceCommand(
        device.id,
        { type: "power", value: target },
        device.requiresApproval
          ? { approvedBy: "local-user-two-tap", approvedAt: new Date().toISOString() }
          : undefined,
      );
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  const onClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (busy || connection.state === "refreshing" || device.connection !== "online") return;
    if (device.requiresApproval && !armed) {
      setArmed(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setArmed(false), 4500);
      log({
        kind: "safety",
        status: "warning",
        title: `${device.name}: power ${target} armed — tap again to confirm`,
        deviceId: device.id,
      });
      return;
    }
    void fire();
  };

  const label = armed
    ? `Tap again to turn ${target}`
    : device.power.known
      ? `Turn ${device.power.value === "on" ? "off" : "on"}`
      : "Set power";

  return (
    <button
      type="button"
      data-critical={device.requiresApproval ? "true" : undefined}
      disabled={busy || connection.state === "refreshing" || device.connection !== "online"}
      aria-label={`${label} ${device.name}`}
      aria-busy={busy}
      onClick={onClick}
      onKeyDown={(event) => event.stopPropagation()}
      className={cn(
        "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-all active:scale-[0.97] disabled:opacity-50",
        armed
          ? "border-warning/50 bg-warning/15 text-warning"
          : "border-glass-border bg-accent/40 hover:bg-accent",
      )}
    >
      <Power className="size-3.5" aria-hidden />
      <span>{armed ? "Confirm" : target === "on" ? "On" : "Off"}</span>
      {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
    </button>
  );
}

function DeviceCard({
  device,
  onOpen,
  favorite,
  onFavorite,
  onEdit,
  onDelete,
  onDiagnostics,
  managing,
}: {
  device: Device;
  onOpen: () => void;
  favorite: boolean;
  onFavorite: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDiagnostics: () => void;
  managing: boolean;
}) {
  const { t } = useSmartPilot();
  const isOn = device.power.known && device.power.value === "on";

  return (
    <Panel pad="none" className="animate-rise overflow-hidden">
      <div className="flex flex-col gap-3.5 p-4">
        <div className="flex items-start gap-3">
          <DeviceGlyph device={device} />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onOpen}
              className="group block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
              aria-label={`Open ${device.name} details`}
            >
              <span className="flex items-center gap-1.5">
                <span className="truncate font-semibold tracking-tight group-hover:text-primary transition-colors">
                  {device.name}
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                  aria-hidden
                />
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {KIND_LABEL[device.kind]} · {ECOSYSTEM_LABEL[device.ecosystem]}
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-2xl bg-muted/40 p-2.5">
            <p className="text-[11px] text-muted-foreground">{t("connectivity")}</p>
            <div className="mt-1.5">
              <ConnectionPill status={device.connection} />
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-2xl bg-muted/40 p-2.5">
            <div>
              <p className="text-[11px] text-muted-foreground">{t("power")}</p>
              <p
                className={cn(
                  "mt-1 font-medium tabular",
                  isOn && "text-foreground",
                  !device.power.known && "text-muted-foreground",
                )}
              >
                {device.power.known ? device.power.value.toUpperCase() : t("status_unknown")}
              </p>
            </div>
            <div className="mt-2">
              <CardPowerToggle device={device} />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {device.requiresApproval ? <ApprovalPill /> : <LiveBadge />}
          <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground tabular">
            <Clock className="size-3" aria-hidden />
            {device.lastSeen.known
              ? new Date(device.lastSeen.value).toLocaleTimeString()
              : t("status_unknown")}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t border-glass-border/70 px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-touch"
          aria-label={
            favorite ? `Remove ${device.name} from favorites` : `Add ${device.name} to favorites`
          }
          aria-pressed={favorite}
          title={favorite ? "Favorite" : "Add to favorites"}
          onClick={onFavorite}
        >
          <Star className={cn("size-4", favorite && "fill-current text-warning")} />
        </Button>

        {managing ? (
          <>
            <Button
              variant="ghost"
              size="icon-touch"
              aria-label={`Diagnostics for ${device.name}`}
              title="Diagnostics"
              onClick={onDiagnostics}
            >
              <Activity className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-touch"
              aria-label={`Edit ${device.name}`}
              title="Edit device"
              onClick={onEdit}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-touch"
              aria-label={`Remove ${device.name}`}
              title="Remove device"
              className="text-status-offline hover:text-status-offline"
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        ) : (
          <span className="ml-1 text-[11px] text-muted-foreground">
            Haier slot — configured in Settings
          </span>
        )}
      </div>
    </Panel>
  );
}
