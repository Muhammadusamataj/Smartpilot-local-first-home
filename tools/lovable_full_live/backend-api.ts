// Thin, typed glue over the EXISTING Flask endpoints. No backend changes.
// Every write is called only from an explicit user action in the UI.

type Json = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url.replace(/^\/+/, ""), {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON replies are errors, never device state.
  }
  const data = (body && typeof body === "object" ? body : {}) as Json;
  if (!response.ok || data["error"]) {
    const code = text(data["code"]) || text(data["error"]) || `http_${response.status}`;
    throw new ApiError(code, code, response.status);
  }
  return body as T;
}

function json(method: string, url: string, body?: unknown): RequestInit {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  // Omit the key entirely for bodyless requests: under exactOptionalPropertyTypes
  // RequestInit.body cannot be explicitly undefined.
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

// --- Local preferences / home layout ---------------------------------------
export interface LocalPreferences {
  favorites: string[];
  rooms: Record<string, string>;
  homes: Array<{ id: string; name: string }>;
  updated_at?: number;
}

export const getLocalDevices = () =>
  request<{ devices: Array<{ id: string; name: string }> }>("/api/local/devices");

export const getPreferences = () => request<LocalPreferences>("/api/local/preferences");
export const savePreferences = (prefs: LocalPreferences) =>
  request<LocalPreferences>("/api/local/preferences", json("POST", "/api/local/preferences", prefs));

// --- Device management ------------------------------------------------------
export interface DeviceInput {
  name: string;
  id: string;
  local_key: string;
  ip: string;
  version?: string;
  dp?: number;
}

export const addDevice = (input: DeviceInput) =>
  request<Json>("/api/local/device", json("POST", "/api/local/device", input));
export const updateDevice = (input: Partial<DeviceInput> & { id: string }) =>
  request<Json>("/api/local/device", json("PUT", "/api/local/device", input));
export const deleteDevice = (id: string) =>
  request<Json>(`/api/local/device?id=${encodeURIComponent(id)}`, { method: "DELETE" });
export const ensureLocal = () =>
  request<Json>("/api/local/ensure", json("POST", "/api/local/ensure", {}));
export const startLanScan = (targets: string) =>
  request<Json>("/api/lan/scan", json("POST", "/api/lan/scan", { targets }));
export const getLanScan = () => request<Json>("/api/lan/scan");
export const cancelLanScan = () => request<Json>("/api/lan/scan", { method: "DELETE" });
export const getDiagnostics = (deviceId: string) =>
  request<Json>(`/api/local/diagnostics?id=${encodeURIComponent(deviceId)}`);

// --- Scenes / scheduler / rules / history ----------------------------------
export interface SceneAction {
  device_id: string;
  dp: string;
  value: unknown;
}
export interface SceneInput {
  id?: string;
  name: string;
  icon?: string;
  actions: SceneAction[];
  schedule?: { enabled: boolean; time: string; days: number[] };
}
export const getScenes = () => request<Json>("/api/local/scenes");
export const createScene = (scene: SceneInput) =>
  request<Json>("/api/local/scenes", json("POST", "/api/local/scenes", scene));
export const deleteScene = (id: string) =>
  request<Json>(`/api/local/scenes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
/** Sends real DP writes. Only call after an explicit user confirmation. */
export const runScene = (id: string) =>
  request<Json>("/api/local/scenes/run", json("POST", "/api/local/scenes/run", { id }));

export const getScheduler = () => request<Json>("/api/local/scheduler");
/** Runs due scenes (real writes). Only call from an explicit user action. */
export const tickScheduler = () =>
  request<Json>("/api/local/scheduler/tick", json("POST", "/api/local/scheduler/tick", {}));
export const getRules = () => request<Json>("/api/local/rules");
export const createRule = (rule: Json) =>
  request<Json>("/api/local/rules", json("POST", "/api/local/rules", rule));
export const deleteRule = (id: string) =>
  request<Json>(`/api/local/rules?id=${encodeURIComponent(id)}`, { method: "DELETE" });
export const getEvents = (since = 0) => request<Json>(`/api/local/events?since=${since}`);
export const getUsage = () => request<Json>("/api/local/usage");

// --- Backup / restore / updates / support / auth ----------------------------
export const BACKUP_URL = "/api/local/backup";
export const restoreBackup = (file: File) => {
  const data = new FormData();
  data.append("file", file);
  return request<Json>("/api/local/restore", { method: "POST", body: data });
};
export const getUpdates = () => request<Json>("/api/updates");
export const checkUpdates = () =>
  request<Json>("/api/updates/check", json("POST", "/api/updates/check", {}));

/** Background metadata check, throttled to once every 6 hours. Never installs. */
export async function autoCheckUpdates(): Promise<Json | null> {
  const key = "smartpilot:update-autocheck";
  try {
    const last = Number(window.localStorage.getItem(key) || 0);
    if (last && Date.now() - last < 6 * 60 * 60 * 1000) return null;
    window.localStorage.setItem(key, String(Date.now()));
    return await checkUpdates();
  } catch {
    return null;
  }
}
export const getSupportReport = (deviceId: string) =>
  request<Json>("/api/support-report", json("POST", "/api/support-report", { device_id: deviceId }));
export const getAuthState = () => request<Json>("/api/state");
export const loginStart = (userCode: string) =>
  request<Json>("/api/login/start", json("POST", "/api/login/start", { user_code: userCode }));
export const loginPoll = (token: string) =>
  request<Json>("/api/login/poll", json("POST", "/api/login/poll", { token }));
export const logout = () => request<Json>("/api/logout", json("POST", "/api/logout", {}));

// --- Haier setup / Family Hub ----------------------------------------------
export const discoverHaier = (host?: string) =>
  request<Json>(`/api/haier/discover${host ? `?host=${encodeURIComponent(host)}` : ""}`);
export const configHaier = (config: Json) =>
  request<Json>("/api/haier/config", json("POST", "/api/haier/config", config));
export const readHaier = (slot: string) =>
  request<Json>("/api/haier/read", json("POST", "/api/haier/read", { slot }));
export const pauseHaier = (slot: string) =>
  request<Json>("/api/haier/pause", json("POST", "/api/haier/pause", { slot }));
export const haierCloudStatus = () => request<Json>("/api/haier/cloud/status");
export const haierCloudLogin = (body: Json) =>
  request<Json>("/api/haier/cloud/login", json("POST", "/api/haier/cloud/login", body));
export const haierCloudLogout = () =>
  request<Json>("/api/haier/cloud/logout", json("POST", "/api/haier/cloud/logout", {}));

/**
 * Renew rotated Haier local keys using ONLY the backend's encrypted saved
 * refresh token. No username/password is stored or sent by the UI.
 * Safe to call on startup; the backend decides whether renewal is needed.
 */
export async function autoRenewHaierKeys(force = false): Promise<{
  attempted: boolean;
  ok: boolean;
  message: string;
}> {
  const throttleKey = "smartpilot:haier-autorenew-checked";
  const now = Date.now();
  try {
    const last = Number(window.localStorage.getItem(throttleKey) || 0);
    if (!force && last && now - last < 12 * 60 * 60 * 1000) {
      return { attempted: false, ok: true, message: "Checked recently" };
    }
    window.localStorage.setItem(throttleKey, String(now));
    const status = await haierCloudStatus();
    if (status["logged_in"] !== true) {
      return { attempted: false, ok: true, message: "No saved Haier session" };
    }
    const reply = await haierCloudLogin({
      username: "",
      password: "",
      remember: true,
    });
    const renewed = reply["renewed"];
    const count = renewed && typeof renewed === "object"
      ? Object.keys(renewed as Record<string, unknown>).length
      : 0;
    return {
      attempted: true,
      ok: reply["ok"] !== false,
      message: count ? `Renewed ${count} AC key${count === 1 ? "" : "s"}` : "Keys already current",
    };
  } catch (error) {
    return { attempted: true, ok: false, message: messageOf(error) };
  }
}

export const familyStatus = () => request<Json>("/api/family/status");
export const familyConfig = (body: Json) =>
  request<Json>("/api/family/config", json("POST", "/api/family/config", body));
export const familyCheck = () =>
  request<Json>("/api/family/check", json("POST", "/api/family/check", {}));
export const familyDisconnect = () =>
  request<Json>("/api/family/disconnect", json("POST", "/api/family/disconnect", {}));

// --- Android-only native bridges (no HTTP equivalent) ----------------------
interface NativeBridge {
  [key: string]: (...args: unknown[]) => unknown;
}
function native(name: string): NativeBridge | null {
  const bridge = (window as unknown as Record<string, unknown>)[name];
  return bridge && typeof bridge === "object" ? (bridge as NativeBridge) : null;
}

export function nativeUpdateState(): Json | null {
  try {
    const raw = native("PilotNative")?.["updateState"]?.();
    return raw ? (JSON.parse(String(raw)) as Json) : null;
  } catch {
    return null;
  }
}
export function nativeCall(
  bridge: string,
  method: string,
  ...args: unknown[]
): unknown {
  try {
    return native(bridge)?.[method]?.(...args) ?? null;
  } catch {
    return null;
  }
}
/** Chain listeners instead of clobbering the provider's global update callback. */
export function registerUpdateCallback(callback: (result: Json) => void): void {
  const w = window as unknown as Record<string, unknown>;
  const previous = w["pilotUpdateResult"];
  w["pilotUpdateResult"] = (raw: string) => {
    let result: Json;
    try {
      result = JSON.parse(raw) as Json;
    } catch {
      result = { ok: false, error: "invalid_native_result" };
    }
    if (typeof previous === "function") {
      try { (previous as (value: string) => void)(raw); } catch { /* isolated */ }
    }
    callback(result);
  };
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return text(error) || "request_failed";
}
