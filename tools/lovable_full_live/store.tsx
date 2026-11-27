import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { AC_DEVICES, DEVICES, deviceLabel } from "./devices";
import { defaultAcState } from "./climate";
import { translate, type I18nKey } from "./i18n";
import { PREVIEW_MESSAGE } from "./adapter";
import {
  autoCheckUpdates,
  autoRenewHaierKeys,
  nativeCall,
  nativeUpdateState,
  registerUpdateCallback,
} from "./backend-api";
// The live WebView uses the concrete adapter, which exposes the verified-read
// and AC control methods the narrowed DeviceAdapter type does not declare.
import { adapter as liveAdapter } from "./local-backend-adapter";
import type { ChatMessage } from "./assistant";
import type {
  AcPreviewState,
  ActivityEvent,
  ApprovalRequest,
  Automation,
  CommandResult,
  ControlMode,
  Device,
  DeviceCommand,
  Language,
  ThemePref,
} from "./types";

export interface Policies {
  nightEco: boolean;
  noPumpGeyserOverlap: boolean;
  coolFloor24: boolean;
  ecoWhenAway: boolean;
}

export interface Prefs {
  theme: ThemePref;
  language: Language;
  overridePauseMin: number;
  preferLocal: boolean;
  cloudFallback: boolean;
  confirmAcPower: boolean;
  compactCards: boolean;
}

export interface LiveConnection {
  state: "idle" | "refreshing" | "live" | "degraded";
  message: string;
  refreshedAt: string | null;
}

/** Locally sampled from verified reads; never a billing-grade meter. */
export interface DeviceSession {
  start: string;
  end: string | null;
  kwh: number;
}

export interface DeviceHistory {
  day: string;
  running: boolean;
  lastOnAt: string | null;
  lastOffAt: string | null;
  lastSampleAt: string | null;
  lastPowerW: number | null;
  todayKwh: number;
  sessions: DeviceSession[];
}

const HISTORY_KEY = "smartpilot:device-history:v1";

export interface AppState {
  prefs: Prefs;
  ac: Record<string, AcPreviewState>;
  automations: Automation[];
  approvals: ApprovalRequest[];
  activity: ActivityEvent[];
  policies: Policies;
  deviceAutomation: Record<string, boolean>;
  chat: ChatMessage[];
}

const STORAGE_KEY = "smartpilot:v1";

export function initialState(): AppState {
  return {
    prefs: {
      theme: "system",
      language: "en",
      overridePauseMin: 60,
      preferLocal: true,
      cloudFallback: false,
      confirmAcPower: true,
      compactCards: false,
    },
    ac: Object.fromEntries(AC_DEVICES.map((d) => [d.id, defaultAcState()])),
    automations: [],
    approvals: [],
    activity: [],
    policies: { nightEco: true, noPumpGeyserOverlap: true, coolFloor24: true, ecoWhenAway: false },
    deviceAutomation: { "ac-pro": true, "ac-t3": true },
    chat: [],
  };
}

const uid = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

const emptyHistory = (day: string): DeviceHistory => ({
  day,
  running: false,
  lastOnAt: null,
  lastOffAt: null,
  lastSampleAt: null,
  lastPowerW: null,
  todayKwh: 0,
  sessions: [],
});

/** Derive ON/OFF times and sampled kWh from verified local reads only. */
function sampleHistory(
  previous: Record<string, DeviceHistory>,
  devices: Device[],
  points: Record<string, import("./local-backend-adapter").LiveDpPoint[]>,
  nowMs: number,
): Record<string, DeviceHistory> {
  const next: Record<string, DeviceHistory> = { ...previous };
  const day = new Date(nowMs).toLocaleDateString("en-CA");
  const at = new Date(nowMs).toISOString();

  for (const device of devices) {
    if (device.kind === "air_conditioner" || !device.power.known) continue;
    const point = (points[device.id] ?? []).find(
      (item) => item.code === "cur_power" && typeof item.value === "number",
    );
    const watts = point
      ? Number(point.value) / 10 ** (typeof point.scale === "number" ? point.scale : 1)
      : null;
    const on = device.power.value === "on";
    const old = next[device.id] ?? emptyHistory(day);
    const entry: DeviceHistory =
      old.day === day
        ? { ...old, sessions: [...old.sessions] }
        : { ...emptyHistory(day), sessions: [] };

    if (on && !entry.running) {
      entry.sessions = [{ start: at, end: null, kwh: 0 }, ...entry.sessions].slice(0, 50);
      entry.lastOnAt = at;
    } else if (!on && entry.running) {
      entry.lastOffAt = at;
      if (entry.sessions[0] && entry.sessions[0].end === null) {
        entry.sessions[0] = { ...entry.sessions[0], end: at };
      }
    }

    if (
      entry.running &&
      entry.lastPowerW !== null &&
      entry.lastPowerW > 0 &&
      entry.lastSampleAt
    ) {
      const elapsed = nowMs - Date.parse(entry.lastSampleAt);
      if (elapsed > 0 && elapsed < 10 * 60 * 1000) {
        const kwh = (entry.lastPowerW / 1000) * (elapsed / 3_600_000);
        entry.todayKwh = Math.round((entry.todayKwh + kwh) * 1e6) / 1e6;
        if (entry.sessions[0] && entry.sessions[0].end === null) {
          entry.sessions[0] = {
            ...entry.sessions[0],
            kwh: Math.round((entry.sessions[0].kwh + kwh) * 1e6) / 1e6,
          };
        }
      }
    }

    entry.running = on;
    entry.lastPowerW = watts;
    entry.lastSampleAt = at;
    next[device.id] = entry;
  }

  return next;
}

interface Ctx {
  state: AppState;
  hydrated: boolean;
  devices: Device[];
  connection: LiveConnection;
  refreshDevices: () => Promise<void>;
  sendDeviceCommand: (
    deviceId: string,
    command: DeviceCommand,
    approval?: { approvedBy: string; approvedAt: string },
  ) => Promise<CommandResult>;
  points: Record<string, import("./local-backend-adapter").LiveDpPoint[]>;
  deviceHistory: Record<string, DeviceHistory>;
  sendDpCommand: (
    deviceId: string,
    dp: string,
    value: unknown,
    approval?: { approvedBy: string; approvedAt: string },
  ) => Promise<CommandResult>;
  setAcControlMode: (deviceId: string, mode: ControlMode) => Promise<CommandResult>;
  resumeAuto: (deviceId: string) => Promise<CommandResult>;
  t: (key: I18nKey, vars?: Record<string, string | number>) => string;
  setPrefs: (p: Partial<Prefs>) => void;
  setPolicies: (p: Partial<Policies>) => void;
  updateAc: (id: string, patch: Partial<AcPreviewState>, logTitle?: string) => void;
  setDeviceAutomation: (id: string, on: boolean) => void;
  log: (
    e: Omit<ActivityEvent, "id" | "at" | "source"> & { source?: ActivityEvent["source"] },
  ) => void;
  previewAction: (title: string, deviceId?: string, detail?: string) => void;
  addAutomation: (a: Automation) => void;
  updateAutomation: (id: string, patch: Partial<Automation>) => void;
  removeAutomation: (id: string) => void;
  addApproval: (r: ApprovalRequest) => void;
  decideApproval: (id: string, decision: "approved" | "rejected") => void;
  setChat: (fn: (c: ChatMessage[]) => ChatMessage[]) => void;
  resetDemo: () => void;
}

const SmartPilotContext = createContext<Ctx | null>(null);

function applyTheme(theme: ThemePref) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  if (dark) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function SmartPilotProvider({ children }: { children: ReactNode }) {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [state, setState] = useState<AppState>(initialState);
  const [hydrated, setHydrated] = useState(false);
  const [devices, setDevices] = useState<Device[]>(() =>
    DEVICES.map((device) => ({ ...device }) as Device),
  );
  const [points, setPoints] = useState<
    Record<string, import("./local-backend-adapter").LiveDpPoint[]>
  >({});
  const [deviceHistory, setDeviceHistory] = useState<Record<string, DeviceHistory>>(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      return saved && typeof saved === "object" ? (saved as Record<string, DeviceHistory>) : {};
    } catch {
      return {};
    }
  });
  const [connection, setConnection] = useState<LiveConnection>({
    state: "idle",
    message: "Local backend not checked yet",
    refreshedAt: null,
  });

  const loaded = useRef(false);
  const haierRenewTried = useRef(false);
  const refreshInFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<AppState>;
        const base = initialState();
        setState({
          ...base,
          ...saved,
          prefs: { ...base.prefs, ...saved.prefs },
          policies: { ...base.policies, ...saved.policies },
          ac: { ...base.ac, ...saved.ac },
        });
      }
    } catch {
      /* corrupted storage — fall back to defaults */
    }
    loaded.current = true;
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage full or blocked */
    }
  }, [state]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(deviceHistory));
    } catch {
      /* storage full or blocked — history stays in memory */
    }
  }, [deviceHistory]);

  useEffect(() => {
    applyTheme(state.prefs.theme);
    document.documentElement.lang = state.prefs.language === "ur" ? "ur-Latn" : "en";
    if (state.prefs.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = () => applyTheme("system");
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [state.prefs.theme, state.prefs.language]);

  const log: Ctx["log"] = useCallback((e) => {
    if (!mountedRef.current) return;
    setState((s) => ({
      ...s,
      activity: [
        {
          id: uid(),
          at: new Date().toISOString(),
          source: "system" as const,
          ...e,
        } as ActivityEvent,
        ...s.activity,
      ].slice(0, 200),
    }));
  }, []);

  const refreshDevices = useCallback(async () => {
    if (refreshInFlight.current) return refreshInFlight.current;

    const run = (async () => {
      if (mountedRef.current) {
        setConnection((current) => ({
          ...current,
          state: "refreshing",
          message: "Refreshing verified local status…",
        }));
      }
      try {
        const result = await liveAdapter.refresh();
        if (!mountedRef.current) return;

        // After any refresh the catalogue is exactly what the backend reported.
        // An empty result (or a failed local catalogue) never falls back to the
        // fixed demo devices used only for the first paint.
        setDevices(liveAdapter.liveDevices.map((device) => ({ ...device }) as Device));
        setPoints({ ...liveAdapter.localPoints });
        if (result.verifiedDevices > 0) {
          setDeviceHistory((previous) =>
            sampleHistory(previous, liveAdapter.liveDevices, liveAdapter.localPoints, Date.now()),
          );
        }
        setState((current) => {
          const ac = { ...current.ac };
          for (const device of liveAdapter.liveDevices) {
            if (device.kind !== "air_conditioner") continue;
            const live = liveAdapter.haierStatus[device.id] ?? {};
            const mode = liveAdapter.haierModes[device.id];
            const pause = liveAdapter.haierPauseUntil[device.id] ?? 0;
            ac[device.id] = {
              ...(ac[device.id] ?? defaultAcState()),
              ...(live.power?.known ? { power: live.power.value } : {}),
              ...(live.targetTemp !== undefined ? { targetTemp: live.targetTemp } : {}),
              ...(live.mode ? { mode: live.mode as AcPreviewState["mode"] } : {}),
              ...(live.fan ? { fan: live.fan as AcPreviewState["fan"] } : {}),
              ...(live.eco !== undefined ? { eco: live.eco } : {}),
              ...(live.sleep !== undefined ? { nightSleep: live.sleep } : {}),
              ...(mode ? { controlMode: mode } : {}),
              overridePausedUntil:
                pause > Date.now() / 1000 ? new Date(pause * 1000).toISOString() : null,
            };
          }
          return { ...current, ac };
        });
        setConnection({
          state: result.verifiedDevices > 0 ? "live" : "degraded",
          message:
            result.verifiedDevices > 0
              ? `${result.verifiedDevices} device${result.verifiedDevices === 1 ? "" : "s"} verified by a fresh local read`
              : `No fresh verified reads${result.errors.length ? ` — ${result.errors[0]}` : ""}`,
          refreshedAt: result.at,
        });

        // A rotated Haier key makes the AC unverifiable. Renew immediately via
        // the saved refresh token instead of waiting for the 12-hour background
        // check, then re-read once. At most one attempt per app session.
        if (
          result.errors.some((error) => /key rotated/i.test(error)) &&
          !haierRenewTried.current
        ) {
          haierRenewTried.current = true;
          void autoRenewHaierKeys(true).then((outcome) => {
            if (!mountedRef.current) return;
            toast(outcome.ok ? "Haier key renewed" : "Haier key renewal failed", {
              description: outcome.message,
            });
            if (outcome.ok) void refreshDevices();
          });
        }
      } catch (error) {
        if (!mountedRef.current) return;
        setConnection({
          state: "degraded",
          message: `Local backend unavailable — ${(error as Error).message}`,
          refreshedAt: null,
        });
      }
    })();

    refreshInFlight.current = run.finally(() => {
      refreshInFlight.current = null;
    });
    return refreshInFlight.current;
  }, []);

  const sendDeviceCommand = useCallback<Ctx["sendDeviceCommand"]>(
    async (deviceId, command, approval) => {
      const device = devices.find((item) => item.id === deviceId);
      const label = device?.name ?? deviceId;
      const result = await liveAdapter.sendCommand(deviceId, command, approval);
      log({
        kind: "device",
        status: result.delivered ? "success" : "blocked",
        title: `${label}: command ${result.delivered ? "confirmed" : "not sent"}`,
        detail: result.message,
        deviceId,
      });
      toast(result.delivered ? `${label} — command confirmed` : `${label} — command not sent`, {
        description: result.message,
      });
      if (result.delivered) await refreshDevices();
      return result;
    },
    [devices, log, refreshDevices],
  );

  const sendDpCommand = useCallback<Ctx["sendDpCommand"]>(
    async (deviceId, dp, value, approval) => {
      const label = devices.find((item) => item.id === deviceId)?.name ?? deviceId;
      const point = points[deviceId]?.find((item) => item.dp === String(dp));
      const result = await liveAdapter.sendDp(deviceId, String(dp), value, approval);
      log({
        kind: "device",
        status: result.delivered ? "success" : "blocked",
        title: `${label}: ${point?.code ?? `DP ${dp}`} ${result.delivered ? "confirmed" : "not sent"}`,
        detail: result.message,
        deviceId,
      });
      toast(`${label} — ${point?.code ?? `DP ${dp}`}`, { description: result.message });
      if (result.delivered) await refreshDevices();
      return result;
    },
    [devices, points, log, refreshDevices],
  );

  const setAcControlMode = useCallback<Ctx["setAcControlMode"]>(
    async (deviceId, mode) => {
      const label = devices.find((item) => item.id === deviceId)?.name ?? deviceId;
      const result = await liveAdapter.setAcControlMode(deviceId, mode);
      log({
        kind: "safety",
        status: result.delivered ? "success" : "blocked",
        title: `${label}: ${mode} mode ${result.delivered ? "applied" : "not applied"}`,
        detail: result.message,
        deviceId,
      });
      toast(`${label}: ${mode} mode`, { description: result.message });
      if (result.delivered) await refreshDevices();
      return result;
    },
    [devices, log, refreshDevices],
  );

  const resumeAuto = useCallback<Ctx["resumeAuto"]>(
    async (deviceId) => {
      const label = devices.find((item) => item.id === deviceId)?.name ?? deviceId;
      const result = await liveAdapter.resumeAuto(deviceId);
      log({
        kind: "safety",
        status: result.delivered ? "success" : "blocked",
        title: `${label}: Auto-Pilot ${result.delivered ? "resumed" : "not resumed"}`,
        detail: result.message,
        deviceId,
      });
      toast(`${label}: Auto-Pilot`, { description: result.message });
      if (result.delivered) await refreshDevices();
      return result;
    },
    [devices, log, refreshDevices],
  );

  useEffect(() => {
    if (!hydrated) return;
    void refreshDevices();
    const timer = window.setInterval(() => void refreshDevices(), 30000);
    return () => window.clearInterval(timer);
  }, [hydrated, refreshDevices]);

  const previewAction: Ctx["previewAction"] = useCallback(
    (title, deviceId, detail) => {
      log({
        kind: "device",
        status: "info",
        title,
        detail: detail ?? PREVIEW_MESSAGE,
        ...(deviceId ? { deviceId } : {}),
      });
      toast(title, { description: PREVIEW_MESSAGE });
    },
    [log],
  );

  const decideApproval = useCallback<Ctx["decideApproval"]>(
    (id, decision) => {
      const req = state.approvals.find((a) => a.id === id);
      if (!req || req.status !== "pending") return;

      setState((s) => {
        const currentReq = s.approvals.find((a) => a.id === id);
        if (!currentReq || currentReq.status !== "pending") return s;
        const approvals = s.approvals.map((a) => (a.id === id ? { ...a, status: decision } : a));
        const automations =
          decision === "approved"
            ? [{ ...currentReq.automation, enabled: true }, ...s.automations]
            : s.automations;
        return { ...s, approvals, automations };
      });

      const title = req.title || "Request";
      const deviceNames = [
        ...new Set(
          req.automation.actions.map(
            (a) => devices.find((d) => d.id === a.deviceId)?.name ?? deviceLabel(a.deviceId),
          ),
        ),
      ].join(", ");

      log({
        kind: "automation",
        status: decision === "approved" ? "success" : "blocked",
        title: `${decision === "approved" ? "Approved" : "Rejected"}: ${title}`,
        detail: `${deviceNames ? `${deviceNames} · ` : ""}${PREVIEW_MESSAGE}`,
      });
      toast(decision === "approved" ? "Approved — saved as a local automation" : "Rejected", {
        description: PREVIEW_MESSAGE,
      });
    },
    [devices, log, state.approvals],
  );

  const value = useMemo<Ctx>(() => {
    const lang = state.prefs.language;
    return {
      state,
      hydrated,
      devices,
      connection,
      refreshDevices,
      sendDeviceCommand,
      points,
      deviceHistory,
      sendDpCommand,
      setAcControlMode,
      resumeAuto,
      t: (key, vars) => translate(lang, key, vars),
      setPrefs: (p) => setState((s) => ({ ...s, prefs: { ...s.prefs, ...p } })),
      setPolicies: (p) => setState((s) => ({ ...s, policies: { ...s.policies, ...p } })),
      updateAc: (id, patch, logTitle) => {
        setState((s) => {
          const cur = s.ac[id];
          if (!cur) return s;
          return { ...s, ac: { ...s.ac, [id]: { ...cur, ...patch } } };
        });
        if (logTitle) {
          log({
            kind: "device",
            status: "info",
            title: logTitle,
            detail: "Local UI state updated after a confirmed command.",
            deviceId: id,
          });
        }
      },
      setDeviceAutomation: (id, on) =>
        setState((s) => ({ ...s, deviceAutomation: { ...s.deviceAutomation, [id]: on } })),
      log,
      previewAction,
      addAutomation: (a) => {
        setState((s) => ({ ...s, automations: [a, ...s.automations] }));
        log({
          kind: "automation",
          status: "success",
          title: `Automation created: ${a.name}`,
          detail: PREVIEW_MESSAGE,
        });
      },
      updateAutomation: (id, patch) =>
        setState((s) => ({
          ...s,
          automations: s.automations.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        })),
      removeAutomation: (id) =>
        setState((s) => ({ ...s, automations: s.automations.filter((a) => a.id !== id) })),
      addApproval: (r) => setState((s) => ({ ...s, approvals: [r, ...s.approvals] })),
      decideApproval,
      setChat: (fn) => setState((s) => ({ ...s, chat: fn(s.chat) })),
      resetDemo: () => {
        const base = initialState();
        setState((s) => ({ ...base, prefs: s.prefs }));
        toast("Local UI state reset", {
          description: "Local drafts and history restored. Your theme and language are unchanged.",
        });
      },
    };
  }, [
    state,
    hydrated,
    devices,
    connection,
    refreshDevices,
    sendDeviceCommand,
    points,
    deviceHistory,
    sendDpCommand,
    setAcControlMode,
    resumeAuto,
    log,
    previewAction,
    decideApproval,
  ]);

  // --- Proactive update: check + background download, install stays explicit --
  const [nativeUpdate, setNativeUpdate] = useState<Record<string, unknown> | null>(null);
  const [updatePrompt, setUpdatePrompt] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const bridge = (window as unknown as Record<string, unknown>)["PilotNative"];
    if (!bridge || typeof bridge !== "object") return;
    registerUpdateCallback((result) => {
      if (!mountedRef.current) return;
      setNativeUpdate((current) => ({ ...(current ?? {}), ...result }));
    });
    setNativeUpdate(nativeUpdateState() as Record<string, unknown> | null);
    // The shared 6h throttle avoids a GitHub call on every screen render.
    void autoCheckUpdates()
      .then((value) => {
        if (value && mountedRef.current) nativeCall("PilotNative", "checkUpdate");
      })
      .catch(() => {
        /* metadata check is best effort */
      });
  }, []);

  const updateAvailable = nativeUpdate?.["available"] === true;
  const updateDownloaded = nativeUpdate?.["downloaded"] === true;
  const updateBusy = nativeUpdate?.["busy"] === true;
  const updateLatest = String(nativeUpdate?.["latest"] ?? "");
  const updateError = String(nativeUpdate?.["error"] ?? "");

  useEffect(() => {
    if (!updateAvailable || updateBusy) return;
    if (updateDownloaded) {
      if (!updateLatest) return;
      const key = `smartpilot:update-prompted:${updateLatest}`;
      try {
        if (window.localStorage.getItem(key) !== "1") setUpdatePrompt(updateLatest);
      } catch {
        setUpdatePrompt(updateLatest);
      }
      return;
    }
    if (updateError) return;
    // Download-only bridge: no install prompt is launched from here.
    nativeCall("PilotNative", "prepareUpdate");
  }, [updateAvailable, updateDownloaded, updateBusy, updateLatest, updateError]);

  const dismissUpdate = useCallback((version: string | null) => {
    if (version) {
      try {
        window.localStorage.setItem(`smartpilot:update-prompted:${version}`, "1");
      } catch {
        /* non-persistent dismissal is still fine */
      }
    }
    setUpdatePrompt(null);
  }, []);

  return (
    <>
      <SmartPilotContext.Provider value={value}>{children}</SmartPilotContext.Provider>
      <Dialog
        open={!!updatePrompt}
        onOpenChange={(open) => {
          if (!open) dismissUpdate(updatePrompt);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="tabular">Update {updatePrompt} is ready</DialogTitle>
            <DialogDescription>
              The signed APK was downloaded in the background. Installing still requires your
              confirmation and the Android install prompt. Nothing is installed automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="glass"
              size="touch"
              className="rounded-xl active:scale-[0.98]"
              onClick={() => dismissUpdate(updatePrompt)}
            >
              Later
            </Button>
            <Button
              size="touch"
              className="rounded-xl active:scale-[0.98]"
              onClick={() => {
                dismissUpdate(updatePrompt);
                nativeCall("PilotNative", "installUpdate");
              }}
            >
              Install now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function useSmartPilot(): Ctx {
  const ctx = useContext(SmartPilotContext);
  if (!ctx) throw new Error("useSmartPilot must be used inside SmartPilotProvider");
  return ctx;
}

/** Inline script that applies the saved theme before first paint (avoids a flash). */
export const themeBootScript = `(function(){try{var s=JSON.parse(localStorage.getItem("${STORAGE_KEY}")||"{}");var t=(s.prefs&&s.prefs.theme)||"system";var d=t==="dark"||(t==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
