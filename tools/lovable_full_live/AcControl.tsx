import { useEffect, useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  Cloud,
  Droplets,
  Fan,
  Flame,
  Hand,
  Leaf,
  Loader2,
  LogIn,
  LogOut,
  Minus,
  Moon,
  Plus,
  Power,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Snowflake,
  Sparkles,
  Thermometer,
  Timer,
  VolumeX,
  Wind,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/use-now";
import {
  autoRenewHaierKeys,
  configHaier,
  discoverHaier,
  haierCloudLogin,
  haierCloudLogout,
  haierCloudStatus,
  messageOf,
  pauseHaier,
  readHaier,
} from "@/lib/smartpilot/backend-api";
import { useSmartPilot } from "@/lib/smartpilot/store";
import {
  clampTemp,
  compressorWaitMs,
  formatWait,
  isEnabled,
  isOverridePaused,
} from "@/lib/smartpilot/climate";
import type {
  AcDevice,
  AcMode,
  AcPreviewState,
  CapabilityStatus,
  ControlMode,
  DeviceCommand,
  FanSpeed,
} from "@/lib/smartpilot/types";
import { CapabilityPill, ConnectionPill, DeviceGlyph, LiveNotice, Panel } from "./primitives";

const MODE_META: Record<AcMode, { label: string; icon: LucideIcon; ambient: string }> = {
  cool: {
    label: "Cool",
    icon: Snowflake,
    ambient: "from-sky-500/15 via-cyan-500/5 to-transparent border-sky-500/25",
  },
  dry: {
    label: "Dry",
    icon: Droplets,
    ambient: "from-teal-500/15 via-emerald-500/5 to-transparent border-teal-500/25",
  },
  fan: {
    label: "Fan",
    icon: Fan,
    ambient: "from-slate-400/15 via-slate-400/5 to-transparent border-glass-border",
  },
  auto: {
    label: "Auto",
    icon: Sparkles,
    ambient: "from-primary/15 via-primary/5 to-transparent border-primary/25",
  },
  heat: {
    label: "Heat",
    icon: Flame,
    ambient: "from-orange-500/15 via-amber-500/5 to-transparent border-orange-500/25",
  },
};

const FAN_LABEL: Record<FanSpeed, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Med",
  high: "High",
  turbo: "Turbo",
};

/** Fixed slot map. The two AC names and their slots are part of the product contract. */
type HaierSlot = "pro" | "ff";
const HAIER_SLOT_BY_NAME: Record<string, HaierSlot> = {
  "19HFAB T3 Pro": "pro",
  "FF Haier 19HFAB T3": "ff",
};

type StrongFeatureCommand = { type: "setFeature"; feature: "strong"; value: boolean };
type AcCommand = DeviceCommand | StrongFeatureCommand;
type AcPatch = Partial<AcPreviewState> & { strong?: boolean };

function asText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

interface DiscoveredHaier {
  ip?: string;
  device_id?: string;
  uplus_id?: string;
  product_code?: string;
  cloud_state_name?: string;
}
interface DiscoverReply {
  ok?: boolean;
  devices?: DiscoveredHaier[];
  error?: string;
}
interface ReadReply {
  ok?: boolean;
  status?: { strong?: unknown } & Record<string, unknown>;
  error?: string;
}
interface CloudStatusReply {
  logged_in?: boolean;
  zone?: string;
  last_renew?: string;
  slots?: Array<{ id?: string; key_version?: number | string }>;
  error?: string;
}
interface CloudLoginReply {
  ok?: boolean;
  renewed?: Record<string, number | string>;
  errors?: Record<string, string>;
  error?: string;
}

export function ControlModeSwitch({
  value,
  onChange,
  name,
  disabled,
}: {
  value: ControlMode;
  onChange: (m: ControlMode) => void;
  name: string;
  disabled?: boolean;
}) {
  const { t } = useSmartPilot();
  const opts: { v: ControlMode; label: string; icon: LucideIcon }[] = [
    { v: "manual", label: t("manual"), icon: Hand },
    { v: "auto", label: t("auto"), icon: Sparkles },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={`${name} control mode`}
      className="grid grid-cols-2 gap-1 rounded-2xl border border-glass-border bg-muted/40 p-1"
    >
      {opts.map((o) => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            disabled={disabled}
            aria-checked={active}
            onClick={() => onChange(o.v)}
            className={cn(
              "flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold text-muted-foreground transition-all active:scale-[0.98] disabled:opacity-50",
              active && o.v === "manual" && "bg-background text-foreground shadow-sm",
              active && o.v === "auto" && "bg-gradient-primary text-primary-foreground glow",
            )}
          >
            <o.icon className="size-4" aria-hidden />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function OptionGrid<T extends string>({
  label,
  options,
  value,
  caps,
  disabled,
  render,
  onSelect,
}: {
  label: string;
  options: T[];
  value: T;
  caps: Record<T, CapabilityStatus>;
  disabled?: boolean;
  render: (v: T) => { label: string; icon?: LucideIcon };
  onSelect: (v: T) => void;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </legend>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {options.map((o) => {
          const enabled = isEnabled(caps[o]);
          const active = value === o;
          const r = render(o);
          return (
            <button
              key={o}
              type="button"
              disabled={!enabled || disabled}
              aria-pressed={active}
              title={enabled ? undefined : `${r.label}: ${caps[o]}`}
              onClick={() => onSelect(o)}
              className={cn(
                "relative flex min-h-12 flex-col items-center justify-center gap-1 rounded-2xl border border-transparent bg-muted/35 px-1.5 py-2 text-xs font-medium transition-all active:scale-[0.97] hover:bg-muted/60",
                active && "border-primary/40 bg-primary/12 text-primary shadow-sm",
                !enabled &&
                  "hatch-disabled cursor-not-allowed text-muted-foreground opacity-50 hover:bg-muted/35",
              )}
            >
              {r.icon && <r.icon className="size-4" aria-hidden />}
              <span>{r.label}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function FeatureRow({
  icon: Icon,
  label,
  status,
  checked,
  disabled,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  status: CapabilityStatus;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  const enabled = isEnabled(status);
  const id = useId();
  return (
    <div
      className={cn(
        "flex min-h-13 items-center gap-3 px-3.5 py-2 transition-colors",
        !enabled && "opacity-55",
      )}
    >
      <Icon
        className={cn("size-4 shrink-0", enabled && checked ? "text-primary" : "text-muted-foreground")}
        aria-hidden
      />
      <label
        htmlFor={id}
        className={cn("min-w-0 flex-1 text-sm font-medium", !enabled && "text-muted-foreground")}
      >
        {label}
      </label>
      {!enabled && <CapabilityPill status={status} />}
      <Switch
        id={id}
        checked={enabled && checked}
        disabled={!enabled || disabled}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  );
}

/**
 * Per-slot LAN setup. Only non-secret identity fields are ever pre-filled from
 * discovery; the local key is masked, cleared immediately after save and never
 * rendered as text, logged or echoed in an error message.
 */
export function AcSetupDialog({
  device,
  slot,
  open,
  onOpenChange,
  onSaved,
}: {
  device: AcDevice;
  slot: HaierSlot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useSmartPilot();
  const [form, setForm] = useState({
    ip: "",
    device_id: "",
    local_key: "",
    key_version: "0",
    uplus_id: "",
    product_code: "",
  });
  const [host, setHost] = useState("");
  const [found, setFound] = useState<DiscoveredHaier[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const close = (next: boolean) => {
    if (!next) {
      setForm((prev) => ({ ...prev, local_key: "" }));
      setError("");
      setNotice("");
    }
    onOpenChange(next);
  };

  const setField = (key: keyof typeof form) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const scan = async () => {
    setScanning(true);
    setError("");
    setNotice("");
    setFound([]);
    try {
      const reply = (await discoverHaier(host.trim() || undefined)) as DiscoverReply;
      if (reply && reply.ok === false) {
        setError(reply.error || "LAN discovery is unavailable right now.");
        return;
      }
      const rows = Array.isArray(reply?.devices) ? reply.devices : [];
      setFound(rows);
      setNotice(
        rows.length
          ? `Found ${rows.length} Haier device${rows.length === 1 ? "" : "s"}. Tap Use to fill details, then paste your local key.`
          : "No devices answered on UDP 7083. You can still enter the LAN details manually.",
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setScanning(false);
    }
  };

  const useIdentity = (row: DiscoveredHaier) => {
    setForm((prev) => ({
      ...prev,
      ip: asText(row.ip) || prev.ip,
      device_id: asText(row.device_id) || prev.device_id,
      uplus_id: asText(row.uplus_id) || prev.uplus_id,
      product_code: asText(row.product_code) || prev.product_code,
    }));
  };

  const save = async () => {
    const ip = form.ip.trim();
    const deviceId = form.device_id.trim();
    const localKey = form.local_key.trim();
    if (!ip || !deviceId || !localKey) {
      setError("LAN IP, Wi-Fi module Device ID and local key are all required.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await configHaier({
        slot,
        ip,
        device_id: deviceId,
        local_key: localKey,
        key_version: Number(form.key_version) || 0,
        uplus_id: form.uplus_id.trim(),
        product_code: form.product_code.trim(),
      });
      setNotice("Connection saved. Switched to Manual mode — run a quick refresh to verify.");
      onSaved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setForm((prev) => ({ ...prev, local_key: "" }));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent aria-labelledby={`${device.id}-setup-title`}>
        <DialogHeader>
          <DialogTitle id={`${device.id}-setup-title`}>AC setup · {device.name}</DialogTitle>
          <DialogDescription>
            Direct LAN connection for slot “{slot}”. Your local key is stored encrypted on this
            device and never shown again.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <Label htmlFor={`${device.id}-scan-host`}>Discovery host (optional)</Label>
              <Input
                id={`${device.id}-scan-host`}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.50 — blank scans the LAN"
                inputMode="decimal"
              />
            </div>
            <Button
              type="button"
              size="touch"
              variant="glass"
              disabled={scanning || busy}
              aria-busy={scanning}
              onClick={() => void scan()}
            >
              <Search />
              {scanning ? "Scanning…" : "Scan LAN"}
            </Button>
          </div>

          {found.length > 0 && (
            <ul className="max-h-40 space-y-2 overflow-y-auto rounded-2xl border border-glass-border bg-background/40 p-2">
              {found.map((row, index) => (
                <li
                  key={`${asText(row.ip)}-${asText(row.device_id)}-${index}`}
                  className="flex items-center gap-2 rounded-xl px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {asText(row.ip) || "no ip"} · {asText(row.device_id) || "no module id"}
                    {asText(row.cloud_state_name) && ` · cloud ${asText(row.cloud_state_name)}`}
                  </span>
                  <Button type="button" size="touch" variant="glass" onClick={() => useIdentity(row)}>
                    Use
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={`${device.id}-ip`}>LAN IPv4 address</Label>
              <Input
                id={`${device.id}-ip`}
                value={form.ip}
                onChange={(e) => setField("ip")(e.target.value)}
                placeholder="192.168.1.50"
                inputMode="decimal"
              />
            </div>
            <div>
              <Label htmlFor={`${device.id}-device-id`}>Wi-Fi module Device ID</Label>
              <Input
                id={`${device.id}-device-id`}
                value={form.device_id}
                onChange={(e) => setField("device_id")(e.target.value)}
                placeholder="12–32 character module ID"
              />
            </div>
            <div>
              <Label htmlFor={`${device.id}-local-key`}>Haier local key</Label>
              <Input
                id={`${device.id}-local-key`}
                type="password"
                autoComplete="off"
                value={form.local_key}
                onChange={(e) => setField("local_key")(e.target.value)}
                placeholder="Paste from your local key sensor"
              />
            </div>
            <div>
              <Label htmlFor={`${device.id}-key-version`}>Local key version</Label>
              <Input
                id={`${device.id}-key-version`}
                type="number"
                min={0}
                max={65535}
                value={form.key_version}
                onChange={(e) => setField("key_version")(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor={`${device.id}-uplus-id`}>uplus ID (optional)</Label>
              <Input
                id={`${device.id}-uplus-id`}
                value={form.uplus_id}
                onChange={(e) => setField("uplus_id")(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor={`${device.id}-product-code`}>Product code (optional)</Label>
              <Input
                id={`${device.id}-product-code`}
                value={form.product_code}
                onChange={(e) => setField("product_code")(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="flex items-start gap-2 text-xs text-status-offline">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> {error}
            </p>
          )}
          {notice && (
            <p role="status" className="flex items-start gap-2 text-xs text-status-ok">
              <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden /> {notice}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="glass" size="touch" onClick={() => close(false)}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            variant="hero"
            size="touch"
            disabled={busy || scanning}
            aria-busy={busy}
            onClick={() => void save()}
          >
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            Save encrypted connection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Account-wide, optional cloud login. This only renews rotated local keys;
 * the panel shows booleans and key *versions* only — never key values.
 */
export function HaierCloudPanel() {
  const { t } = useSmartPilot();
  const rememberId = useId();
  const [status, setStatus] = useState<CloudStatusReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [zone, setZone] = useState("92");
  const [remember, setRemember] = useState(true);

  const load = async () => {
    try {
      const next = (await haierCloudStatus()) as CloudStatusReply;
      setStatus(next);
      if (next?.zone && next.zone !== "0") setZone(next.zone);
    } catch (e) {
      setError(messageOf(e));
      setStatus({ logged_in: false, slots: [] });
    }
  };

  useEffect(() => {
    void (async () => {
      await load();
      const renewed = await autoRenewHaierKeys();
      if (renewed.attempted) {
        setNotice(renewed.message);
        if (!renewed.ok) setError(renewed.message);
        await load();
      }
    })();
  }, []);

  const login = async () => {
    if (!username.trim() || !password) {
      setError("Haier account and password are required.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const reply = (await haierCloudLogin({
        username: username.trim(),
        password,
        zone: zone.trim() || "92",
        remember,
      })) as CloudLoginReply;
      const renewed: string[] = [];
      if (reply?.renewed && typeof reply.renewed === "object") {
        for (const [key, version] of Object.entries(reply.renewed)) {
          renewed.push(`${key.toUpperCase()} v${String(version)}`);
        }
      }
      const failed: string[] = [];
      if (reply?.errors && typeof reply.errors === "object") {
        for (const [key, message] of Object.entries(reply.errors)) {
          failed.push(`${key.toUpperCase()}: ${String(message)}`);
        }
      }
      setPassword("");
      if (reply && reply.ok === false) {
        setError(reply.error || failed.join(" · ") || "Key renewal did not complete.");
        return;
      }
      const parts = [...renewed, ...failed];
      setNotice(parts.length ? `Keys renewed: ${parts.join(" · ")}` : "Signed in; keys renewed.");
      setUsername("");
      setEditing(false);
    } catch (e) {
      setPassword("");
      setError(messageOf(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const logout = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await haierCloudLogout();
      setNotice("Signed out. Direct LAN control continues normally.");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const loggedIn = status?.logged_in === true;

  return (
    <Panel variant="inset" className="mt-4" aria-labelledby="haier-cloud-title">
      <p id="haier-cloud-title" className="flex items-center gap-2 text-sm font-semibold">
        <Cloud className="size-4 text-primary" aria-hidden /> Optional cloud key renewal
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Only needed if Haier rotates a local key. Direct LAN control works without an account or
        internet access.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Badge variant={loggedIn ? "ok" : "outline"}>
          {loggedIn ? "Account linked" : "No account linked"}
        </Badge>
        {typeof status?.zone === "string" && status.zone !== "0" && (
          <Badge variant="outline">Zone {status.zone}</Badge>
        )}
        {typeof status?.last_renew === "string" && status.last_renew && (
          <Badge variant="outline">Last renewed {status.last_renew}</Badge>
        )}
      </div>

      {status?.slots && status.slots.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {status.slots.map((entry, index) => (
            <li
              key={`${asText(entry.id)}-${index}`}
              className="rounded-xl border border-glass-border px-2 py-1 text-xs text-muted-foreground"
            >
              {asText(entry.id).toUpperCase() || `slot ${index + 1}`} · key v
              {String(entry.key_version ?? "?")}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-xs text-status-offline">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 flex items-start gap-2 text-xs text-status-ok">
          <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden /> {notice}
        </p>
      )}

      {loggedIn && !editing ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="touch"
            variant="glass"
            disabled={busy}
            onClick={() => {
              setError("");
              setNotice("");
              setPassword("");
              setEditing(true);
            }}
          >
            <LogIn /> Use another account
          </Button>
          <Button
            type="button"
            size="touch"
            variant="glass"
            disabled={busy}
            onClick={() => void logout()}
          >
            <LogOut /> Sign out
          </Button>
        </div>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <Label htmlFor="haier-cloud-username">Haier account (email / phone)</Label>
            <Input
              id="haier-cloud-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div>
            <Label htmlFor="haier-cloud-zone">Country dialling code</Label>
            <Input
              id="haier-cloud-zone"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              inputMode="numeric"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="haier-cloud-password">Password</Label>
            <Input
              id="haier-cloud-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="flex items-center justify-between rounded-xl bg-muted/30 px-3 py-2 sm:col-span-2">
            <Label htmlFor={rememberId} className="text-xs font-medium">
              Remember login on this device
            </Label>
            <Switch id={rememberId} checked={remember} onCheckedChange={setRemember} />
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button
              type="button"
              size="touch"
              variant="hero"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void login()}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              <LogIn /> Sign in &amp; renew keys
            </Button>
            {editing && (
              <Button
                type="button"
                size="touch"
                variant="glass"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setPassword("");
                }}
              >
                {t("cancel")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

export function AcControlPanel({ device }: { device: AcDevice }) {
  const {
    state,
    updateAc,
    t,
    log,
    connection,
    sendDeviceCommand,
    setAcControlMode,
    resumeAuto,
    refreshDevices,
  } = useSmartPilot();
  const s = state.ac[device.id] as AcPreviewState;
  const caps = device.capabilities;
  const now = useNow(1000);
  const slot: HaierSlot | undefined = HAIER_SLOT_BY_NAME[device.name];

  const [confirmPower, setConfirmPower] = useState<null | "on" | "off">(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [diagnosticBusy, setDiagnosticBusy] = useState<null | "read" | "pause">(null);
  const [diagnosticError, setDiagnosticError] = useState("");
  const [diagnosticNotice, setDiagnosticNotice] = useState("");
  const [strongOn, setStrongOn] = useState<boolean | null>(null);
  const [tempDraft, setTempDraft] = useState<number | null>(null);

  const paused = now > 0 && isOverridePaused(s, now);
  const waitMs = now > 0 ? compressorWaitMs(s, now) : 0;
  const on = s.power === "on";
  const displayTemp = tempDraft ?? s.targetTemp;
  const modeAmbient = on ? MODE_META[s.mode].ambient : "from-muted/40 to-transparent border-glass-border";

  /** Local state is updated only after the backend confirms the command. */
  const runCommands = async (
    commands: AcCommand[],
    patch: Partial<AcPreviewState>,
    title: string,
    extra: Partial<AcPreviewState>,
  ) => {
    setBusy(true);
    let ok = true;
    try {
      for (const command of commands) {
        const result = await sendDeviceCommand(device.id, command as DeviceCommand);
        if (!result.delivered) {
          ok = false;
          break;
        }
      }
      if (!ok) return;
      if (extra.overridePausedUntil && !paused) {
        log({
          kind: "safety",
          status: "warning",
          title: `Manual override on ${device.name} — Auto paused ${state.prefs.overridePauseMin} min`,
          deviceId: device.id,
        });
      }
      updateAc(device.id, { ...patch, ...extra }, `${device.name}: ${title}`);
    } finally {
      setBusy(false);
      setTempDraft(null);
    }
  };

  /** Any manual tweak while in Auto pauses Auto-Pilot for the configured window. */
  const change = async (patch: AcPatch, title: string) => {
    const extra: Partial<AcPreviewState> = {};
    if (s.controlMode === "auto") {
      extra.overridePausedUntil = new Date(
        Date.now() + state.prefs.overridePauseMin * 60_000,
      ).toISOString();
    }
    const commands: AcCommand[] = [];
    if (patch.power) commands.push({ type: "power", value: patch.power });
    if (patch.targetTemp !== undefined) {
      commands.push({ type: "setTemperature", value: patch.targetTemp });
    }
    if (patch.mode) commands.push({ type: "setMode", value: patch.mode });
    if (patch.fan) commands.push({ type: "setFan", value: patch.fan });
    if (patch.eco !== undefined) {
      commands.push({ type: "setFeature", feature: "eco", value: patch.eco });
    }
    if (patch.nightSleep !== undefined) {
      commands.push({ type: "setFeature", feature: "nightSleep", value: patch.nightSleep });
    }
    if (patch.quiet !== undefined) {
      commands.push({ type: "setFeature", feature: "quiet", value: patch.quiet });
    }
    if (patch.strong !== undefined) {
      commands.push({ type: "setFeature", feature: "strong", value: patch.strong });
    }
    const previewPatch: Partial<AcPreviewState> = { ...patch };
    delete (previewPatch as { strong?: boolean }).strong;
    await runCommands(commands, previewPatch, title, extra);
    // Re-read strong airflow state after commands complete, so UI reflects confirmed change.
    if (slot) {
      try {
        const reply = (await readHaier(slot)) as ReadReply;
        if (typeof reply?.status?.strong === "boolean") setStrongOn(reply.status.strong);
      } catch {
        // keep previous strongOn if read fails
      }
    }
  };

  const applyPower = (value: "on" | "off") => {
    if (value === "on" && compressorWaitMs(s, Date.now()) > 0) return;
    change(
      value === "off"
        ? { power: "off", lastCompressorStopAt: new Date().toISOString() }
        : { power: "on" },
      `power ${value}`,
    );
  };

  const requestPower = (value: "on" | "off") =>
    state.prefs.confirmAcPower ? setConfirmPower(value) : applyPower(value);

  const readNow = async () => {
    if (!slot) {
      setDiagnosticError("Unknown AC slot — controls are disabled.");
      return;
    }
    setDiagnosticBusy("read");
    setDiagnosticError("");
    setDiagnosticNotice("");
    try {
      const reply = (await readHaier(slot)) as ReadReply;
      if (typeof reply?.status?.strong === "boolean") setStrongOn(reply.status.strong);
      setDiagnosticNotice("Status refreshed from AC.");
      await refreshDevices();
    } catch (e) {
      setDiagnosticError(messageOf(e));
    } finally {
      setDiagnosticBusy(null);
    }
  };

  const pauseAuto = async () => {
    if (!slot) {
      setDiagnosticError("Unknown AC slot — controls are disabled.");
      return;
    }
    setDiagnosticBusy("pause");
    setDiagnosticError("");
    setDiagnosticNotice("");
    try {
      await pauseHaier(slot);
      setDiagnosticNotice("Auto-Pilot paused for 2 hours.");
      await refreshDevices();
    } catch (e) {
      setDiagnosticError(messageOf(e));
    } finally {
      setDiagnosticBusy(null);
    }
  };

  const setTemp = (v: number) => {
    const clamped = clampTemp(v, caps);
    setTempDraft(clamped);
    change({ targetTemp: clamped }, `target ${clamped}°C`);
  };

  const timeFmt = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <Panel className="@container animate-rise" aria-labelledby={`${device.id}-title`}>
      {/* Header */}
      <div className="flex items-start gap-3">
        <DeviceGlyph device={device} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 id={`${device.id}-title`} className="truncate text-lg font-semibold tracking-tight">
            {device.name}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {device.model}
            {device.roomTemperature.known ? ` · ${device.roomTemperature.value}°C room` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ConnectionPill status={device.connection} />
            <Badge variant={device.power.known ? "info" : "unknown"}>
              {device.power.known ? device.power.value.toUpperCase() : t("power_unknown")}
            </Badge>
          </div>
        </div>
        <Button
          type="button"
          variant="glass"
          size="icon-touch"
          aria-label={`Advanced & diagnostics for ${device.name}`}
          onClick={() => setDiagnosticsOpen(true)}
          className="relative shrink-0"
        >
          <Settings2 className="size-4" />
          {diagnosticError && (
            <span
              className="absolute right-2 top-2 size-2 rounded-full bg-status-offline"
              aria-hidden
            />
          )}
        </Button>
      </div>

      {/* Control Mode */}
      <div className="mt-5 space-y-2">
        <ControlModeSwitch
          name={device.name}
          value={s.controlMode}
          disabled={busy}
          onChange={(m) => {
            void (async () => {
              const result = await setAcControlMode(device.id, m);
              if (result.delivered) {
                updateAc(device.id, { controlMode: m, overridePausedUntil: null });
              }
            })();
          }}
        />
        <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          {s.controlMode === "manual" ? (
            <Hand className="size-3.5 shrink-0 text-primary" aria-hidden />
          ) : (
            <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
          )}
          <span>{s.controlMode === "manual" ? t("manual_note") : t("auto_note")}</span>
        </p>

        {s.controlMode === "auto" && paused && s.overridePausedUntil && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-status-preview/30 bg-status-preview/10 px-3.5 py-2.5 text-xs"
            role="status"
          >
            <Timer className="size-4 shrink-0 text-status-preview" aria-hidden />
            <span className="min-w-0 flex-1 font-medium">
              {t("override_paused", { time: timeFmt(s.overridePausedUntil) })}
            </span>
            <Button
              size="sm"
              variant="glass"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  const result = await resumeAuto(device.id);
                  if (result.delivered) updateAc(device.id, { overridePausedUntil: null });
                })();
              }}
            >
              {t("resume_auto")}
            </Button>
          </div>
        )}
      </div>

      {/* Primary Control Area */}
      <div className="mt-5 grid gap-6 @3xl:grid-cols-[1fr_1.15fr]">
        {/* Hero Temperature Tile */}
        <div
          className={cn(
            "flex flex-col items-center rounded-3xl border bg-gradient-to-b p-5 transition-colors duration-300",
            modeAmbient,
          )}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {on ? `${MODE_META[s.mode].label} · ${t("target")}` : `${t("target")} · Off`}
          </p>

          <div className="my-4 flex items-center gap-5">
            <Button
              variant="glass"
              size="icon-touch"
              aria-label="Decrease temperature"
              disabled={busy || displayTemp <= caps.minTemp}
              onClick={() => setTemp(displayTemp - 1)}
            >
              <Minus />
            </Button>
            <output
              aria-live="polite"
              className={cn(
                "font-display text-6xl font-semibold tabular tracking-tight transition-opacity sm:text-7xl",
                on ? "text-gradient" : "text-muted-foreground/70",
              )}
            >
              {displayTemp}°
            </output>
            <Button
              variant="glass"
              size="icon-touch"
              aria-label="Increase temperature"
              disabled={busy || displayTemp >= caps.maxTemp}
              onClick={() => setTemp(displayTemp + 1)}
            >
              <Plus />
            </Button>
          </div>

          <Slider
            className="w-full max-w-xs"
            min={caps.minTemp}
            max={caps.maxTemp}
            step={1}
            disabled={busy}
            value={[displayTemp]}
            onValueChange={(v) => setTempDraft(clampTemp(v[0] ?? s.targetTemp, caps))}
            onValueCommit={(v) => setTemp(v[0] ?? s.targetTemp)}
            aria-label={`${device.name} target temperature`}
          />
          <div className="mt-1.5 flex w-full max-w-xs justify-between text-[11px] text-muted-foreground tabular">
            <span>{caps.minTemp}°C</span>
            <span>{caps.maxTemp}°C</span>
          </div>

          <div className="mt-4 flex w-full items-center justify-between rounded-2xl bg-background/45 px-3.5 py-2.5 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Thermometer className="size-3.5" aria-hidden /> {t("room_temp")}
            </span>
            <span className="font-medium tabular text-foreground">
              {device.roomTemperature.known
                ? `${device.roomTemperature.value}°C`
                : t("no_sensor")}
            </span>
          </div>

          <Button
            className="mt-3.5 w-full"
            size="touch"
            variant={on ? "hero" : "glass"}
            disabled={busy || connection.state === "refreshing" || device.connection !== "online" || (!on && waitMs > 0)}
            aria-busy={busy}
            onClick={() => requestPower(on ? "off" : "on")}
            aria-pressed={on}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Power />}
            {on
              ? "Turn Off"
              : waitMs > 0
                ? t("compressor_wait", { time: formatWait(waitMs) })
                : "Turn On"}
          </Button>

          {waitMs > 0 && (
            <div className="mt-3 w-full space-y-1.5" role="status">
              <div className="flex items-center justify-between text-[11px] text-status-preview">
                <span className="flex items-center gap-1 font-medium">
                  <ShieldCheck className="size-3.5" aria-hidden /> {t("compressor_protection")}
                </span>
                <span className="tabular">{formatWait(waitMs)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-status-preview transition-all"
                  style={{ width: `${Math.min(100, Math.max(0, 100 - (waitMs / 180000) * 100))}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Mode, Fan & Features */}
        <div className={cn("space-y-5 transition-opacity duration-300", !on && "opacity-60")}>
          <OptionGrid
            label={t("mode")}
            options={["cool", "dry", "fan", "auto", "heat"] as AcMode[]}
            value={s.mode}
            caps={caps.modes}
            disabled={busy || device.connection !== "online"}
            render={(m) => MODE_META[m]}
            onSelect={(m) => change({ mode: m }, `mode ${MODE_META[m].label}`)}
          />
          <OptionGrid
            label={t("fan")}
            options={["auto", "low", "medium", "high", "turbo"] as FanSpeed[]}
            value={s.fan}
            caps={caps.fanSpeeds}
            disabled={busy || device.connection !== "online"}
            render={(f) => ({ label: FAN_LABEL[f], icon: Wind })}
            onSelect={(f) => change({ fan: f }, `fan ${FAN_LABEL[f]}`)}
          />

          {/* Grouped iOS-style feature list */}
          <div className="divide-y divide-glass-border overflow-hidden rounded-2xl border border-glass-border bg-muted/25">
            <FeatureRow
              icon={Leaf}
              label={t("eco")}
              status={caps.eco}
              checked={s.eco}
              disabled={busy || device.connection !== "online"}
              onChange={(v) => change({ eco: v }, `Eco ${v ? "on" : "off"}`)}
            />
            <FeatureRow
              icon={Moon}
              label={t("nightSleep")}
              status={caps.nightSleep}
              checked={s.nightSleep}
              disabled={busy || device.connection !== "online"}
              onChange={(v) => change({ nightSleep: v }, `Night Sleep ${v ? "on" : "off"}`)}
            />
            <FeatureRow
              icon={VolumeX}
              label={t("quiet")}
              status={caps.quiet}
              checked={s.quiet}
              disabled={busy || device.connection !== "online"}
              onChange={(v) => change({ quiet: v }, `Quiet ${v ? "on" : "off"}`)}
            />
          </div>
        </div>
      </div>

      <LiveNotice className="mt-4" />

      {/* Progressive Disclosure: Advanced & Diagnostics Dialog */}
      <Dialog open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen}>
        <DialogContent aria-labelledby={`${device.id}-diag-title`}>
          <DialogHeader>
            <DialogTitle id={`${device.id}-diag-title`}>{device.name} · Advanced</DialogTitle>
            <DialogDescription>
              Direct LAN diagnostics and command-only features for slot{" "}
              {slot ? slot.toUpperCase() : "unknown"}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="touch"
                variant="glass"
                disabled={diagnosticBusy !== null || busy}
                aria-busy={diagnosticBusy === "read"}
                onClick={() => void readNow()}
              >
                <RefreshCw className={cn(diagnosticBusy === "read" && "animate-spin")} />
                Refresh status
              </Button>
              <Button
                type="button"
                size="touch"
                variant="glass"
                disabled={diagnosticBusy !== null || busy}
                aria-busy={diagnosticBusy === "pause"}
                onClick={() => void pauseAuto()}
              >
                <Timer /> Pause Auto 2h
              </Button>
            </div>

            <div className="flex items-center gap-3 rounded-2xl border border-glass-border bg-muted/30 p-3">
              <Zap className="size-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Strong airflow</p>
                <p className="text-xs text-muted-foreground">
                  {strongOn === null
                    ? "Tap Refresh status to check current state."
                    : `Currently ${strongOn ? "on" : "off"}.`}
                </p>
              </div>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant={strongOn === true ? "hero" : "glass"}
                  disabled={busy || diagnosticBusy !== null || device.connection !== "online"}
                  aria-label={`Turn strong airflow on for ${device.name}`}
                  onClick={() => change({ strong: true }, "Strong airflow on")}
                >
                  On
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={strongOn === false ? "hero" : "glass"}
                  disabled={busy || diagnosticBusy !== null || device.connection !== "online"}
                  aria-label={`Turn strong airflow off for ${device.name}`}
                  onClick={() => change({ strong: false }, "Strong airflow off")}
                >
                  Off
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-2xl border border-glass-border bg-muted/30 px-3.5 py-2.5 text-xs">
              <span className="text-muted-foreground">{t("energy_info")}</span>
              <CapabilityPill status={caps.energyMetering} />
            </div>

            {diagnosticError && (
              <p role="alert" className="flex items-start gap-2 text-xs text-status-offline">
                <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> {diagnosticError}
              </p>
            )}
            {diagnosticNotice && (
              <p role="status" className="flex items-start gap-2 text-xs text-status-ok">
                <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden /> {diagnosticNotice}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="glass" size="touch" onClick={() => setDiagnosticsOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Power Confirmation */}
      <AlertDialog open={confirmPower !== null} onOpenChange={(o) => !o && setConfirmPower(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Turn {device.name} {confirmPower}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmPower === "off"
                ? "For compressor safety, the AC will wait 3 minutes before it can be turned back on."
                : "This will start the AC with your current target temperature and mode."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmPower) applyPower(confirmPower);
                setConfirmPower(null);
              }}
            >
              {confirmPower === "off" ? "Turn Off" : "Turn On"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

export function AcSummaryCard({ device }: { device: AcDevice }) {
  const { state, t } = useSmartPilot();
  const s = state.ac[device.id] as AcPreviewState;
  const on = s.power === "on";
  return (
    <Panel pad="sm" className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <DeviceGlyph device={device} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{device.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {device.roomTemperature.known
              ? `${device.roomTemperature.value}°C room`
              : t("room_not_set")}
          </p>
        </div>
        <Badge variant={s.controlMode === "auto" ? "info" : "outline"}>
          {s.controlMode === "auto" ? (
            <Sparkles className="size-3" aria-hidden />
          ) : (
            <Hand className="size-3" aria-hidden />
          )}
          {s.controlMode === "auto" ? t("auto") : t("manual")}
        </Badge>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("target")}
          </p>
          <p className={cn("font-display text-4xl font-semibold tabular", !on && "text-muted-foreground")}>
            {s.targetTemp}°
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p>
            {MODE_META[s.mode].label} · {FAN_LABEL[s.fan]}
          </p>
          <p className={cn("font-medium", on && "text-foreground")}>{on ? "On" : "Off"}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ConnectionPill status={device.connection} />
        <Button asChild variant="ghost" size="sm">
          <Link to="/climate">
            {t("openClimate")} <ArrowRight />
          </Link>
        </Button>
      </div>
    </Panel>
  );
}
