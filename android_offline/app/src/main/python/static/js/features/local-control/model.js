// Device capability mapping. A control is only produced when a real DP exists;
// inferred device kind changes presentation, never the device's abilities.

import { currentText, displayUnit, isOn } from "./api.js";

export function pointKind(point) {
  const type = String(point?.type || "").toLowerCase();
  if (["bool", "boolean"].includes(type) || (!type && typeof point?.value === "boolean")) return "bool";
  if (["int", "integer", "value"].includes(type)) return "int";
  if (type === "enum") return "enum";
  return "text";
}

export function code(point) {
  return String(point?.code || "").toLowerCase();
}

export function findPoint(points, pattern, kinds = null) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
  return points.find(point => regex.test(code(point)) && (!kinds || kinds.includes(pointKind(point)))) || null;
}

export function allPoints(device, values) {
  const cloud = device?.points || [];
  const source = Array.isArray(values) && values.length ? values : cloud;
  const byDp = new Map(cloud.map(point => [String(point.dp), point]));
  return source.map(point => {
    const saved = byDp.get(String(point.dp)) || {};
    const merged = { ...saved, ...point };
    if (merged.value === undefined || merged.value === null) merged.value = saved.cloud_value;
    return merged;
  });
}

export function deviceKind(device) {
  const text = [device?.name, device?.product_name, device?.category,
    (device?.points || []).map(point => point.code).join(" ")].join(" ").toLowerCase();
  if (/water.?tank|tank|pani/.test(text)) return "water";
  if (/bore|motor|pump/.test(text)) return "motor";
  if (/geyser|heater|heating|hot.?water/.test(text)) return "heater";
  if (/ac|air.?condition|thermostat|hvac/.test(text)) return "climate";
  if (/breaker|dlq|znjdq|circuit|mcb/.test(text)) return "breaker";
  if (/meter|energy|electricity|kwh/.test(text)) return "meter";
  if (/light|lamp|bulb|ceiling|downlight|spotlight/.test(text)) return "light";
  if (/fan|ventil/.test(text)) return "fan";
  if (/curtain|blind|shade/.test(text)) return "curtain";
  if (/camera|cam/.test(text)) return "camera";
  if (/lock/.test(text)) return "lock";
  if (/sensor|thermometer|hygrometer/.test(text)) return "sensor";
  return "plug";
}

export function deviceIcon(device) {
  const kind = deviceKind(device);
  const shapes = {
    breaker: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M8 12h2m4 0h2M10.5 9.5l4 5"/>',
    meter: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 13 4-4"/><circle cx="12" cy="17" r="1.4"/>',
    light: '<path d="M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.8V16h7v-2.2A6 6 0 0 0 12 3Z"/>',
    motor: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="1.7"/><path d="M12 10.2c1.9-3 4.5-2.6 4.7-1.2.2 1.4-2 2.4-4.7 1.2ZM13.8 12c3 1.9 2.6 4.5 1.2 4.7-1.4.2-2.4-2-1.2-4.7ZM12 13.8c-1.9 3-4.5 2.6-4.7 1.2-.2-1.4-2-2.4-4.7-1.2ZM10.2 12c-3-1.9-2.6-4.5-1.2-4.7 1.4-.2 2.4 2 1.2 4.7Z"/>',
    water: '<path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11Z"/><path d="M9.5 14.5c.4 1.6 1.4 2.5 2.5 2.5"/>',
    heater: '<path d="M12 3s5 4.5 5 9a5 5 0 0 1-10 0c0-2 1-3.7 2.5-5.2.2 2 1.2 2.8 2.2 2.9C11.4 7.8 12 5.6 12 3Z"/><path d="M8 20c1.2-1 2.7-1 4 0 1.3 1 2.8 1 4 0"/>',
    climate: '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0Z"/><path d="M12 17.2v.6"/>',
    curtain: '<path d="M4 4h16M6 4v16M18 4v16M6 20c2-1.2 3-3.5 3-6V9c0-2 1-3.5 3-5 2 1.5 3 3 3 5v5c0 2.5 1 4.8 3 6"/>',
    camera: '<rect x="3" y="7" width="14" height="10" rx="2"/><path d="m17 11 4-2v6l-4-2"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    sensor: '<path d="M12 3a7 7 0 0 0-4 12.7V19h8v-3.3A7 7 0 0 0 12 3Z"/><path d="M12 8v5"/>',
    plug: '<path d="M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4"/>',
  };
  const tone = shapes[kind] ? kind : "plug";
  return {
    kind: tone,
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + shapes[tone] + '</svg>',
  };
}

const POWER_CODE = /^(switch|switch_\d+|power|power_switch|relay|relay_\d+|onoff|on_off|main_switch|light|light_\d+)$/i;
const SECONDARY_SWITCH = /^(prepay|prepayment|credit|child_lock|lock|alarm|bell|test|reset|clean|filter|sleep|swing|oscillate|direction|reverse)$/i;
const READING_CODE = /temp|humidity|battery|power|watt|energy|kwh|volt|current|amp|pm|co2|gas|water|level|signal|rssi/i;
const BRIGHTNESS_CODE = /bright|dimmer|dim|brightness|level/i;
const TEMP_CODE = /(^|_)(set_?temp|target_?temp|temp|temperature|cct|colour_?temp|color_?temp)/i;
const MODE_CODE = /(^|_)(mode|work_?mode|op_?mode|wind|fan_?speed|speed|colour|color|hsv|scene)(_|$)/i;
const CURTAIN_CODE = /curtain|open|close|stop|position|percent|percentage/i;

function controlFrom(point, label, control) {
  return {
    dp: String(point.dp), code: String(point.code), label, kind: control,
    type: pointKind(point), value: point.value, min: point.min, max: point.max,
    step: point.step, options: point.options || [],
  };
}

function addUnique(list, point, label, control) {
  if (!point || list.some(item => item.dp === String(point.dp))) return;
  list.push(controlFrom(point, label, control));
}

function unitFor(point) {
  const explicit = displayUnit(point);
  if (explicit) return explicit;
  const text = code(point);
  if (/humidity|battery|percent|level|position/.test(text)) return "%";
  if (/temp/.test(text)) return "°";
  if (/co2|pm/.test(text)) return " ppm";
  return "";
}

// Breaker DPs such as `phase_a` carry three unsigned big-endian 16-bit words:
// voltage in 0.1 V, current in 0.001 A, active power in 0.1 W. The remaining
// bytes (when present) are unused by these readings. The voltage divisor is
// corroborated by the device's cached schema and Smart Life's live picture;
// current/power follow Tuya's standard layout and still need a live ON check.
export function decodePhaseA(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  let binary;
  try { binary = atob(value); } catch (error) { return null; }
  if (binary.length < 6) return null;
  const byte = index => binary.charCodeAt(index);
  const word = index => (byte(index) << 8) | byte(index + 1);
  const voltage = word(0) / 10;
  const current = word(2) / 1000;
  const power = word(4) / 10;
  if (![voltage, current, power].every(Number.isFinite)) return null;
  return { voltage, current, power };
}

export function capabilities(device, values) {
  const points = allPoints(device, values);
  const kind = deviceKind(device);
  const controls = [];
  const used = new Set();
  const remember = (point, label, control) => {
    addUnique(controls, point, label, control);
    if (point) used.add(String(point.dp));
  };

  const power = findPoint(points, POWER_CODE, ["bool", "int", "enum"]);
  if (power) remember(power, "Power", "switch");

  if (kind === "light") {
    remember(findPoint(points, BRIGHTNESS_CODE, ["int"]), "Brightness", "slider");
    remember(findPoint(points, /(colour|color).*(temp|temperature)|cct/i, ["int", "enum"]), "Colour temperature", "slider");
    remember(findPoint(points, /(colour|color|hsv)/i, ["enum", "text"]), "Colour", "choice");
    remember(findPoint(points, /scene|mode/i, ["enum", "text"]), "Light scene", "choice");
  } else if (kind === "fan") {
    remember(findPoint(points, /speed|wind|level/i, ["int", "enum"]), "Fan speed", "choice");
    remember(findPoint(points, /swing|oscillate/i, ["bool", "enum"]), "Swing", "switch");
    remember(findPoint(points, /timer|countdown/i, ["int", "enum"]), "Timer", "choice");
  } else if (kind === "climate" || kind === "heater") {
    remember(findPoint(points, TEMP_CODE, ["int"]), "Target temperature", "slider");
    remember(findPoint(points, /mode/i, ["enum", "text"]), "Mode", "choice");
    remember(findPoint(points, /fan.?speed|wind|speed/i, ["enum", "int"]), "Fan speed", "choice");
    remember(findPoint(points, /swing|oscillate/i, ["bool", "enum"]), "Swing", "switch");
  } else if (kind === "curtain") {
    remember(findPoint(points, /position|percent|percentage|level/i, ["int"]), "Position", "slider");
    remember(findPoint(points, /control|command|action|curtain/i, ["enum", "text"]), "Action", "choice");
    for (const point of points.filter(item => /^(open|close|stop)$/i.test(code(item)) && pointKind(item) === "bool")) {
      remember(point, point.code.replace(/_/g, " "), "action");
    }
  } else if (kind === "meter") {
    // Meters are read-only unless a real switch DP is present; never invent one.
  } else if (kind === "sensor" || kind === "camera" || kind === "lock") {
    for (const point of points.filter(item => pointKind(item) === "bool" && SECONDARY_SWITCH.test(code(item)))) {
      remember(point, point.code.replace(/_/g, " "), "switch");
    }
  } else {
    for (const point of points.filter(item => pointKind(item) === "bool" && SECONDARY_SWITCH.test(code(item)))) {
      remember(point, point.code.replace(/_/g, " "), "switch");
    }
  }

  const readings = points.filter(point => {
    if (used.has(String(point.dp))) return false;
    if (pointKind(point) === "bool") return false;
    return READING_CODE.test(code(point)) || (kind === "meter" && pointKind(point) === "int");
  }).slice(0, 4).map(point => ({
    dp: String(point.dp), code: String(point.code), label: point.code.replace(/_/g, " "),
    text: currentText(point, point.value), unit: unitFor(point),
  }));

  // Expand Tuya's packed breaker telemetry into readable measurements. These
  // are derived from a genuine DP value, not invented device capabilities.
  const phase = points.find(point => code(point) === "phase_a");
  if (phase) {
    const decoded = decodePhaseA(phase.value ?? phase.cloud_value);
    if (decoded) {
      used.add(String(phase.dp));
      readings.push(
        { dp: `${phase.dp}:v`, code: "phase_a_voltage", label: "Voltage (Phase A)",
          text: `${decoded.voltage.toFixed(1)} V`, unit: " V" },
        { dp: `${phase.dp}:a`, code: "phase_a_current", label: "Current (Phase A)",
          text: `${decoded.current.toFixed(3)} A`, unit: " A" },
        { dp: `${phase.dp}:w`, code: "phase_a_power", label: "Active power (Phase A)",
          text: `${decoded.power.toFixed(1)} W`, unit: " W" },
      );
    }
  }

  const generic = points.filter(point =>
    !used.has(String(point.dp)) && !readings.some(item => item.dp === String(point.dp)));

  return {
    kind, power: !!power, controls, readings, generic,
    all: points,
    verified: device?.verified === true,
    status: device?.status_label || (device?.verified ? "Online" : device?.lan_known ? "Address saved" : "Offline"),
  };
}

export function capabilityTitle(capability, device) {
  const names = {
    water: "Water tank", motor: "Pump", heater: "Heater", breaker: "Breaker",
    meter: "Power meter", light: "Light", fan: "Fan", curtain: "Curtain",
    camera: "Camera", lock: "Lock", sensor: "Sensor", climate: "Thermostat", plug: "Smart plug",
  };
  return names[capability.kind] || device?.product_name || device?.category || "Device";
}

export function isTruthy(value) {
  return isOn(value);
}
