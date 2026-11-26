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
  /** Optional metadata the backend already reports for this DP. */
  unit?: string;
  scale?: number;
}

export interface DecodedPhase {
  voltage: number;
  current: number;
  power: number;
}

/** Same packed-DP code localtuya documents for Tuya `phase_a/b/c` reports. */
const PHASE_CODE = /^phase_[abc]$/i;
/** Measurement DPs Tuya reports but never accepts as a write target. */
const METER_CODE =
  /^(cur_power|cur_current|cur_voltage|add_ele\w*|total_energy|energy\w*|kwh\w*|power_consumption|phase_[abc])$/i;

export function isPhasePoint(point: { code?: string }): boolean {
  return PHASE_CODE.test(String(point.code ?? "").trim());
}

export function isMeterPoint(point: { code?: string; type?: string }): boolean {
  const code = String(point.code ?? "").trim();
  return METER_CODE.test(code);
}

/**
 * Decode the packed base64 payload Tuya sends for a phase DP.
 * Bytes 0-1 volts /10, 3-4 amps /1000, 6-7 kW /1000. No scaling is guessed:
 * an unrecognised payload returns null and the UI shows it as undecodable.
 */
export function decodePhaseDp(value: unknown): DecodedPhase | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length % 4 !== 0) return null;
  let binary: string;
  try {
    binary = atob(raw);
  } catch {
    return null;
  }
  if (binary.length < 8) return null;
  const byte = (index: number) => binary.charCodeAt(index) & 0xff;
  const round = (value: number, digits: number) => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };
  return {
    voltage: round((((byte(0) << 8) | byte(1)) / 10), 1),
    current: round((((byte(3) << 8) | byte(4)) / 1000), 3),
    power: round((((byte(6) << 8) | byte(7)) / 1000), 3),
  };
}

export const PHASE_READINGS = [
  { key: "voltage", label: "Voltage", unit: "V", digits: 1 },
  { key: "current", label: "Current", unit: "A", digits: 3 },
  { key: "power", label: "Power", unit: "kW", digits: 3 },
] as const;

/** A plain DP value formatted with the backend's own unit/scale, if any. */
export function formatPointValue(point: LiveDpPoint): string {
  const value = point.value;
  if (value === undefined || value === null || value === "") return "—";
  const scale = typeof point.scale === "number" ? point.scale : 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    const scaled = scale > 0 ? value / 10 ** scale : value;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(scaled < 1 ? 2 : 1)}${
      point.unit ? ` ${point.unit}` : ""
    }`;
  }
  return point.unit ? `${String(value)} ${point.unit}` : String(value);
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
  if (!row || !Array.isArray(row["points"])) return [];
  return row["points"].map(record).filter((point): point is JsonRecord => point !== null);
}

function pointMeta(point: JsonRecord): Omit<LiveDpPoint, "value"> {
  const unit = text(point["unit"]);
  const rawScale = point["scale"];
  const scale = typeof rawScale === "number" && Number.isFinite(rawScale) ? rawScale : undefined;
  return {
    dp: text(point["dp"]),
    code: text(point["code"]),
    type: text(point["type"]),
    ...(unit ? { unit } : {}),
    ...(scale === undefined ? {} : { scale }),
  };
}

/**
 * Merge the cached DP specification with a fresh status read. The spec carries
 * unit/scale/type, the read carries values. A DP that only appears in the live
 * read is still listed instead of being dropped silently.
 */
function mergePoints(spec: JsonRecord[], values: JsonRecord[]): LiveDpPoint[] {
  const byDp = new Map<string, LiveDpPoint>();
  for (const point of spec) {
    const meta = pointMeta(point);
    if (meta.dp) byDp.set(meta.dp, meta);
  }
  for (const item of values) {
    const meta = pointMeta(item);
    if (!meta.dp) continue;
    const existing = byDp.get(meta.dp);
    byDp.set(meta.dp, {
      ...existing,
      ...meta,
      code: meta.code || existing?.code || "",
      type: meta.type || existing?.type || "",
      value: item["value"],
    });
  }
  return [...byDp.values()];
}

/**
 * Only an explicitly boolean switch point may be written. Numeric meter DPs
 * such as `cur_power` are never treated as relays.
 */
function switchDp(row: JsonRecord | null): string | null {
  const points = pointsOf(row);
  const named = points.find((point) => {
    const code = text(point["code"]);
    const type = text(point["type"]).toLowerCase();
    return type.includes("bool") && /switch|relay|onoff|power/i.test(code);
  });
  if (named && text(named["dp"])) return text(named["dp"]);
  const first = points.find(
    (point) => text(point["dp"]) === "1" && text(point["type"]).toLowerCase().includes("bool"),
  );
  return first ? "1" : null;
}

/** Location comes only from backend metadata; an absent room stays null. */
function locationOf(row: JsonRecord): string | null {
  const direct = text(row["room_name"]);
  if (direct) return direct;
  const nested = record(row["room"]);
  return nested ? text(nested["name"]) || null : null;
}

/** Preserve the pinned display shape for known names; classify others conservatively. */
function switchShape(row: JsonRecord, name: string): Pick<SwitchDevice, "kind" | "category"> {
  const known = DEVICES.find(
    (device): device is SwitchDevice =>
      device.kind !== "air_conditioner" && device.name.toLowerCase() === name.toLowerCase(),
  );
  if (known) return { kind: known.kind, category: known.category };
  const haystack = `${text(row["category"])} ${text(row["product_name"])} ${name}`.toLowerCase();
  if (/breaker|circuit|cz\b/.test(haystack)) return { kind: "breaker", category: "power" };
  if (/heater|geyser|heating/.test(haystack)) return { kind: "water_heater", category: "heating" };
  return { kind: "water_pump", category: "water" };
}

/**
 * Capabilities are only claimed when the cached DP specification supports
 * them. A boolean switch DP is the only writable power control; measurement
 * DPs are the only basis for an energy-metering claim.
 */
function switchCapabilities(row: JsonRecord): SwitchDevice["capabilities"] {
  const hasSwitch = switchDp(row) !== null;
  const hasMeter = pointsOf(row).some((point) => {
    const type = text(point["type"]).toLowerCase();
    const code = text(point["code"]).toLowerCase();
    return (
      /int|number|float|double|energy/.test(type) &&
      /energy|kwh|power|watt|consumption|current|voltage/.test(code)
    );
  });
  return {
    power: hasSwitch ? "supported" : "unverified",
    timer: "unverified",
    energyMetering: hasMeter ? "supported" : "unverified",
  };
}

/** Fresh AC object from the fixed contract; live status is filled in by refresh(). */
function acTemplate(name: string): AcDevice | null {
  const found = DEVICES.find(
    (device): device is AcDevice =>
      device.kind === "air_conditioner" && device.name === name,
  );
  if (!found) return null;
  return {
    ...found,
    capabilities: {
      ...found.capabilities,
      modes: { ...found.capabilities.modes },
      fanSpeeds: { ...found.capabilities.fanSpeeds },
    },
    connection: "offline",
    lastSeen: { known: false },
    power: { known: false },
    roomTemperature: { known: false },
  };
}

function messageOf(body: unknown, fallback: string): string {
  const data = record(body);
  if (!data) return fallback;
  return text(data["code"]) || text(data["message"]) || text(data["error"]) || fallback;
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
  const ok = reply["ok"] === true && reply["confirmed"] !== false;
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
  private _liveDevices: Device[] = [];

  get isLive(): boolean {
    return this._isLive;
  }

  /** The backend-derived catalogue. Empty until the first refresh succeeds. */
  get liveDevices(): Device[] {
    return this._liveDevices;
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
    const device = this._liveDevices.find((item) => item.id === deviceId);
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
    // Measurement DPs (packed phase reports, meter counters) are read-only in
    // Tuya. Refuse them here so no UI path can ever send a meaningless write.
    if (isPhasePoint(point) || isMeterPoint(point)) {
      return failure("read_only_measurement");
    }
    let coerced: unknown = value;
    if (/bool/i.test(point.type)) coerced = value === true || value === "true" || value === "1";
    else if (/int|number/i.test(point.type)) coerced = Number(value);
    if (typeof coerced !== "boolean" && !Number.isFinite(Number(coerced))) {
      return failure("invalid_value");
    }
    try {
      const reply = await postJson(`${LOCAL}/command`, {
        device_id: text(row["id"]),
        dp: String(dp),
        value: coerced,
      });
      return delivered(reply);
    } catch (error) {
      return failure((error as Error).message);
    }
  }

  async listDevices(): Promise<Device[]> {
    return this._liveDevices.map(cloneDevice);
  }

  async getStatus(deviceId: string) {
    const device = this._liveDevices.find((item) => item.id === deviceId);
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
      if (Array.isArray(catalogue["devices"])) {
        localRows = catalogue["devices"].map(record).filter(
          (row): row is JsonRecord => row !== null,
        );
      }
    } catch (error) {
      errors.push(`local_catalogue: ${(error as Error).message}`);
    }

    this._localRows = new Map();
    const nextPoints: Record<string, LiveDpPoint[]> = {};
    const nextDevices: Device[] = [];
    const seenIds = new Set<string>();
    for (const row of localRows) {
      const name = text(row["name"]);
      const id = text(row["id"]);
      // One honest card per backend row; rows without a name/id or with a
      // duplicate id are skipped instead of guessing a Lovable identity.
      if (!name || !id || seenIds.has(id)) continue;
      seenIds.add(id);
      const shape = switchShape(row, name);
      const device: SwitchDevice = {
        id,
        name,
        location: locationOf(row),
        kind: shape.kind,
        category: shape.category,
        ecosystem: "tuya_smart_life",
        // Every local load is high-risk and the backend refuses unverified
        // writes; keep the explicit-approval gate on all of them.
        requiresApproval: true,
        connection:
          row["verified"] === true ? "online" : row["lan_known"] === true ? "disconnected" : "offline",
        lastSeen: reportedString(row["checked_at"] ?? row["last_ok"] ?? row["last_read"]),
        power: { known: false },
        capabilities: switchCapabilities(row),
      };
      nextDevices.push(device);
      // Commands are keyed by the backend id, exactly as the row reports it.
      this._localRows.set(id, row);
      // Count only an actual fresh status read below; the catalogue flag alone
      // is a cached claim and must not inflate the verified-device count.
      try {
        const status = await requestJson(`${LOCAL}/status?id=${encodeURIComponent(id)}`);
        if (status["status"] !== "ok") {
          errors.push(`${name}: ${messageOf(status, "read_failed")}`);
          nextPoints[id] = mergePoints(pointsOf(row), []);
          continue;
        }
        device.lastSeen = reportedString(status["read_at"] ?? row["checked_at"]);
        verifiedDevices += 1;
        this._isLive = true;
        const values = Array.isArray(status["values"])
          ? status["values"].map(record).filter((item): item is JsonRecord => item !== null)
          : [];
        nextPoints[id] = mergePoints(pointsOf(row), values);
        const dp = switchDp(row);
        if (dp) {
          const point = values.find((item) => text(item["dp"]) === dp);
          const onOff = point ? isOnish(point["value"]) : null;
          if (onOff !== null) {
            device.power = reportedOnOff(onOff, status["read_at"] ?? row["checked_at"]);
          }
        }
      } catch (error) {
        errors.push(`${name}: ${(error as Error).message}`);
        nextPoints[id] = mergePoints(pointsOf(row), []);
      }
    }
    this._localPoints = nextPoints;

    let haierRows: JsonRecord[] = [];
    try {
      const catalogue = await requestJson(`${HAIER}/devices`);
      if (Array.isArray(catalogue["devices"])) {
        haierRows = catalogue["devices"].map(record).filter(
          (row): row is JsonRecord => row !== null,
        );
      }
    } catch (error) {
      errors.push(`haier_catalogue: ${(error as Error).message}`);
    }
    const haierByName = new Map<string, JsonRecord>();
    for (const row of haierRows) {
      const name = text(row["name"]);
      if (name && !haierByName.has(name)) haierByName.set(name, row);
    }

    const nextAcStatus: Record<string, HaierLiveStatus> = {};
    const nextModes: Record<string, "manual" | "auto"> = {};
    const nextPause: Record<string, number> = {};
    // Only the two fixed Haier slots exist. An AC is shown only when the
    // backend actually reports that slot — never a demo card for a missing AC.
    for (const [name, slot] of Object.entries(HAIER_SLOT)) {
      const template = acTemplate(name);
      const backendRow = haierByName.get(name) ?? null;
      if (!template || !backendRow) continue;
      const device: AcDevice = template;
      nextDevices.push(device);
      let summary: JsonRecord | null = backendRow;
      let status: JsonRecord | null = null;
      try {
        const polled = await postJson(`${HAIER}/poll`, { slot });
        if (polled["ok"] !== false) {
          status = record(polled["status"]);
          summary = record(polled["device"]) ?? summary;
        }
      } catch (error) {
        errors.push(`${name}: ${(error as Error).message}`);
      }
      // A successful poll is itself a fresh read. If polling was blocked, a
      // still-fresh backend summary is the second honest source.
      const statusData = status ?? record(summary?.["status"]);
      const fresh = status !== null || summary?.["verified"] === true;
      device.connection = fresh
        ? "online"
        : summary?.["configured"] === true
          ? "disconnected"
          : "offline";
      device.lastSeen = reportedString(summary?.["last_read"] ?? (statusData ? at : null));
      device.power = { known: false };
      if (summary?.["mode"] === "manual" || summary?.["mode"] === "auto") {
        nextModes[device.id] = summary["mode"];
      }
      if (typeof summary?.["pause_until"] === "number") {
        nextPause[device.id] = summary["pause_until"];
      }
      if (fresh) {
        verifiedDevices += 1;
        this._isLive = true;
      }

      const live: HaierLiveStatus = {};
      if (statusData) {
        if (typeof statusData["power_on"] === "boolean") {
          live.power = reportedOnOff(statusData["power_on"], summary?.["last_read"] ?? at);
          device.power = live.power;
        }
        if (typeof statusData["target_c"] === "number") live.targetTemp = statusData["target_c"];
        if (typeof statusData["hvac_mode"] === "string" && AC_MODES.has(statusData["hvac_mode"])) {
          live.mode = statusData["hvac_mode"];
        }
        if (typeof statusData["fan"] === "string" && FAN_SPEEDS.has(statusData["fan"])) {
          live.fan = statusData["fan"];
        }
        if (typeof statusData["room_c"] === "number") {
          live.roomTemperature = {
            known: true,
            value: statusData["room_c"],
            at: iso(summary?.["last_read"]) ?? at,
          };
          device.roomTemperature = live.roomTemperature;
        }
        if (typeof statusData["sleep"] === "boolean") live.sleep = statusData["sleep"];
        if (typeof statusData["eco_level"] === "number") live.eco = statusData["eco_level"] === 5;
      }
      nextAcStatus[device.id] = live;
    }
    this._haierStatus = nextAcStatus;
    this._haierModes = nextModes;
    this._haierPauseUntil = nextPause;
    this._liveDevices = nextDevices;

    // Never latch a successful read forever: once no device is freshly
    // verified, commands must be held again.
    this._isLive = verifiedDevices > 0;
    return { verifiedDevices, errors, at };
  }

  async sendCommand(
    deviceId: string,
    command: DeviceCommand,
    approval?: { approvedBy: string; approvedAt: string },
  ): Promise<CommandResult> {
    const device = this._liveDevices.find((item) => item.id === deviceId);
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
    const device = this._liveDevices.find((item) => item.id === deviceId);
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
        device_id: text(row["id"]),
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
