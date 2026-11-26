import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileDown,
  FileUp,
  Info,
  Languages,
  Link2,
  Lock,
  MonitorSmartphone,
  Settings2,
  Moon,
  Network,
  Palette,
  QrCode,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sun,
  Trash2,
  Unplug,
  UserLock,
  Users,
  Wifi,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CapabilityPill,
  ConnectionPill,
  DeviceGlyph,
  PageHeader,
  Panel,
  PanelTitle,
} from "@/components/sp/primitives";
import { AC_DEVICES, DEVICES } from "@/lib/smartpilot/devices";
import { AcSetupDialog } from "@/components/sp/AcControl";
import { adapter } from "@/lib/smartpilot/adapter";
import { useSmartPilot } from "@/lib/smartpilot/store";
import type { Language, ThemePref } from "@/lib/smartpilot/types";
import { cn } from "@/lib/utils";
import {
  autoCheckUpdates,
  autoRenewHaierKeys,
  BACKUP_URL,
  checkUpdates,
  ensureLocal,
  familyCheck,
  familyConfig,
  familyDisconnect,
  familyStatus,
  getAuthState,
  getDiagnostics,
  getSupportReport,
  getUpdates,
  haierCloudLogin,
  haierCloudLogout,
  haierCloudStatus,
  loginPoll,
  loginStart,
  logout,
  messageOf,
  nativeCall,
  nativeUpdateState,
  registerUpdateCallback,
  restoreBackup,
} from "@/lib/smartpilot/backend-api";


interface RemoteConfig {
  tailscaleUrl?: string;
  homeAssistant?: boolean;
}

function readRemoteConfig(): RemoteConfig {
  try {
    const element = document.getElementById("pilot-remote-config");
    const parsed = element ? (JSON.parse(element.textContent || "{}") as RemoteConfig) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function copyRemoteUrl(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const input = document.createElement("textarea");
      input.value = value;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(input);
      return ok;
    } catch {
      return false;
    }
  }
}

const SETTINGS_SECTIONS = [
  "Appearance", "Network", "Backup", "Updates", "Family Hub", "Haier keys",
  "Security", "Support", "Remote", "Preferences", "Safety", "About",
];

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Smart Pilot Titanium Control" },
      {
        name: "description",
        content:
          "Theme, language, local backend, backup, updates, family sharing, Haier cloud keys, privacy and safety settings.",
      },
      { property: "og:title", content: "Settings — Smart Pilot Titanium Control" },
      {
        property: "og:description",
        content: "Appearance, integrations, privacy, safety and live backend settings.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SettingsPage,
});

const APP_VERSION = "local-live";
const REPO = "https://github.com/Muhammadusamataj/Smartpilot-local-first-home";

type Obj = Record<string, unknown>;
type FamilyMode = "off" | "hub" | "client";

/** All backend replies are untrusted JSON; coerce every field before display. */
function asObj(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function timeLabel(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "unknown" : parsed.toLocaleString();
  }
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "never";
  const date = new Date(seconds > 1e12 ? seconds : seconds * 1000);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function familyModeOf(value: unknown): FamilyMode {
  return value === "hub" || value === "client" ? value : "off";
}
function haierSlotLabel(id: string): string {
  if (id === "pro") return "19HFAB T3 Pro";
  if (id === "ff") return "FF Haier 19HFAB T3";
  return id || "Unknown slot";
}
function hasNativeMethod(method: string): boolean {
  if (typeof window === "undefined") return false;
  const bridge = (window as unknown as Record<string, unknown>)["PilotNative"];
  return !!bridge && typeof bridge === "object" &&
    typeof (bridge as Record<string, unknown>)[method] === "function";
}
function hasNativeBridge(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = (window as unknown as Record<string, unknown>)["PilotNative"];
  return !!bridge && typeof bridge === "object";
}

interface Action {
  busy: boolean;
  error: string;
  message: string;
  run: (fn: () => Promise<unknown>, success?: (result: unknown) => string) => Promise<unknown>;
  notify: (message: string) => void;
}

/** One busy/error/message triple per panel; every write goes through run(). */
function useAction(): Action {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const run = useCallback(async (fn: () => Promise<unknown>, success?: (result: unknown) => string) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await fn();
      setMessage(success ? success(result) : "Done.");
      return result;
    } catch (cause) {
      setError(messageOf(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  const notify = useCallback((text: string) => {
    setError("");
    setMessage(text);
  }, []);
  return { busy, error, message, run, notify };
}

function StateNote({ action }: { action: Action }) {
  return (
    <div className="min-h-[1.25rem] space-y-1 text-xs" aria-live="polite">
      {action.busy && <p role="status" className="text-muted-foreground">Working…</p>}
      {action.error && (
        <p role="alert" className="flex items-start gap-1.5 text-status-offline">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> {action.error}
        </p>
      )}
      {action.message && (
        <p role="status" className="flex items-start gap-1.5 text-status-ok">
          <CheckCircle2 className="mt-px size-3.5 shrink-0" aria-hidden /> {action.message}
        </p>
      )}
    </div>
  );
}

function PanelRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-glass-border bg-muted/30 px-3 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-medium">{children}</span>
    </div>
  );
}

function PreBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-glass-border bg-muted/40 p-3 text-xs leading-relaxed">
      {text}
    </pre>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { v: T; label: string; icon?: LucideIcon }[];
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid gap-1 rounded-2xl border border-glass-border bg-muted/40 p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={cn(
            "flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-medium text-muted-foreground",
            value === o.v && "bg-background text-foreground shadow-sm",
          )}
        >
          {o.icon && <o.icon className="size-4" aria-hidden />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({
  title,
  body,
  checked,
  onChange,
  locked,
}: {
  title: string;
  body: string;
  checked: boolean;
  onChange?: (v: boolean) => void;
  locked?: boolean;
}) {
  return (
    <div className="flex items-start gap-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {locked && (
            <Badge variant="outline">
              <Lock className="size-3" aria-hidden /> Locked
            </Badge>
          )}
        </p>
        <p className="text-xs text-muted-foreground">{body}</p>
      </div>
      <Switch
        checked={checked}
        disabled={!!locked}
        {...(onChange ? { onCheckedChange: onChange } : {})}
        aria-label={title}
      />
    </div>
  );
}

function ConfirmButton({
  label,
  icon: Icon,
  title,
  body,
  onConfirm,
  className,
  disabled,
  variant = "glass",
  confirmLabel = "Confirm",
}: {
  label: string;
  icon: LucideIcon;
  title: string;
  body: string;
  onConfirm: () => void | Promise<void>;
  className?: string;
  disabled?: boolean;
  variant?: ButtonProps["variant"];
  confirmLabel?: string;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant={variant} size="touch" className={className} disabled={disabled}>
          <Icon /> {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            {...(variant === "destructive"
              ? { className: "bg-destructive text-destructive-foreground hover:bg-destructive/90" }
              : variant === "warning"
                ? { className: "bg-warning text-warning-foreground hover:brightness-105" }
                : {})}
            onClick={() => { void onConfirm(); }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const INTEGRATIONS = [
  {
    name: "Local-first Android backend",
    body: "Uses this app's /api/local and /api/haier routes. Reads are verified before use.",
    status: "Linked",
  },
  {
    name: "Smart Life / Tuya",
    body: "Devices come from the local backend. No cloud account or credentials in this UI.",
    status: "Local",
  },
  {
    name: "Haier HaiSmart",
    body: "Optional cloud sign-in renews rotated keys; direct LAN control stays cloudless.",
    status: "Local",
  },
  {
    name: "Home Assistant",
    body: "Optional bridge and ingress. See Remote access below.",
    status: "Optional",
  },
];

function SettingsPage() {
  const [remoteConfig] = useState<RemoteConfig>(() => readRemoteConfig());
  const [remoteFamily, setRemoteFamily] = useState<Obj | null>(null);
  const [remoteCopied, setRemoteCopied] = useState(false);

  const { t, state, connection, refreshDevices, setPrefs, resetDemo } = useSmartPilot();
  useEffect(() => {
    let alive = true;
    void familyStatus()
      .then((value) => { if (alive) setRemoteFamily(asObj(value)); })
      .catch(() => { if (alive) setRemoteFamily(null); });
    return () => { alive = false; };
  }, []);
  const p = state.prefs;
  const [sectionFilter, setSectionFilter] = useState("");
  useEffect(() => {
    const needle = sectionFilter.trim().toLowerCase();
    const nodes = document.querySelectorAll<HTMLElement>("[data-settings-section]");
    nodes.forEach((node) => {
      const haystack = (node.dataset["settingsSection"] ?? "").toLowerCase();
      node.hidden = needle.length > 0 && !haystack.includes(needle);
    });
  }, [sectionFilter, state.prefs.theme, state.prefs.language]);

  const tailnetUrl =
    typeof remoteConfig["tailscaleUrl"] === "string" ? remoteConfig["tailscaleUrl"] : "";
  const directOn = remoteFamily?.["direct_mode"] === true;
  const haAvailable = remoteConfig["homeAssistant"] === true;
  const lanIp =
    typeof remoteFamily?.["lan_ip"] === "string" ? remoteFamily["lan_ip"] : "";

  // --- Network / diagnostics -------------------------------------------------
  const networkAction = useAction();
  const [diagId, setDiagId] = useState("");
  const [diagText, setDiagText] = useState<string | null>(null);

  const viewDiagnostics = async () => {
    const id = diagId.trim();
    if (!id) {
      networkAction.notify("Enter a device ID first.");
      return;
    }
    const result = await networkAction.run(() => getDiagnostics(id), () => "Diagnostics loaded.");
    setDiagText(result ? JSON.stringify(result, null, 2) : null);
  };

  // --- Backup / restore ------------------------------------------------------
  const backupAction = useAction();
  const [restoreFile, setRestoreFile] = useState<File | null>(null);

  const runRestore = async () => {
    if (!restoreFile) return;
    const file = restoreFile;
    const result = await backupAction.run(
      () => restoreBackup(file),
      (value) => `Restored ${asArray(asObj(value)["restored"]).length} file(s).`,
    );
    if (result) {
      setRestoreFile(null);
      const input = document.getElementById("restore-file") as HTMLInputElement | null;
      if (input) input.value = "";
    }
  };

  // --- App updates -----------------------------------------------------------
  const updateAction = useAction();
  const [updateInfo, setUpdateInfo] = useState<Obj | null>(null);
  const [nativeUpdate, setNativeUpdate] = useState<Obj | null>(null);

  useEffect(() => {
    let alive = true;
    void getUpdates()
      .then((value) => { if (alive) setUpdateInfo(asObj(value)); })
      .catch(() => { /* keep the last known state */ });
    void autoCheckUpdates()
      .then((value) => {
        if (alive && value) setUpdateInfo(asObj(value));
      })
      .catch(() => { /* background check is best-effort */ });
    nativeCall("PilotNative", "checkUpdate");
    const previous = (window as unknown as Record<string, unknown>)["pilotUpdateResult"];
    registerUpdateCallback((result) => {
      setNativeUpdate((current) => ({ ...(current ?? {}), ...result }));
    });
    setNativeUpdate(nativeUpdateState());
    return () => {
      alive = false;
      (window as unknown as Record<string, unknown>)["pilotUpdateResult"] = previous;
    };
  }, []);

  const refreshUpdates = useCallback(async () => {
    try {
      setUpdateInfo(asObj(await getUpdates()));
    } catch {
      /* keep the last known state */
    }
    setNativeUpdate(nativeUpdateState());
  }, []);

  const checkForUpdate = async () => {
    if (hasNativeMethod("checkUpdate")) {
      nativeCall("PilotNative", "checkUpdate");
      updateAction.notify("Update check started in the Android app.");
      await refreshUpdates();
      return;
    }
    const result = await updateAction.run(
      checkUpdates,
      (value) => asObj(value)["available"] === true ? "An update is available." : "No newer release found.",
    );
    if (result) setUpdateInfo(asObj(result));
  };

  const installUpdate = async () => {
    if (!hasNativeMethod("installUpdate")) {
      updateAction.notify("Install is available in the Android app only.");
      return;
    }
    nativeCall("PilotNative", "installUpdate");
    updateAction.notify("Install requested. Keep the app open; the result will appear here.");
  };

  const rollbackUpdate = async () => {
    if (!hasNativeMethod("rollback")) {
      updateAction.notify("Rollback is available in the Android app only.");
      return;
    }
    nativeCall("PilotNative", "rollback");
    updateAction.notify("Rollback requested. Keep the app open; the result will appear here.");
  };

  const openInstallPermission = () => {
    if (!hasNativeMethod("openInstallPermission")) {
      updateAction.notify("Open Android settings to allow installs from this app.");
      return;
    }
    nativeCall("PilotNative", "openInstallPermission");
  };

  const native = nativeUpdate ?? {};
  const info = updateInfo ?? {};
  const nativeReady = hasNativeBridge();
  const nativeCurrent = str(native["current"]);
  const nativeLatest = str(native["latest"]);
  const nativeAvailable = native["available"] === true;
  const canInstall = native["canInstall"] === true;
  const hasBackup = native["hasBackup"] === true;
  const nativeBusy = native["busy"] === true;
  const nativeError = str(native["error"]);
  const httpCurrent = str(info["current_version"]);
  const httpLatest = str(info["latest_version"]);
  const httpAvailable = info["available"] === true;
  const releaseStatus = str(info["status"]) || (nativeReady ? "android" : "unknown");
  const updateUrl = str(info["update_url"]) || str(info["release_url"]);
  const waitingForRelease = info["waiting_for_release"] === true;
  const updateAvailable = nativeReady ? nativeAvailable : httpAvailable;
  const latestLabel = httpLatest || nativeLatest || (httpAvailable ? "available" : "up to date");

  // --- Family Hub ------------------------------------------------------------
  const familyAction = useAction();
  const [family, setFamily] = useState<Obj | null>(null);
  const [pendingMode, setPendingMode] = useState<FamilyMode | null>(null);
  const [hubUrl, setHubUrl] = useState("");
  const [hubUser, setHubUser] = useState("");
  const [hubPass, setHubPass] = useState("");

  useEffect(() => {
    let alive = true;
    void familyStatus()
      .then((value) => { if (alive) setFamily(asObj(value)); })
      .catch(() => { if (alive) setFamily({ mode: "off" }); });
    return () => { alive = false; };
  }, []);

  const familyMode = familyModeOf(family?.["mode"]);
  const familyDirect = family?.["direct_mode"] === true;
  const familyConnected = family?.["connected"] === true;
  const familyLanIp = str(family?.["lan_ip"]);

  const refreshFamily = async () => {
    try {
      setFamily(asObj(await familyStatus()));
    } catch {
      /* keep the last known state */
    }
  };

  const applyFamilyMode = async (mode: FamilyMode) => {
    setPendingMode(null);
    const result = await familyAction.run(
      () => familyConfig({ mode }),
      () => `Family mode set to ${mode}.`,
    );
    if (result) setFamily(asObj(result));
  };

  const connectFamily = async () => {
    const payload = {
      mode: "client",
      hub_url: hubUrl.trim(),
      username: hubUser,
      password: hubPass,
    };
    if (!payload.hub_url || !payload.username || !payload.password) {
      familyAction.notify("Enter the hub address, username and password.");
      return;
    }
    const result = await familyAction.run(
      async () => {
        await familyConfig(payload);
        return familyCheck();
      },
      (value) => {
        const check = asObj(value);
        return check["ok"] === true ? "Connected to hub." : str(check["error"]) || "Hub check failed.";
      },
    );
    setHubPass("");
    if (result) await refreshFamily();
  };

  const checkFamily = async () => {
    const result = await familyAction.run(
      familyCheck,
      (value) => {
        const check = asObj(value);
        return check["ok"] === true ? "Hub reachable." : str(check["error"]) || "Hub not reachable.";
      },
    );
    if (result) await refreshFamily();
  };

  const disconnectFamily = async () => {
    const result = await familyAction.run(familyDisconnect, () => "Disconnected. No credentials remain here.");
    if (result) setFamily(asObj(result));
  };

  // --- Haier cloud keys ------------------------------------------------------
  const cloudAction = useAction();
  const [cloudStatus, setCloudStatus] = useState<Obj | null>(null);
  const [acSetupDevice, setAcSetupDevice] = useState<(typeof AC_DEVICES)[number] | null>(null);
  const [cloudUser, setCloudUser] = useState("");
  const [cloudPass, setCloudPass] = useState("");
  const [cloudZone, setCloudZone] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const value = await haierCloudStatus();
        if (alive) setCloudStatus(asObj(value));
      } catch {
        if (alive) setCloudStatus({ logged_in: false, slots: [] });
      }
      const renewed = await autoRenewHaierKeys();
      if (renewed.attempted && alive) {
        try {
          setCloudStatus(asObj(await haierCloudStatus()));
        } catch {
          // Keep the previous status; auto-renew failure is reported by the hook.
        }
      }
    })();
    return () => { alive = false; };
  }, []);

  const cloudLoggedIn = cloudStatus?.["logged_in"] === true;
  const cloudSlots = asArray(cloudStatus?.["slots"]);

  const submitCloud = async () => {
    if (!cloudUser.trim() || !cloudPass) {
      cloudAction.notify("Enter your HaiSmart username and password.");
      return;
    }
    const result = await cloudAction.run(
      () => haierCloudLogin({
        username: cloudUser.trim(),
        password: cloudPass,
        zone: cloudZone.trim(),
        remember: true,
      }),
      (value) => {
        const reply = asObj(value);
        const renewed = asObj(reply["renewed"]);
        const errors = asObj(reply["errors"]);
        const parts: string[] = [];
        if (Object.keys(renewed).length) parts.push(`Renewed ${Object.keys(renewed).length} slot(s)`);
        if (Object.keys(errors).length) parts.push(`${Object.keys(errors).length} slot error(s)`);
        if (reply["error"]) parts.push(str(reply["error"]));
        return parts.join(" · ") || "Sign-in finished.";
      },
    );
    setCloudPass("");
    if (result) {
      try {
        setCloudStatus(asObj(await haierCloudStatus()));
      } catch {
        /* keep the last known state */
      }
    }
  };

  const logoutCloud = async () => {
    const result = await cloudAction.run(haierCloudLogout, () => "Signed out. Direct LAN control is unchanged.");
    if (result) setCloudStatus(asObj(result));
  };

  // --- Security / QR login ---------------------------------------------------
  const authAction = useAction();
  const [auth, setAuth] = useState<Obj | null>(null);
  const [userCode, setUserCode] = useState("");
  const [qr, setQr] = useState("");
  const [qrStatus, setQrStatus] = useState("");
  const pollTimer = useRef<number | null>(null);
  const pollToken = useRef("");
  const pollDeadline = useRef(0);
  const pollFn = useRef<() => Promise<void>>(async () => {});

  const stopPoll = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    pollToken.current = "";
  }, []);

  useEffect(() => {
    let alive = true;
    void getAuthState()
      .then((value) => { if (alive) setAuth(asObj(value)); })
      .catch(() => { if (alive) setAuth(null); });
    return () => { alive = false; stopPoll(); };
  }, [stopPoll]);

  const refreshAuthState = useCallback(async () => {
    try {
      setAuth(asObj(await getAuthState()));
    } catch {
      setAuth(null);
    }
  }, []);

  const pollOnce = useCallback(async () => {
    const token = pollToken.current;
    if (!token) return;
    if (Date.now() > pollDeadline.current) {
      stopPoll();
      setQr("");
      setQrStatus("QR expired. Generate a new code.");
      return;
    }
    try {
      const reply = asObj(await loginPoll(token));
      const status = str(reply["status"]);
      if (status === "confirmed") {
        stopPoll();
        setQr("");
        setQrStatus("Signed in successfully.");
        setUserCode("");
        await refreshAuthState();
      } else if (status === "expired") {
        stopPoll();
        setQr("");
        setQrStatus("QR expired. Generate a new code.");
      } else {
        setQrStatus("Waiting for Smart Life scan…");
      }
    } catch (cause) {
      const message = messageOf(cause);
      stopPoll();
      setQr("");
      setQrStatus(
        message.includes("http_404") || message.includes("expired")
          ? "QR expired. Generate a new code."
          : `Sign-in check failed: ${message}`,
      );
    }
  }, [refreshAuthState, stopPoll]);
  pollFn.current = pollOnce;

  const startLogin = async () => {
    const code = userCode.trim();
    if (!code) {
      authAction.notify("Enter your user code first.");
      return;
    }
    const result = await authAction.run(
      () => loginStart(code),
      () => "QR code ready. Scan it in the Smart Life app.",
    );
    const reply = result ? asObj(result) : {};
    const token = str(reply["token"]);
    const image = str(reply["qr"]);
    stopPoll();
    if (!token || !image) {
      setQr("");
      setQrStatus("");
      return;
    }
    setQr(image);
    setQrStatus("Waiting for Smart Life scan…");
    pollToken.current = token;
    pollDeadline.current = Date.now() + 180000;
    pollTimer.current = window.setInterval(() => { void pollFn.current(); }, 2000);
  };

  const cancelLogin = () => {
    stopPoll();
    setQr("");
    setQrStatus("");
  };

  const doLogout = async () => {
    const result = await authAction.run(logout, () => "Signed out.");
    cancelLogin();
    if (result) await refreshAuthState();
  };

  const loggedIn = auth?.["logged_in"] === true;
  const qrActive = qr.length > 0;

  // --- Support report --------------------------------------------------------
  const supportAction = useAction();
  const [supportDevice, setSupportDevice] = useState("");
  const [reportText, setReportText] = useState("");

  const makeReport = async () => {
    const id = supportDevice.trim();
    if (!id) {
      supportAction.notify("Enter a device ID first.");
      return;
    }
    const result = await supportAction.run(
      () => getSupportReport(id),
      () => "Support report generated.",
    );
    if (!result) {
      setReportText("");
      return;
    }
    const report = asObj(asObj(result)["report"]);
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (hasNativeMethod("saveDownload")) {
      try {
        nativeCall(
          "PilotNative",
          "saveDownload",
          `smartpilot-support-${stamp()}.json`,
          btoa(unescape(encodeURIComponent(text))),
          "application/json",
        );
        supportAction.notify("Support report saved to Downloads/SmartPilot.");
        setReportText("");
      } catch (cause) {
        supportAction.notify(`Could not save the file: ${messageOf(cause)}. Showing JSON below.`);
        setReportText(text);
      }
    } else {
      supportAction.notify("Native saving is unavailable here. Report JSON is shown below.");
      setReportText(text);
    }
  };

  const knownIds = [...DEVICES.map((device) => device.id), "pro", "ff"];

  return (
    <div>
      <PageHeader title={t("settings_title")} sub={t("settings_sub")} />
      <div className="mb-5 space-y-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={sectionFilter}
            onChange={(event) => setSectionFilter(event.target.value)}
            placeholder="Find a setting (backup, remote, update…)"
            aria-label="Find a setting"
            className="glass h-12 rounded-2xl pl-10"
          />
          {sectionFilter && (
            <Button
              type="button"
              variant="ghost"
              size="icon-touch"
              aria-label="Clear settings filter"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              onClick={() => setSectionFilter("")}
            >
              <X />
            </Button>
          )}
        </div>
        <div
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:mx-0 sm:flex-wrap sm:px-0"
          role="group"
          aria-label="Settings sections"
        >
          <Button
            type="button"
            variant="chip"
            size="sm"
            className="h-10 shrink-0 px-4"
            aria-pressed={!sectionFilter}
            onClick={() => setSectionFilter("")}
          >
            All
          </Button>
          {SETTINGS_SECTIONS.map((section) => (
            <Button
              key={section}
              type="button"
              variant="chip"
              size="sm"
              className="h-10 shrink-0 px-4"
              aria-pressed={sectionFilter === section.toLowerCase()}
              onClick={() => setSectionFilter(
                sectionFilter === section.toLowerCase() ? "" : section.toLowerCase(),
              )}
            >
              {section}
            </Button>
          ))}
        </div>
        {sectionFilter && (
          <p className="text-xs text-muted-foreground" role="status">
            Showing sections matching “{sectionFilter}”.
          </p>
        )}
      </div>


      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel data-settings-section="appearance appearance theme language colours dark light">
          <PanelTitle icon={Palette}>Appearance</PanelTitle>
          <div className="space-y-5">
            <div>
              <p className="mb-2 text-sm font-medium">Theme</p>
              <Segmented<ThemePref>
                label="Theme"
                value={p.theme}
                onChange={(v) => setPrefs({ theme: v })}
                options={[
                  { v: "dark", label: t("theme_dark"), icon: Moon },
                  { v: "light", label: t("theme_light"), icon: Sun },
                  { v: "system", label: t("theme_system"), icon: MonitorSmartphone },
                ]}
              />
            </div>
            <div>
              <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                <Languages className="size-4 text-primary" aria-hidden /> {t("language")}
              </p>
              <Segmented<Language>
                label={t("language")}
                value={p.language}
                onChange={(v) => setPrefs({ language: v })}
                options={[
                  { v: "en", label: "English" },
                  { v: "ur", label: "Roman Urdu" },
                ]}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Display preferences are saved on this device.
            </p>
          </div>
        </Panel>

        <Panel data-settings-section="integration integration status local backend">
          <PanelTitle icon={Network}>Integration status</PanelTitle>
          <ul className="space-y-2">
            {INTEGRATIONS.map((item) => (
              <li
                key={item.name}
                className="flex items-start gap-3 rounded-2xl border border-glass-border bg-muted/30 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{item.name}</p>
                  <p className="text-xs text-muted-foreground">{item.body}</p>
                </div>
                <Badge variant="info">{item.status}</Badge>
              </li>
            ))}
          </ul>
          <div className="mt-4 rounded-2xl border border-glass-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Active adapter: {adapter.label}</p>
            <p>
              Live hardware access:{" "}
              {adapter.isLive
                ? "yes — writes stay behind the backend's verified-read and approval gates"
                : "no — every command returns “not delivered”"}.
            </p>
          </div>
        </Panel>

        <Panel data-settings-section="network network reconnect scan ensure diagnostics">
          <PanelTitle icon={Wifi}>Network &amp; reconnect</PanelTitle>
          <div className="space-y-4">
            <div className="space-y-2 rounded-2xl border border-glass-border bg-muted/30 p-3">
              <PanelRow label="Backend">
                <Badge variant={connection.state === "live" ? "ok" : "unknown"}>
                  {connection.state === "live" ? "Verified" : connection.state}
                </Badge>
              </PanelRow>
              <PanelRow label="Last refreshed">{timeLabel(new Date(connection.refreshedAt ?? 0).getTime())}</PanelRow>
              <p className="text-xs text-muted-foreground">{connection.message}</p>
            </div>
            <Button
              variant="glass"
              size="touch"
              disabled={connection.state === "refreshing"}
              onClick={() => void refreshDevices()}
            >
              <Activity /> Refresh verified status
            </Button>
            <ConfirmButton
              label="Ensure LAN connection"
              icon={Network}
              title="Start LAN recovery?"
              body="Reconnect only devices with a verified read failure, at their saved address. No device command is sent."
              onConfirm={() => { void networkAction.run(ensureLocal, () => "LAN check started."); }}
              disabled={networkAction.busy}
            />
            <StateNote action={networkAction} />
            <div className="space-y-2">
              <Label htmlFor="diag-device">Device ID for diagnostics</Label>
              <Input
                id="diag-device"
                list="known-device-ids"
                value={diagId}
                onChange={(event) => setDiagId(event.target.value)}
                placeholder="Backend device ID, e.g. plug1 or pro"
                autoComplete="off"
              />
              <datalist id="known-device-ids">
                {knownIds.map((id) => <option key={id} value={id} />)}
              </datalist>
            </div>
            <Button
              variant="glass"
              size="touch"
              disabled={!diagId.trim() || networkAction.busy}
              onClick={() => void viewDiagnostics()}
            >
              <FileDown /> View diagnostics
            </Button>
          </div>
          <Dialog open={diagText !== null} onOpenChange={(open) => { if (!open) setDiagText(null); }}>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Diagnostics — {diagId}</DialogTitle>
                <DialogDescription>
                  Read-only reachability facts. Never includes device keys or credentials.
                </DialogDescription>
              </DialogHeader>
              {diagText && <PreBlock text={diagText} />}
              <DialogFooter>
                <Button type="button" variant="glass" size="touch" onClick={() => setDiagText(null)}>
                  Close
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </Panel>

        <Panel data-settings-section="backup backup restore zip download">
          <PanelTitle icon={Download}>Backup &amp; restore</PanelTitle>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Save a copy of this phone's local configuration, or restore one you already downloaded.
            </p>
            <Button asChild variant="glass" size="touch">
              <a href={BACKUP_URL}>
                Download backup <Download />
              </a>
            </Button>
            <div className="space-y-2">
              <Label htmlFor="restore-file">Backup file (.zip)</Label>
              <Input
                id="restore-file"
                type="file"
                accept=".zip,application/zip"
                className="h-auto py-2"
                onChange={(event) => setRestoreFile(event.target.files?.[0] ?? null)}
              />
            </div>
            <ConfirmButton
              label="Restore from file"
              icon={FileUp}
              variant="destructive"
              confirmLabel="Restore"
              title="Restore this backup?"
              body="This replaces saved local configuration on this phone. Devices may need to be re-added. Take a fresh backup first if you are unsure."
              onConfirm={() => void runRestore()}
              disabled={!restoreFile || backupAction.busy}
            />
            <StateNote action={backupAction} />
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelTitle
            icon={RefreshCw}
            action={
              <Badge variant={nativeReady ? "info" : "unknown"}>
                {nativeReady ? "Android bridge ready" : "Browser mode"}
              </Badge>
            }
          >
            App updates
          </PanelTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <PanelRow label="UI version">{APP_VERSION}</PanelRow>
              <PanelRow label="Backend version">{httpCurrent || "unknown"}</PanelRow>
              <PanelRow label="Installed (Android)">{nativeCurrent || (nativeReady ? "unknown" : "n/a")}</PanelRow>
              <PanelRow label="Latest release">{latestLabel}</PanelRow>
              <PanelRow label="Release status">
                <Badge variant={httpAvailable || nativeAvailable ? "preview" : "ok"}>
                  {waitingForRelease ? "waiting for release" : releaseStatus}
                </Badge>
              </PanelRow>
            </div>
            <div className="space-y-2">
              <PanelRow label="Install permission">
                <Badge variant={nativeReady ? (canInstall ? "ok" : "preview") : "unknown"}>
                  {nativeReady ? (canInstall ? "allowed" : "needed") : "not applicable"}
                </Badge>
              </PanelRow>
              <PanelRow label="Backup before update">
                <Badge variant={hasBackup ? "ok" : "preview"}>
                  {hasBackup ? "rollback copy saved" : nativeReady ? "none saved yet" : "not applicable"}
                </Badge>
              </PanelRow>
              <PanelRow label="Install source">{str(info["installation"]) || (nativeReady ? "android" : "browser")}</PanelRow>
              {nativeError && (
                <p role="alert" className="flex items-start gap-1.5 text-xs text-status-offline">
                  <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> {nativeError}
                </p>
              )}
              {nativeBusy && (
                <p role="status" className="text-xs text-muted-foreground">
                  An update operation is in progress in the Android app…
                </p>
              )}
              {updateUrl && (
                <Button asChild variant="glass" size="touch">
                  <a href={updateUrl} target="_blank" rel="noreferrer">
                    Release notes <ExternalLink />
                  </a>
                </Button>
              )}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="glass" size="touch" disabled={updateAction.busy} onClick={() => void checkForUpdate()}>
              <RefreshCw /> Check now
            </Button>
            {nativeReady && !canInstall && (
              <Button variant="glass" size="touch" onClick={openInstallPermission}>
                <Lock /> Install permission
              </Button>
            )}
            {updateAvailable && (
              <ConfirmButton
                label="Install update"
                icon={Download}
                variant="warning"
                confirmLabel="Install"
                title="Install this update?"
                body="The Android app will install the signed APK. Keep a backup first and do not close the app during installation."
                onConfirm={() => void installUpdate()}
                disabled={updateAction.busy || nativeBusy}
              />
            )}
            {hasBackup && (
              <ConfirmButton
                label="Roll back"
                icon={RotateCcw}
                variant="destructive"
                confirmLabel="Roll back"
                title="Roll back to the previous version?"
                body="This restores the saved APK and local data. It cannot be undone unless you have another backup."
                onConfirm={() => void rollbackUpdate()}
                disabled={updateAction.busy || nativeBusy}
              />
            )}
          </div>
          <StateNote action={updateAction} />
          <p className="mt-3 text-xs text-muted-foreground">
            Updates are installed by the Android app only. This screen never changes the update channel,
            and install/rollback always ask for confirmation. Download a backup before updating.
          </p>
        </Panel>

        <Panel className="lg:col-span-2" data-settings-section="family hub family hub share connect client">
          <PanelTitle icon={Users}>Family Hub <Badge variant="unknown">Optional</Badge></PanelTitle>
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <PanelRow label="Mode"><Badge variant="info">{familyMode}</Badge></PanelRow>
              <PanelRow label="Connection">
                <Badge variant={familyConnected ? "ok" : "unknown"}>
                  {familyConnected ? "Connected" : familyMode === "client" ? "Not connected" : "—"}
                </Badge>
              </PanelRow>
              <PanelRow label="Direct mode">
                <Badge variant={familyDirect ? "ok" : "preview"}>{familyDirect ? "on" : "off"}</Badge>
              </PanelRow>
              <PanelRow label="Hub address">{str(family?.["hub_url"]) || "—"}</PanelRow>
            </div>
            {str(family?.["last_error"]) && (
              <p role="alert" className="text-xs text-status-offline">{str(family?.["last_error"])}</p>
            )}
            <div>
              <p className="mb-2 text-sm font-medium">Mode</p>
              <Segmented<FamilyMode>
                label="Family Hub mode"
                value={familyMode}
                onChange={(value) => { if (value !== familyMode) setPendingMode(value); }}
                options={[
                  { v: "off", label: "Off", icon: Unplug },
                  { v: "hub", label: "This phone is hub", icon: Radio },
                  { v: "client", label: "Connect to hub", icon: Link2 },
                ]}
              />
            </div>
            {familyMode === "hub" && (
              <div className="space-y-2 rounded-2xl border border-glass-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">
                  Hub address: {familyLanIp ? `http://${familyLanIp}:8000` : "Wi-Fi address not available"}
                </p>
                {familyDirect ? (
                  <p>Share this address and the Direct mode username/password with the family phone.</p>
                ) : (
                  <p className="text-status-offline">
                    Direct mode is off. Set a username/password and enable Direct mode first.
                  </p>
                )}
              </div>
            )}
            {familyMode === "client" && (
              <div className="space-y-3 rounded-2xl border border-glass-border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">
                  Saved encrypted on this phone; the password is never shown again.
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="family-url">Hub address</Label>
                    <Input id="family-url" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} placeholder="http://192.168.1.10:8000" autoComplete="off" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="family-user">Hub username</Label>
                    <Input id="family-user" value={hubUser} onChange={(e) => setHubUser(e.target.value)} autoComplete="username" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="family-pass">Hub password</Label>
                    <Input id="family-pass" type="password" value={hubPass} onChange={(e) => setHubPass(e.target.value)} autoComplete="current-password" />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <ConfirmButton
                    label="Connect to hub"
                    icon={Link2}
                    title="Save hub credentials and connect?"
                    body="The address, username and password are stored encrypted on this phone. They are never displayed here again."
                    onConfirm={() => void connectFamily()}
                    disabled={familyAction.busy}
                  />
                  <Button variant="glass" size="touch" disabled={familyAction.busy} onClick={() => void checkFamily()}>
                    <Activity /> Check connection
                  </Button>
                </div>
              </div>
            )}
            <ConfirmButton
              label="Disconnect & clear credentials"
              icon={Unplug}
              variant="destructive"
              confirmLabel="Disconnect"
              title="Disconnect from the hub?"
              body="Removes the saved hub address and credentials from this phone. Local control of your own devices stays available."
              onConfirm={() => void disconnectFamily()}
              disabled={familyMode !== "client" || familyAction.busy}
            />
            <StateNote action={familyAction} />
          </div>
          <Dialog open={pendingMode !== null} onOpenChange={(open) => { if (!open) setPendingMode(null); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change Family Hub mode?</DialogTitle>
                <DialogDescription>
                  Switching mode updates saved sharing configuration on this phone. The hub phone must
                  stay on the same Wi-Fi and powered on.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="glass" size="touch" onClick={() => setPendingMode(null)}>Cancel</Button>
                <Button type="button" size="touch" disabled={!pendingMode} onClick={() => { if (pendingMode) void applyFamilyMode(pendingMode); }}>
                  Apply mode
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </Panel>

        <Panel data-settings-section="haier keys haier cloud key renew sign in">
          <PanelTitle icon={Cloud}>Haier cloud keys <Badge variant="unknown">Optional</Badge></PanelTitle>
          <div className="mt-3 flex flex-wrap gap-2">
            {AC_DEVICES.map((acDevice) => (
              <Button
                key={acDevice.id}
                type="button"
                size="touch"
                variant="glass"
                onClick={() => setAcSetupDevice(acDevice)}
              >
                <Cpu /> Setup {acDevice.name}
              </Button>
            ))}
          </div>
          <div className="space-y-4">
            <div className="space-y-2">
              <PanelRow label="Cloud sign-in">
                <Badge variant={cloudLoggedIn ? "ok" : "unknown"}>{cloudLoggedIn ? "Active" : "Not signed in"}</Badge>
              </PanelRow>
              <PanelRow label="Zone">{str(cloudStatus?.["zone"]) || "—"}</PanelRow>
              <PanelRow label="Last renewal">{timeLabel(cloudStatus?.["last_renew"])}</PanelRow>
            </div>
            {cloudSlots.length > 0 && (
              <ul className="space-y-2">
                {cloudSlots.map((slot, index) => {
                  const item = asObj(slot);
                  const id = str(item["id"]);
                  const version = item["key_version"];
                  return (
                    <li key={id || index} className="flex items-center justify-between gap-3 rounded-xl border border-glass-border bg-muted/30 px-3 py-2 text-sm">
                      <span className="min-w-0 break-words">{haierSlotLabel(id)}</span>
                      <Badge variant={item["device_id"] ? "info" : "unknown"}>
                        {item["device_id"] ? `key v${typeof version === "number" ? version : "?"}` : "not configured"}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="space-y-3 rounded-2xl border border-glass-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                Used once to renew rotated local keys. Passwords are sent to the backend and never
                shown here. Direct LAN control does not need a cloud account.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="haier-user">HaiSmart username</Label>
                <Input id="haier-user" value={cloudUser} onChange={(e) => setCloudUser(e.target.value)} autoComplete="username" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="haier-pass">Password</Label>
                <Input id="haier-pass" type="password" value={cloudPass} onChange={(e) => setCloudPass(e.target.value)} autoComplete="current-password" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="haier-zone">Zone (optional)</Label>
                <Input id="haier-zone" value={cloudZone} onChange={(e) => setCloudZone(e.target.value)} placeholder="e.g. PK" autoComplete="off" />
              </div>
              <div className="flex flex-wrap gap-2">
                <ConfirmButton
                  label="Sign in & renew keys"
                  icon={Cloud}
                  title="Renew Haier local keys?"
                  body="Signs in once and writes renewed keys straight to the encrypted config. Key values are never displayed in this UI."
                  onConfirm={() => void submitCloud()}
                  disabled={cloudAction.busy}
                />
                <ConfirmButton
                  label="Sign out"
                  icon={Unplug}
                  variant="destructive"
                  confirmLabel="Sign out"
                  title="Forget the Haier cloud session?"
                  body="Removes the saved refresh token. Direct LAN control and saved local keys are unchanged."
                  onConfirm={() => void logoutCloud()}
                  disabled={!cloudLoggedIn || cloudAction.busy}
                />
              </div>
            </div>
            <StateNote action={cloudAction} />
          </div>
        </Panel>

        <Panel data-settings-section="security security sign in login logout qr">
          <PanelTitle icon={UserLock}>Security &amp; sign-in</PanelTitle>
          <div className="space-y-4">
            <PanelRow label="Tuya account">
              <Badge variant={loggedIn ? "ok" : "unknown"}>{loggedIn ? "Signed in" : "Not signed in"}</Badge>
            </PanelRow>
            {!loggedIn && !qrActive && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="user-code">Tuya user code</Label>
                  <Input id="user-code" value={userCode} onChange={(e) => setUserCode(e.target.value)} placeholder="Code from Smart Life" autoComplete="off" />
                </div>
                <Button variant="glass" size="touch" disabled={authAction.busy} onClick={() => void startLogin()}>
                  <QrCode /> Start QR sign-in
                </Button>
              </div>
            )}
            {qrActive && (
              <div className="space-y-3">
                <img src={qr} alt="QR code to scan in the Smart Life app" className="mx-auto h-44 w-44 rounded-2xl bg-white p-2" />
                <p role="status" className="text-center text-sm text-muted-foreground">{qrStatus}</p>
                <Button variant="glass" size="touch" onClick={cancelLogin}>Cancel sign-in</Button>
              </div>
            )}
            {loggedIn && (
              <ConfirmButton
                label="Sign out"
                icon={Unplug}
                variant="destructive"
                confirmLabel="Sign out"
                title="Sign out of Tuya?"
                body="Deletes the saved session and local device list from this phone. You will need to scan a new QR code to sign in again."
                onConfirm={() => void doLogout()}
                disabled={authAction.busy}
              />
            )}
            <StateNote action={authAction} />
            <p className="text-xs text-muted-foreground">
              Sign-in stores a session in this app's private storage. No password or key value is shown in the UI.
            </p>
          </div>
        </Panel>

        <Panel data-settings-section="support support report diagnostics">
          <PanelTitle icon={FileDown}>Support report</PanelTitle>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Save allowlisted diagnostics for one device. Credentials and key values are never included.
            </p>
            <div className="space-y-2">
              <Label htmlFor="support-device">Device ID</Label>
              <Input
                id="support-device"
                list="known-device-ids"
                value={supportDevice}
                onChange={(event) => setSupportDevice(event.target.value)}
                placeholder="Backend device ID"
                autoComplete="off"
              />
            </div>
            <Button variant="glass" size="touch" disabled={!supportDevice.trim() || supportAction.busy} onClick={() => void makeReport()}>
              <FileDown /> Generate report
            </Button>
            <StateNote action={supportAction} />
            {reportText && <PreBlock text={reportText} />}
          </div>
        </Panel>

        <Panel data-settings-section="remote remote tailscale direct access vpn">
          <PanelTitle icon={ShieldCheck}>Remote access</PanelTitle>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={tailnetUrl ? "ok" : "unknown"}>
              <Lock className="size-3" aria-hidden /> {tailnetUrl ? "Tailnet address detected" : "Tailnet URL unavailable"}
            </Badge>
            <Badge variant={directOn ? "ok" : "unknown"}>
              <ShieldCheck className="size-3" aria-hidden /> Direct access {directOn ? "on" : "off"}
            </Badge>
            <Badge variant={haAvailable ? "ok" : "unknown"}>
              <Cloud className="size-3" aria-hidden /> HA ingress {haAvailable ? "available" : "not detected"}
            </Badge>
          </div>

          {tailnetUrl ? (
            <div className="mt-4 rounded-2xl border border-glass-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Remote address (no credentials embedded)</p>
              <code className="mt-1 block break-all text-sm" data-testid="remote-url">{tailnetUrl}</code>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="touch"
                  variant="glass"
                  onClick={() => {
                    void copyRemoteUrl(tailnetUrl).then((ok) => {
                      setRemoteCopied(ok);
                      window.setTimeout(() => setRemoteCopied(false), 2000);
                    });
                  }}
                >
                  <Copy /> {remoteCopied ? "Copied" : "Copy URL"}
                </Button>
                <a
                  href={tailnetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-glass-border px-3 text-sm"
                >
                  <ExternalLink /> Open in browser
                </a>
                <a
                  href={`${tailnetUrl.replace(/\/local\/?$/, "")}/api/state`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-glass-border px-3 text-sm"
                >
                  <CheckCircle2 /> Test in browser
                </a>
              </div>
              <p className="mt-2 text-xs text-muted-foreground" role="status">
                "Open in browser" leaves this app by design; the built-in WebView stays on 127.0.0.1.
              </p>
            </div>
          ) : (
            <p className="mt-4 rounded-2xl border border-status-unknown/30 bg-status-unknown/8 p-3 text-sm" role="status">
              No tailnet address is exposed yet. Direct access is off — enable it below, then reopen this panel. Keep Tailscale connected on this phone.
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              size="touch"
              variant="glass"
              onClick={() => nativeCall("PilotNative", "openDirectSettings")}
            >
              <Settings2 /> Open direct-mode settings
            </Button>
          </div>
          {lanIp && (
            <p className="mt-2 text-xs text-muted-foreground">Local address: {lanIp}</p>
          )}

          <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Install and sign in to Tailscale on this phone and on the remote device.</li>
            <li>Tap "Open direct-mode settings", enable direct access, set a username and password, then Apply.</li>
            <li>Keep this phone on the devices' Wi-Fi and the app running.</li>
            <li>Copy the URL above and open it on the other tailnet device; sign in with those credentials.</li>
            <li>Use "Test in browser" to confirm reachability.</li>
          </ol>
          <p className="mt-3 flex items-start gap-2 text-xs text-status-preview" role="note">
            <Lock className="mt-px size-3.5 shrink-0" aria-hidden />
            Remote UI access does not mean remote device control: the phone still needs to reach the device LAN.
            For full remote control, use Home Assistant Supervisor ingress. Do not expose port 8000 to the public internet.
          </p>
        </Panel>

        <Panel data-settings-section="preferences local first preferences">
          <PanelTitle icon={MonitorSmartphone}>Local-first preferences</PanelTitle>
          <div className="divide-y divide-border">
            <ToggleRow
              title="Prefer local network"
              body="Talk to devices over your home network first, once connected."
              checked={p.preferLocal}
              onChange={(v) => setPrefs({ preferLocal: v })}
            />
            <ToggleRow
              title="Allow cloud fallback"
              body="Off by default. Cloud sign-in here only renews Haier local keys; it is not a device fallback."
              checked={p.cloudFallback}
              onChange={(v) => setPrefs({ cloudFallback: v })}
            />
            <ToggleRow
              title="Confirm AC power changes"
              body="Ask before every AC power command."
              checked={p.confirmAcPower}
              onChange={(v) => setPrefs({ confirmAcPower: v })}
            />
          </div>
        </Panel>

        <Panel data-settings-section="safety safety permissions approval">
          <PanelTitle icon={ShieldCheck}>Safety permissions</PanelTitle>
          <div className="divide-y divide-border">
            <ToggleRow
              title="Approval for water motors, breakers & Geyser"
              body="Required for any action — now and in future real integrations."
              checked
              locked
            />
            <ToggleRow
              title="Manual is never overridden by Auto"
              body="Auto-Pilot skips any AC set to Manual."
              checked
              locked
            />
            <ToggleRow
              title="Compressor anti-short-cycle (3 min)"
              body="Blocks AC restart within 3 minutes of stopping."
              checked
              locked
            />
            <ToggleRow
              title="Hardware actuation"
              body={connection.state === "live"
                ? "Enabled for verified devices. Unverified writes are refused by the backend."
                : "Held until a fresh verified local read succeeds."}
              checked={connection.state === "live"}
              locked
            />
          </div>
        </Panel>

        <Panel className="lg:col-span-2" data-settings-section="capabilities device capabilities">
          <PanelTitle icon={Cpu}>Device capabilities</PanelTitle>
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 font-medium">Device</th>
                  <th className="px-2 py-2 font-medium">Connection</th>
                  <th className="px-2 py-2 font-medium">Power / Modes</th>
                  <th className="px-2 py-2 font-medium">Eco · Sleep · Quiet</th>
                  <th className="px-2 py-2 font-medium">Metering</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {DEVICES.map((device) => (
                  <tr key={device.id}>
                    <td className="px-2 py-2.5">
                      <span className="flex items-center gap-2">
                        <DeviceGlyph device={device} size="sm" />
                        <span className="font-medium">{device.name}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5">
                      <ConnectionPill status={device.connection} />
                    </td>
                    <td className="px-2 py-2.5">
                      {device.kind === "air_conditioner" ? (
                        <span className="text-xs text-muted-foreground">
                          {Object.entries(device.capabilities.modes)
                            .filter(([, value]) => value === "supported")
                            .map(([mode]) => mode)
                            .join(", ")}
                        </span>
                      ) : (
                        <CapabilityPill status={device.capabilities.power} />
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      {device.kind === "air_conditioner" ? (
                        <span className="flex flex-wrap gap-1">
                          <CapabilityPill status={device.capabilities.eco} />
                          <CapabilityPill status={device.capabilities.nightSleep} />
                          <CapabilityPill status={device.capabilities.quiet} />
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">n/a</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      <CapabilityPill status={device.capabilities.energyMetering} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Capability labels follow each model profile. Every capability is verified on the
            real device before live use. {AC_DEVICES.length} ACs,{" "}
            {DEVICES.length - AC_DEVICES.length} Smart Life devices.
          </p>
        </Panel>

        <Panel data-settings-section="privacy privacy data">
          <PanelTitle icon={UserLock}>Privacy</PanelTitle>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>• No analytics or trackers in this UI.</li>
            <li>• Display preferences and UI history stay in this browser.</li>
            <li>• Tuya sessions, Haier keys and backups are stored by the Android app, not here.</li>
            <li>• No key values or passwords are shown or logged by this screen.</li>
          </ul>
          <ConfirmButton
            className="mt-4"
            label="Clear all local data"
            icon={Trash2}
            variant="destructive"
            title="Clear all local data?"
            body="Removes saved preferences, schedules, chat and history from this browser. Android app storage is not affected."
            onConfirm={() => {
              localStorage.removeItem("smartpilot:v1");
              window.location.reload();
            }}
          />
        </Panel>

        <Panel data-settings-section="local state local ui state reset demo">
          <PanelTitle icon={RotateCcw}>Local UI state</PanelTitle>
          <p className="text-sm text-muted-foreground">
            Reset locally stored UI state, drafts and history. Your theme and language
            stay.
          </p>
          <ConfirmButton
            className="mt-4"
            label="Reset local UI state"
            icon={RotateCcw}
            title="Reset local UI state?"
            body="Local drafts, chat and history return to their defaults. No device is contacted."
            onConfirm={resetDemo}
          />
        </Panel>

        <Panel className="lg:col-span-2" data-settings-section="about about version repository">
          <PanelTitle icon={Info}>About</PanelTitle>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">App</dt>
              <dd className="font-medium">Smart Pilot · Titanium Control</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">UI version</dt>
              <dd className="font-medium tabular">{APP_VERSION}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Mode</dt>
              <dd className="font-medium">Live local WebView — uses this app's backend</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            This WebView is served by the same Android app and uses its existing backend. Integration
            guide: docs/INTEGRATION.md.
          </p>
          <Button asChild variant="glass" size="touch" className="mt-3">
            <a href={REPO} target="_blank" rel="noreferrer">
              Android repository <ExternalLink />
            </a>
          </Button>
        </Panel>
        {AC_DEVICES.map((acDevice) => (
          <AcSetupDialog
            key={acDevice.id}
            device={acDevice}
            slot={acDevice.name === "19HFAB T3 Pro" ? "pro" : "ff"}
            open={acSetupDevice?.id === acDevice.id}
            onOpenChange={(open) => { if (!open) setAcSetupDevice(null); }}
            onSaved={() => void refreshDevices()}
          />
        ))}
      </div>
    </div>
  );
}
