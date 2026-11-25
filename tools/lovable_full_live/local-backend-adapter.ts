// Build-time patch for the pinned Lovable Titanium UI.
//
// This adapter is copied into the offline WebView source by
// tools/build_lovable_webview.py. It is presentation-layer glue only:
//   - every read comes from the existing /api/local/* and /api/haier/* routes;
//   - every write goes through the existing Flask endpoints and their
//     server-side safety gates (no protocol, key or backend changes);
//   - no value is reported as "known" unless a real read returned it;
//   - unverified devices stay unknown/disconnected and cannot be commanded.

import { DEVICES } from "./devices";
import type {
  AcDevice,
  CommandResult,
  Device,
  DeviceAdapter,
  DeviceCommand,
  Reported,
  SwitchDevice,
} from "./types";

const LOCAL = "/api/local";
const HAIER = "/api/haier";

/** Fixed Haier slots from the existing backend. Names are part of the contract. */
const HAIER_SLOT: Record<string, string> = {
  "19HFAB T3 Pro": "pro",
  "FF Haier 19HFAB T3": "ff",
};

const AC_MODES = new Set(["auto", "cool", "dry", "fan", "heat"]);
const FAN_SPEEDS = new Set(["auto", "low", "medium", "high", "turbo"]);

interface JsonRecord {
  [key: string]: unknown;
}

export interface LiveRefreshResult {
  verifiedDevices: number;
  errors: string[];
  at: string;
}

export interface LiveDpPoint {
  dp: string;
  code: string;
  type: string;
  value?: unknown;
}

export interface HaierLiveStatus {
  power?: Reported<"on" | "off">;
  targetTemp?: number;
  mode?: string;
  fan?: string;
  roomTemperature?: Reported<number>;
  eco?: boolean;
  sleep?: boolean;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function iso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function reportedString(value: unknown): Reported<string> {
  const at = iso(value);
  return at ? { known: true, value: at, at } : { known: false };
}

function reportedOnOff(value: unknown, at: unknown): Reported<"on" | "off"> {
  if (typeof value !== "boolean") return { known: false };
  const stamp = iso(at) ?? new Date().toISOString();
  return { known: true, value: value ? "on" : "off", at: stamp };
}

function isOnish(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return null;
}

function pointsOf(row: JsonRecord | null): JsonRecord[] {
  if (!row || !Array.isArray(row.points)) return [];
  return row.points.map(record).filter((point): point is JsonRecord => point !== null);
}

/**
 * Only an explicitly boolean switch point may be written. Numeric meter DPs
 * such as `cur_power` are never treated as relays.
 */
function switchDp(row: JsonRecord | null): string | null {
  const points = pointsOf(row);
  const named = points.find((point) => {
    const code = text(point.code);
    const type = text(point.type).toLowerCase();
    return type.includes("bool") && /switch|relay|onoff|power/i.test(code);
  });
  if (named && text(named.dp)) return text(named.dp);
  const first = points.find(
    (point) => text(point.dp) === "1" && text(point.type).toLowerCase().includes("bool"),
  );
  return first ? "1" : null;
}

function messageOf(body: unknown, fallback: string): string {
  const data = record(body);
  if (!data) return fallback;
  return text(data.code) || text(data.message) || text(data.error) || fallback;
}

async function requestJson(url: string, init: RequestInit = {}): Promise<JsonRecord> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON reply is still an error, never a device status claim.
  }
  if (!response.ok) throw new Error(messageOf(body, `http_${response.status}`));
  return record(body) ?? {};
}

function postJson(url: string, body: JsonRecord): Promise<JsonRecord> {
  return requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cloneDevice(device: Device): Device {
  return { ...device } as Device;
}

function failure(message: string): CommandResult {
  return { delivered: false, mode: "live", message };
}

function delivered(reply: JsonRecord): CommandResult {
  const ok = reply.ok === true && reply.confirmed !== false;
  return {
    delivered: ok,
    mode: "live",
    message: ok ? "confirmed" : messageOf(reply, "not_confirmed"),
  };
}

/** Live DeviceAdapter for the offline Smart Pilot WebView. */
export class LocalBackendAdapter implements DeviceAdapter {
  readonly id = "local";
  readonly label = "Local LAN backend (live)";
  private _isLive = false;
  private _localRows = new Map<string, JsonRecord>();
  private _haierStatus: Record<string, HaierLiveStatus> = {};
  private _haierModes: Record<string, "manual" | "auto"> = {};
  private _haierPauseUntil: Record<string, number> = {};
  private _localPoints: Record<string, LiveDpPoint[]> = {};

  get isLive(): boolean {
    return this._isLive;
  }

  get haierStatus(): Record<string, HaierLiveStatus> {
    return this._haierStatus;
  }

  get haierModes(): Record<string, "manual" | "auto"> {
    return this._haierModes;
  }

  get haierPauseUntil(): Record<string, number> {
    return this._haierPauseUntil;
  }

  get localPoints(): Record<string, LiveDpPoint[]> {
    return this._localPoints;
  }

  /** Last verified data points for one Tuya device. Never inferred. */
  pointsFor(deviceId: string): LiveDpPoint[] {
    return this._localPoints[deviceId] ?? [];
  }

  /**
   * Write one verified data point through the existing command gate.
   * The backend still performs the critical-write refusal and DP coercion.
   */
  async sendDp(
    deviceId: string,
    dp: string,
    value: unknown,
    approval?: { approvedBy: string; approvedAt: string },
  ): Promise<CommandResult> {
    const device = DEVICES.find((item) => item.id === deviceId);
    if (!device || device.kind === "air_conditioner") return failure("unknown_device");
    if (device.requiresApproval && (!approval?.approvedBy || !approval?.approvedAt)) {
      return failure("needs_approval");
    }
    if (!this._isLive) {
      return {
        delivered: false,
        mode: "preview",
        message: "Waiting for a verified local read — command not sent.",
      };
    }
    const row = this._localRows.get(deviceId);
    if (!row) return failure("unknown_device");
    const point = this.pointsFor(deviceId).find((item) => item.dp === String(dp));
    if (!point) return failure("unknown_dp");
    let coerced: unknown = value;
    if (/bool/i.test(point.type)) coerced = value === true || value === "true" || value === "1";
    else if (/int|number/i.test(point.type)) coerced = Number(value);
    if (typeof coerced !== "boolean" && !Number.isFinite(Number(coerced))) {
      return failure("invalid_value");
    }
    try {
      const reply = await postJson(`${LOCAL}/command`, {
        device_id: text(row.id),
        dp: String(dp),
        value: coerced,
      });
      return delivered(reply);
    } catch (error) {
      return failure((error as Error).message);
    }
  }

  async listDevices(): Promise<Device[]> {
    return DEVICES.map(cloneDevice);
  }

  async getStatus(deviceId: string) {
    const device = DEVICES.find((item) => item.id === deviceId);
    return {
      connection: device?.connection ?? ("unknown" as const),
      lastSeen: device?.lastSeen ?? ({ known: false } as const),
      power: device?.power ?? ({ known: false } as const),
    };
  }

  /**
   * Refresh from the existing LAN backends. `/status` and `/haier/poll` are
   * read-only; no actuator is touched here. A device is online only when the
   * backend reports a verified fresh read.
   */
  async refresh(): Promise<LiveRefreshResult> {
    const errors: string[] = [];
    let verifiedDevices = 0;
    const at = new Date().toISOString();

    let localRows: JsonRecord[] = [];
    try {
      const catalogue = await requestJson(`${LOCAL}/devices`);
      if (Array.isArray(catalogue.devices)) {
        localRows = catalogue.devices.map(record).filter(
          (row): row is JsonRecord => row !== null,
        );
      }
    } catch (error) {
      errors.push(`local_catalogue: ${(error as Error).message}`);
    }

    this._localRows = new Map();
    const nextPoints: Record<string, LiveDpPoint[]> = {};
    const localByName = new Map<string, JsonRecord>();
    for (const row of localRows) {
      const name = text(row.name);
      const id = text(row.id);
      if (!name || !id) continue;
      if (!localByName.has(name)) localByName.set(name, row);
      else localByName.set(name, {}); // duplicate names are never claimed
    }

    for (const device of DEVICES) {
      if (device.kind === "air_conditioner") continue;
      const row = localByName.get(device.name) ?? null;
      if (!row || Object.keys(row).length === 0) {
        device.connection = "offline";
        device.lastSeen = { known: false };
        device.power = { known: false };
        nextPoints[device.id] = [];
        continue;
      }
      // Key commands by the Lovable device id, not the backend row id.
      this._localRows.set(device.id, row);
      device.connection =
        row.verified === true ? "online" : row.lan_known === true ? "disconnected" : "offline";
      device.lastSeen = reportedString(row.checked_at ?? row.last_ok ?? row.last_read);
      device.power = { known: false };
      if (row.verified === true) verifiedDevices += 1;

      try {
        const status = await requestJson(
          `${LOCAL}/status?id=${encodeURIComponent(text(row.id))}`,
        );
        if (status.status !== "ok") {
          errors.push(`${device.name}: ${messageOf(status, "read_failed")}`);
          continue;
        }
        device.connection = "online";
        device.lastSeen = reportedString(status.read_at ?? row.checked_at);
        verifiedDevices += 1;
        this._isLive = true;
        const values = Array.isArray(status.values)
          ? status.values.map(record).filter((item): item is JsonRecord => item !== null)
          : [];
        nextPoints[device.id] = values.map((item) => ({
          dp: text(item.dp), code: text(item.code), type: text(item.type), value: item.value,
        }));
        const dp = switchDp(row);
        if (dp) {
          const point = values.find((item) => text(item.dp) === dp);
          const onOff = point ? isOnish(point.value) : null;
          if (onOff !== null) {
            device.power = reportedOnOff(onOff, status.read_at ?? row.checked_at);
          }
        }
      } catch (error) {
        errors.push(`${device.name}: ${(error as Error).message}`);
        nextPoints[device.id] = pointsOf(row).map((item) => ({
          dp: text(item.dp), code: text(item.code), type: text(item.type),
        }));
      }
    }
    this._localPoints = nextPoints;

    let haierRows: JsonRecord[] = [];
    try {
      const catalogue = await requestJson(`${HAIER}/devices`);
      if (Array.isArray(catalogue.devices)) {
        haierRows = catalogue.devices.map(record).filter(
          (row): row is JsonRecord => row !== null,
        );
      }
    } catch (error) {
      errors.push(`haier_catalogue: ${(error as Error).message}`);
    }
    const haierByName = new Map<string, JsonRecord>();
    for (const row of haierRows) {
      const name = text(row.name);
      if (name && !haierByName.has(name)) haierByName.set(name, row);
    }

    const nextAcStatus: Record<string, HaierLiveStatus> = {};
    const nextModes: Record<string, "manual" | "auto"> = {};
    const nextPause: Record<string, number> = {};
    for (const device of DEVICES) {
      if (device.kind !== "air_conditioner") continue;
      let summary = haierByName.get(device.name) ?? null;
      let status: JsonRecord | null = null;
      const slot = HAIER_SLOT[device.name];
      if (slot) {
        try {
          const polled = await postJson(`${HAIER}/poll`, { slot });
          if (polled.ok !== false) {
            status = record(polled.status);
            summary = record(polled.device) ?? summary;
          }
        } catch (error) {
          errors.push(`${device.name}: ${(error as Error).message}`);
        }
      }
      const fresh = summary?.verified === true;
      device.connection = fresh
        ? "online"
        : summary?.configured === true
          ? "disconnected"
          : "offline";
      device.lastSeen = reportedString(summary?.last_read);
      device.power = { known: false };
      if (summary?.mode === "manual" || summary?.mode === "auto") {
        nextModes[device.id] = summary.mode;
      }
      if (typeof summary?.pause_until === "number") {
        nextPause[device.id] = summary.pause_until;
      }
      if (fresh) {
        verifiedDevices += 1;
        this._isLive = true;
      }

      const live: HaierLiveStatus = {};
      if (status) {
        if (typeof status.power_on === "boolean") {
          live.power = reportedOnOff(status.power_on, summary?.last_read);
          device.power = live.power;
        }
        if (typeof status.target_c === "number") live.targetTemp = status.target_c;
        if (typeof status.hvac_mode === "string" && AC_MODES.has(status.hvac_mode)) {
          live.mode = status.hvac_mode;
        }
        if (typeof status.fan === "string" && FAN_SPEEDS.has(status.fan)) {
          live.fan = status.fan;
        }
        if (typeof status.room_c === "number") {
          live.roomTemperature = {
            known: true,
            value: status.room_c,
            at: iso(summary?.last_read) ?? at,
          };
          device.roomTemperature = live.roomTemperature;
        }
        if (typeof status.sleep === "boolean") live.sleep = status.sleep;
        if (typeof status.eco_level === "number") live.eco = status.eco_level === 5;
      }
      nextAcStatus[device.id] = live;
    }
    this._haierStatus = nextAcStatus;
    this._haierModes = nextModes;
    this._haierPauseUntil = nextPause;

    return { verifiedDevices, errors, at };
  }

  async sendCommand(
    deviceId: string,
    command: DeviceCommand,
    approval?: { approvedBy: string; approvedAt: string },
  ): Promise<CommandResult> {
    const device = DEVICES.find((item) => item.id === deviceId);
    if (!device) return failure("unknown_device");
    if (device.requiresApproval && (!approval?.approvedBy || !approval?.approvedAt)) {
      return failure("needs_approval");
    }
    if (!this._isLive) {
      return {
        delivered: false,
        mode: "preview",
        message: "Waiting for a verified local read — command not sent.",
      };
    }
    if (device.kind === "air_conditioner") {
      return this._sendHaier(device, command);
    }
    return this._sendSwitch(device, command);
  }

  async setAcControlMode(deviceId: string, mode: "manual" | "auto"): Promise<CommandResult> {
    const device = DEVICES.find((item) => item.id === deviceId);
    const slot = device ? HAIER_SLOT[device.name] : null;
    if (!device || device.kind !== "air_conditioner" || !slot) return failure("unknown_device");
    try {
      const reply = await postJson(`${HAIER}/mode`, { slot, mode });
      return delivered(reply);
    } catch (error) {
      return failure((error as Error).message);
    }
  }

  async resumeAuto(deviceId: string): Promise<CommandResult> {
    return this.setAcControlMode(deviceId, "auto");
  }

  private async _sendSwitch(device: SwitchDevice, command: DeviceCommand): Promise<CommandResult> {
    if (command.type !== "power") return failure("unsupported_switch_command");
    const row = this._localRows.get(device.id);
    const dp = switchDp(row ?? null);
    if (!row || !dp) return failure("unknown_control_dp");
    try {
      const reply = await postJson(`${LOCAL}/command`, {
        device_id: text(row.id),
        dp,
        value: command.value === "on",
      });
      return delivered(reply);
    } catch (error) {
      return failure((error as Error).message);
    }
  }

  private async _sendHaier(device: AcDevice, command: DeviceCommand): Promise<CommandResult> {
    const slot = HAIER_SLOT[device.name];
    if (!slot) return failure("unknown_device");
    let name = "";
    let value: string | number | boolean;
    switch (command.type) {
      case "power":
        name = "power";
        value = command.value === "on";
        break;
      case "setTemperature":
        if (!Number.isInteger(command.value) || command.value < 16 || command.value > 30) {
          return failure("unsupported_temperature");
        }
        name = "temperature";
        value = command.value;
        break;
      case "setMode":
        if (command.value === "heat") return failure("unsupported_mode");
        name = "mode";
        value = command.value;
        break;
      case "setFan":
        if (command.value === "turbo") return failure("unsupported_fan");
        name = "fan";
        value = command.value;
        break;
      case "setFeature":
        // The backend supports eco, sleep (nightSleep) and quiet booleans.
        name = command.feature === "nightSleep" ? "sleep" : command.feature;
        value = command.value;
        break;
      default:
        return failure("unknown_command");
    }
    try {
      const reply = await postJson(`${HAIER}/command`, { slot, command: name, value });
      return delivered(reply);
    } catch (error) {
      return failure((error as Error).message);
    }
  }
}

export const adapter = new LocalBackendAdapter();
