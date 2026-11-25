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

import { AC_DEVICES, DEVICES, deviceLabel } from "./devices";
import { defaultAcState } from "./climate";
import { DEMO_APPROVALS, DEMO_AUTOMATIONS } from "./demo-data";
import { translate, type I18nKey } from "./i18n";
import { PREVIEW_MESSAGE, adapter as liveAdapter } from "./adapter";
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
      theme: "dark",
      language: "en",
      overridePauseMin: 60,
      preferLocal: true,
      cloudFallback: false,
      confirmAcPower: true,
      compactCards: false,
    },
    ac: Object.fromEntries(AC_DEVICES.map((d) => [d.id, defaultAcState()])),
    automations: DEMO_AUTOMATIONS,
    approvals: DEMO_APPROVALS,
    activity: [],
    policies: { nightEco: true, noPumpGeyserOverlap: true, coolFloor24: true, ecoWhenAway: false },
    deviceAutomation: { "ac-pro": true, "ac-t3": true },
    chat: [],
  };
}

const uid = () => Math.random().toString(36).slice(2, 10);

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
  if (typeof document === "undefined") return;
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function SmartPilotProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initialState);
  const [hydrated, setHydrated] = useState(false);
  const [devices, setDevices] = useState<Device[]>(() =>
    DEVICES.map((device) => ({ ...device }) as Device),
  );
  const [points, setPoints] = useState<
    Record<string, import("./local-backend-adapter").LiveDpPoint[]>
  >({});
  const [connection, setConnection] = useState<LiveConnection>({
    state: "idle",
    message: "Local backend not checked yet",
    refreshedAt: null,
  });
  const loaded = useRef(false);

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
    applyTheme(state.prefs.theme);
    document.documentElement.lang = state.prefs.language === "ur" ? "ur-Latn" : "en";
    if (state.prefs.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = () => applyTheme("system");
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [state.prefs.theme, state.prefs.language]);

  const log: Ctx["log"] = useCallback((e) => {
    setState((s) => ({
      ...s,
      activity: [
        {
          id: uid(),
          at: new Date().toISOString(),
          source: "preview" as const,
          ...e,
        } as ActivityEvent,
        ...s.activity,
      ].slice(0, 200),
    }));
  }, []);

  const refreshDevices = useCallback(async () => {
    setConnection((current) => ({
      ...current,
      state: "refreshing",
      message: "Refreshing verified local status…",
    }));
    try {
      const result = await liveAdapter.refresh();
      setDevices(DEVICES.map((device) => ({ ...device }) as Device));
      setPoints({ ...liveAdapter.localPoints });
      setState((current) => {
        const ac = { ...current.ac };
        for (const device of DEVICES) {
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
    } catch (error) {
      setConnection({
        state: "degraded",
        message: `Local backend unavailable — ${(error as Error).message}`,
        refreshedAt: null,
      });
    }
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
      decideApproval: (id, decision) => {
        let req: ApprovalRequest | undefined;
        setState((s) => {
          req = s.approvals.find((a) => a.id === id);
          if (!req || req.status !== "pending") return s;
          const approvals = s.approvals.map((a) => (a.id === id ? { ...a, status: decision } : a));
          const automations =
            decision === "approved"
              ? [{ ...req.automation, enabled: true }, ...s.automations]
              : s.automations;
          return { ...s, approvals, automations };
        });
        const title = req?.title ?? "Request";
        const devices = req
          ? [...new Set(req.automation.actions.map((a) => deviceLabel(a.deviceId)))].join(", ")
          : "";
        log({
          kind: "automation",
          status: decision === "approved" ? "success" : "blocked",
          title: `${decision === "approved" ? "Approved" : "Rejected"}: ${title}`,
          detail: `${devices ? devices + " · " : ""}${PREVIEW_MESSAGE}`,
        });
        toast(decision === "approved" ? "Approved — saved as a preview automation" : "Rejected", {
          description: PREVIEW_MESSAGE,
        });
      },
      setChat: (fn) => setState((s) => ({ ...s, chat: fn(s.chat) })),
      resetDemo: () => {
        const base = initialState();
        setState((s) => ({ ...base, prefs: s.prefs }));
        toast("Demo reset", { description: "Preview settings, automations and history restored." });
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
    sendDpCommand,
    setAcControlMode,
    resumeAuto,
    log,
    previewAction,
  ]);

  return <SmartPilotContext.Provider value={value}>{children}</SmartPilotContext.Provider>;
}

export function useSmartPilot(): Ctx {
  const ctx = useContext(SmartPilotContext);
  if (!ctx) throw new Error("useSmartPilot must be used inside SmartPilotProvider");
  return ctx;
}

/** Inline script that applies the saved theme before first paint (avoids a flash). */
export const themeBootScript = `(function(){try{var s=JSON.parse(localStorage.getItem("${STORAGE_KEY}")||"{}");var t=(s.prefs&&s.prefs.theme)||"dark";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
