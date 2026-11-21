// Shared helpers for the premium local page. All requests are document-relative
// so Home Assistant ingress prefixes keep working (/api/hassio_ingress/<token>/).

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function toast(message, kind = "info") {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 3000);
}

export async function api(url, options = {}) {
  const { timeout = 12000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (fetchOptions.signal) {
    fetchOptions.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let response;
  try {
    response = await fetch(url.replace(/^\/+/, ""), { cache: "no-store", ...fetchOptions, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Device did not answer in time");
      timeoutError.code = "timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let data = {};
  try { data = await response.json(); } catch (error) { /* empty body */ }
  if (!response.ok || data.error) {
    const error = new Error(data.error || data.message || `HTTP ${response.status}`);
    error.code = data.error || data.code;
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export function isOn(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

// Power-meter line current is published in mA with scale 0, but the reference
// app and our packed phase_a decoder both show amperes. Normalise only that
// code: leakage/residual current is genuinely a mA measurement and stays mA.
export function isAmpNormalisedCurrent(point) {
  return /^cur_current$/i.test(String(point?.code || ""))
    && String(point?.unit || "").trim().toLowerCase() === "ma";
}

// Tuya publishes a `scale` on integer DPs: the raw value must be divided by
// 10**scale. Old cached devices may not have it, in which case the raw number
// is shown with the code-based unit (the previous behaviour).
export function displayUnit(point) {
  if (point?.unit) {
    const unit = String(point.unit);
    if (isAmpNormalisedCurrent(point)) return " A";
    return unit === "°C" || unit === "°F" ? unit : ` ${unit}`;
  }
  const code = String(point?.code || "");
  if (/humidity|battery/i.test(code)) return "%";
  if (/power|watt/i.test(code)) return " W";
  if (/energy|kwh|elec/i.test(code)) return " kWh";
  if (/volt/i.test(code)) return " V";
  if (/amp|current/i.test(code)) return " A";
  if (/temp/i.test(code)) return "°";
  return "";
}

export function scaledValue(point, value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const scale = Number(point?.scale);
  const scaled = (Number.isFinite(scale) && scale > 0 && scale <= 6 && Number.isInteger(scale))
    ? num / 10 ** scale : num;
  return isAmpNormalisedCurrent(point) ? scaled / 1000 : scaled;
}

export function currentText(point, value) {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (value && typeof value === "object") return JSON.stringify(value);
  const code = String(point?.code || "");
  const numeric = /°|temp|humidity|battery|power|energy|watt|volt|amp|current|kwh|elec/i.test(code);
  if (point && numeric) {
    const num = scaledValue(point, value);
    if (num !== null) {
      const scale = Number(point?.scale);
      const hasScale = Number.isFinite(scale) && scale > 0 && scale <= 6 && Number.isInteger(scale);
      if (isAmpNormalisedCurrent(point)) return `${num.toFixed(3)} A`;
      return `${hasScale ? num.toFixed(Math.min(scale, 4)) : num}${displayUnit(point)}`;
    }
  }
  return String(value ?? "-");
}

export function typeLabel(type) {
  return ({
    bool: "Boolean", boolean: "Boolean", int: "Integer", integer: "Integer",
    value: "Integer", enum: "Enum", string: "String", str: "String",
    json: "JSON", raw: "Raw",
  })[type] || type || "Unknown";
}

export function controlId(deviceId, dp) {
  return `opts-${String(deviceId) + "-" + dp}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function debounce(fn, delay = 180) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// A tiny bounded queue: with dozens of devices a silent tick must not open
// dozens of sockets at once. Waiting tasks are dropped rather than queued
// forever when the page is hidden or a device drops off Wi-Fi.
export class LimitedConcurrency {
  constructor(limit = 3) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.waiting = [];
  }

  run(task) {
    if (this.active >= this.limit) return false;
    this.active += 1;
    Promise.resolve(task()).finally(() => {
      this.active -= 1;
      this.drain();
    });
    return true;
  }

  queue(task) {
    if (this.run(task)) return true;
    this.waiting.push(task);
    return false;
  }

  drain() {
    while (this.active < this.limit && this.waiting.length) {
      this.run(this.waiting.shift());
    }
  }
}
