// Typed local-backend adapter for the Smart Pilot premium UI.
//
// This module maps the existing Flask /api/local/* LAN backend onto the typed
// domain used by the Lovable premium UI (Device, AcDevice, SwitchDevice,
// DeviceCommand, CommandResult, Reported<T>). It is presentation-layer only:
//
//   - it never modifies the Python backend, protocols, auth or API contracts;
//   - it never fabricates live status or telemetry — Reported<T> is
//     { known: true } only when a real device read returned the value;
//   - it keeps real hardware commands gated behind the adapter's isLive flag
//     and behind explicit approval for requiresApproval devices.
//
// Import and construct it where the UI needs a typed device layer:
//
//   import { LocalBackendAdapter } from "./adapter.js";
//   const adapter = new LocalBackendAdapter();
//   const devices = await adapter.listDevices();

import { api } from "./api.js";
import { deviceKind, capabilities, capabilityTitle } from "./model.js";

/** Backend base path. All requests are relative so HA ingress prefixes work. */
const BASE = "/api/local";

// ---------------------------------------------------------------------------
// Domain types (JSDoc mirrors of src/lib/smartpilot/types.ts in the Lovable UI)
// ---------------------------------------------------------------------------

/** @typedef { "online" | "offline" | "disconnected" | "unknown" } ConnectionStatus */
/** @typedef { "supported" | "unverified" | "unsupported" } CapabilityStatus */
/** @typedef { "cool" | "dry" | "fan" | "auto" | "heat" } AcMode */
/** @typedef { "auto" | "low" | "medium" | "high" | "turbo" } FanSpeed */
/** @typedef { "manual" | "auto" } ControlMode */
/** @typedef { "air_conditioner" | "water_pump" | "breaker" | "water_heater" } DeviceKind */
/** @typedef { "climate" | "water" | "power" | "heating" } DeviceCategory */
/** @typedef { "haier_haismart" | "tuya_smart_life" } Ecosystem */

/**
 * A value that may or may not have been reported by a real device.
 * { known: true, value, at } only from a genuine device read.
 * @template T
 */
/** @typedef { { known: true, value: T, at: string } | { known: false } } Reported */

/** @typedef { { modes: Record<AcMode, CapabilityStatus> } & { fanSpeeds: Record<FanSpeed, CapabilityStatus>, eco: CapabilityStatus, nightSleep: CapabilityStatus, quiet: CapabilityStatus, energyMetering: CapabilityStatus, minTemp: number, maxTemp: number } } AcCapabilities */

/** @typedef { { power: CapabilityStatus, timer: CapabilityStatus, energyMetering: CapabilityStatus } } SwitchCapabilities */

/** @typedef { { id: string, name: string, location: string | null, ecosystem: Ecosystem, category: DeviceCategory, requiresApproval: boolean, connection: ConnectionStatus, lastSeen: Reported<string>, power: Reported<"on" | "off"> } } DeviceBase */

/**
 * @typedef { DeviceBase & { kind: "air_conditioner", model: string, capabilities: AcCapabilities, roomTemperature: Reported<number> } } AcDevice */
/** @typedef { DeviceBase & { kind: Exclude<DeviceKind, "air_conditioner">, capabilities: SwitchCapabilities } } SwitchDevice */
/** @typedef { AcDevice | SwitchDevice } Device */

/**
 * @typedef { { type: "power", value: "on" | "off" } | { type: "setTemperature", value: number } | { type: "setMode", value: AcMode } | { type: "setFan", value: FanSpeed } | { type: "setFeature", feature: "eco" | "nightSleep" | "quiet", value: boolean } } DeviceCommand */

/** @typedef { { delivered: boolean, mode: "preview" | "live", message: string } } CommandResult */

/**
 * @typedef { { id: string, label: string, isLive: boolean, listDevices: () => Promise<Device[]>, getStatus: (deviceId: string) => Promise<{ connection: ConnectionStatus, lastSeen: Reported<string>, power: Reported<"on"|"off"} }>, sendCommand: (deviceId: string, command: DeviceCommand, approval?: { approvedBy: string, approvedAt: string }) => Promise<CommandResult> } } DeviceAdapter */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const notReported = /** @type {Reported<never>} */ ({ known: false });

const ISO = () => new Date().toISOString();

/** A category requires explicit human approval for any action. */
function requiresApprovalByCategory(category) {
  return category !== "climate";
}

/** Haier ACs live on HaiSmart; everything else is catalogued as Tuya/Smart Life. */
function ecosystemByCategory(category) {
  return category === "climate" ? "haier_haismart" : "tuya_smart_life";
}

/** The two fixed Haier AC slots, preserved by name as in the Lovable catalog. */
const HAIER_SLOT = {
  "19HFAB T3 Pro": "pro",
  "FF Haier 19HFAB T3": "ff",
};

/** Canonical display order for the fixed Haier slots (matches the backend). */
const HAIER_ORDER = { pro: 0, ff: 1 };

/** Map a backend device row to a typed Device. Live fields come only from reads. */
function mapRowToDevice(row) {
  const id = String(row.id || "");
  const name = String(row.name || id);
  const category = /** @type {DeviceCategory} */ (row.category || "plug");
  const model = String(row.product_name || name);
  const location = row.room_name || null;
  const ecosystem = ecosystemByCategory(category);
  const requiresApproval = requiresApprovalByCategory(category);
  const verified = Boolean(row.verified);
  const lanKnown = Boolean(row.lan_known);
  const connection = verified
    ? "online"
    : lanKnown
      ? "disconnected"
      : "offline";

  const caps = capabilities(
    { ...row, name, product_name: row.product_name },
    row.points || [],
  );

  // Build typed capabilities from real DP points only. Unsupported/unknown
  // capabilities stay "unverified" — never claimed supported without evidence.
  const acCaps = /** @type {AcCapabilities} */ ({
    modes: { cool: "unsupported", dry: "unsupported", fan: "unsupported", auto: "unsupported", heat: "unsupported" },
    fanSpeeds: { auto: "unsupported", low: "unsupported", medium: "unsupported", high: "unsupported", turbo: "unsupported" },
    eco: "unsupported", nightSleep: "unsupported", quiet: "unsupported", energyMetering: "unsupported",
    minTemp: 16, maxTemp: 30,
  });
  const switchCaps = /** @type {SwitchCapabilities} */ ({ power: "unsupported", timer: "unverified", energyMetering: "unverified" });

  for (const control of caps.controls || []) {
    const c = String(control.code || "").toLowerCase();
    const supported = (control.kind === "switch" || control.kind === "choice" || control.kind === "slider") ? "supported" : "unverified";
    if (category === "climate") {
      if (/mode/.test(c)) {
        for (const m of Object.keys(acCaps.modes)) {
          if (c.includes(m) || c.includes(m.replace("set_", ""))) acCaps.modes[m] = supported;
        }
      }
      if (/fan|speed|wind/.test(c)) {
        for (const f of Object.keys(acCaps.fanSpeeds)) {
          if (c.includes(f)) acCaps.fanSpeeds[f] = supported;
        }
      }
      if (/eco/.test(c)) acCaps.eco = supported;
      if (/night|sleep/.test(c)) acCaps.nightSleep = supported;
      if (/quiet/.test(c)) acCaps.quiet = supported;
      if (/meter|kwh|energy/.test(c)) acCaps.energyMetering = supported;
      if (/temp/.test(c)) acCaps.minTemp = 16, acCaps.maxTemp = 30; // catalog default for known Haier units
    } else {
      if (/power|switch|relay|onoff/.test(c)) switchCaps.power = supported;
    }
  }

  /** @type {Reported<string>} */
  const lastSeen = verified ? { known: true, value: String(row.ip || ""), at: ISO() } : notReported;
  /** @type {Reported<"on"|"off">} */
  const power = notReported; // populated by getStatus() from a real read

  if (category === "climate") {
    return {
      id, name, model, kind: "air_conditioner", category, ecosystem, location, requiresApproval,
      connection, lastSeen, power, roomTemperature: notReported, capabilities: acCaps,
    };
  }
  return {
    id, name, model, kind: /pump|motor/.test(category) ? "water_pump" : /breaker/.test(category) ? "breaker" : "water_heater",
    category, ecosystem, location, requiresApproval, connection, lastSeen, power,
    capabilities: switchCaps,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class LocalBackendAdapter {
  /** Stable adapter id. */
  get id() { return "local"; }
  /** Human-readable label shown in integration status. */
  get label() { return "Local LAN backend"; }
  /**
   * True only after at least one verified (fresh LAN) device read has
   * succeeded. Hardware actuation remains disabled until this is true and
   * explicitly authorized.
   */
  get isLive() { return this._isLive; }

  constructor() {
    this._isLive = false;
    this._lastReadAt = 0;
  }

  /**
   * List catalogue devices from the backend. Returns typed devices; live
   * fields (connection, lastSeen, power) reflect the most recent verified
   * read, otherwise "unknown"/not reported.
   */
  async listDevices() {
    const data = await api(`${BASE}/local/devices`);
    const rows = Array.isArray(data.devices) ? data.devices : [];
    const devices = rows.map(mapRowToDevice);
    // Preserve the two Haier AC slots first, in their fixed pro -> ff order.
    devices.sort((a, b) => {
      const sa = HAIER_SLOT[a.name];
      const sb = HAIER_SLOT[b.name];
      if (sa && sb) return HAIER_ORDER[sa] - HAIER_ORDER[sb];
      if (sa) return -1;
      if (sb) return 1;
      return a.name.localeCompare(b.name);
    });
    return devices;
  }

  /**
   * Read fresh status for one device from /api/local/status. Returns
   * connection/lastSeen/power as Reported<> values known only from the live
   * read. Sets isLive when a verified read succeeds.
   */
  async getStatus(deviceId) {
    const data = await api(`${BASE}/local/status?id=${encodeURIComponent(String(deviceId))}`, { timeout: 8000 });
    if (data.status !== "ok") {
      return { connection: "unknown", lastSeen: notReported, power: notReported };
    }
    this._isLive = true;
    this._lastReadAt = Date.now();
    const values = new Map((data.values || []).map(v => [String(v.dp), v]));
    // Power is reported only from the genuine boolean switch DP ("1", the same
    // DP the command path writes). A numeric "power" DP is a meter reading,
    // never a relay, so it must not be presented as on/off. Any other or
    // missing value stays unknown rather than fabricated.
    const powerPoint = values.get("1");
    let power = notReported;
    if (powerPoint && powerPoint.value !== undefined) {
      power = { known: true, value: isOnish(powerPoint.value) ? "on" : "off", at: data.read_at || ISO() };
    }
    return {
      connection: "online",
      lastSeen: { known: true, value: data.read_at || ISO(), at: data.read_at || ISO() },
      power,
    };
  }

  /**
   * Send a command to a device via /api/local/command. Commands to
   * requiresApproval devices are rejected unless an approval is supplied.
   * Real hardware actuation stays disabled until isLive is true and the caller
   * is authorized.
   */
  async sendCommand(deviceId, command, approval) {
    const device = await this._findDevice(deviceId);
    if (!device) {
      return { delivered: false, mode: "live", message: "unknown_device" };
    }
    if (device.requiresApproval && !approval) {
      return { delivered: false, mode: "live", message: "needs_approval" };
    }
    if (!this._isLive) {
      return { delivered: false, mode: "preview", message: "Preview only — Not sent to device." };
    }

    let dp, value;
    if (command.type === "power") { dp = "1"; value = command.value === "on"; }
    else if (command.type === "setTemperature") { dp = await this._findDp(deviceId, /temp/i); value = command.value; }
    else if (command.type === "setMode") { dp = await this._findDp(deviceId, /mode/i); value = command.value; }
    else if (command.type === "setFan") { dp = await this._findDp(deviceId, /fan|speed|wind/i); value = command.value; }
    else if (command.type === "setFeature") { dp = await this._findDp(deviceId, new RegExp(command.feature, "i")); value = command.value; }
    else { return { delivered: false, mode: "live", message: "unknown_command" }; }

    if (!dp) {
      return { delivered: false, mode: "live", message: "unknown_dp" };
    }

    try {
      const reply = await api(`${BASE}/local/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: deviceId, dp, value }),
        timeout: 22000,
      });
      return { delivered: Boolean(reply.ok || reply.confirmed), mode: "live", message: reply.message || "ok" };
    } catch (error) {
      return { delivered: false, mode: "live", message: error.code || error.message || "command_failed" };
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async _findDevice(deviceId) {
    const devices = await this.listDevices();
    return devices.find(d => d.id === String(deviceId)) || null;
  }

  async _findDp(deviceId, pattern) {
    const devices = await this.listDevices();
    const device = devices.find(d => d.id === String(deviceId));
    if (!device) return null;
    const row = (await api(`${BASE}/local/devices`)).devices.find(r => String(r.id) === deviceId);
    const point = (row && row.points) ? row.points.find(p => pattern.test(String(p.code || ""))) : null;
    return point ? String(point.dp) : null;
  }
}

function isOnish(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

export const adapter = new LocalBackendAdapter();
