// Capability-first controls for the local page. Every rendered control is
// backed by a real DP; unsupported points stay in the generic advanced list.

import { api, controlId, currentText, esc, isOn, toast, typeLabel } from "./api.js";
import { allPoints, capabilities, capabilityTitle, pointKind } from "./model.js";

export function pointsKey(values) {
  return (values || []).map(point => String(point.dp || "")).filter(Boolean).sort().join(",");
}

// One outstanding write per physical device. Polling must not race this write.
export const commandsInFlight = new Set();

function refreshLater(deviceId, card, refresh) {
  window.setTimeout(() => {
    if (card?.isConnected) refresh(deviceId, card, true);
  }, 950);
}

async function sendValue(deviceId, point, value, label, card, refresh) {
  if (commandsInFlight.has(String(deviceId))) {
    toast("Device command already running — status ka wait karein", "warn");
    return { confirmed: false, busy: true };
  }
  commandsInFlight.add(String(deviceId));
  try {
    const reply = await api("/api/local/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, dp: String(point.dp), value }),
      timeout: 22000, // the server may wait for a status read before a write
    });
    if (reply.confirmed !== true) {
      toast(`${label}: state not confirmed. Refresh first.`, "warn");
      return { confirmed: false, unconfirmed: true };
    }
    toast(`${label}: ${value === true ? "ON" : value === false ? "OFF" : "Updated"} confirmed`, "ok");
    return { confirmed: true };
  } catch (error) {
    const unconfirmed = ["readback_mismatch", "readback_failed", "timeout", "busy"].includes(error.code);
    toast(unconfirmed
      ? `${label}: status uncertain — refresh/check device before retry`
      : `${label}: ${error.message}`, unconfirmed ? "warn" : "error");
    return { confirmed: false, unconfirmed };
  } finally {
    commandsInFlight.delete(String(deviceId));
    refreshLater(deviceId, card, refresh); // ONE read after command, never auto-retry a write
  }
}

export function renderSwitch(deviceId, point, value, card, refresh, label = point.code) {
  const wrap = document.createElement("div");
  wrap.className = "cap-control switch-control";
  wrap.dataset.dp = String(point.dp);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "switch pilot-switch-button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", `${label} power`);
  toggle.setAttribute("aria-checked", isOn(value) ? "true" : "false");
  toggle.innerHTML = '<span class="track" aria-hidden="true"><span class="thumb"></span></span>';
  const note = document.createElement("small");
  note.className = "pilot-command-note";
  note.setAttribute("role", "status");
  const critical = card?.dataset.critical === "true";
  let armed = false;
  let armTimer = null;
  const disarm = () => {
    clearTimeout(armTimer);
    armed = false;
    wrap.classList.remove("armed");
    if (!toggle.disabled) note.textContent = critical ? "2 taps to confirm" : "";
  };
  if (critical) note.textContent = "2 taps to confirm";

  toggle.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    if (toggle.disabled || commandsInFlight.has(String(deviceId))) return;
    const oldValue = toggle.getAttribute("aria-checked") === "true";
    const next = !oldValue;
    if (critical && !armed) {
      armed = true;
      wrap.classList.add("armed");
      note.textContent = `Tap again to turn ${next ? "ON" : "OFF"}`;
      armTimer = window.setTimeout(disarm, 4500);
      return;
    }
    disarm();
    toggle.disabled = true;
    toggle.dataset.pending = "1";
    wrap.classList.add("pending");
    note.textContent = `Sending ${next ? "ON" : "OFF"}…`;
    const result = await sendValue(deviceId, point, next, label, card, refresh);
    if (result.confirmed) {
      toggle.setAttribute("aria-checked", String(next));
      note.textContent = `${next ? "ON" : "OFF"} confirmed`;
      // Update adjacent text without generating another network request.
      const row = wrap.closest("[data-dp]");
      const text = row?.querySelector(".cap-value, .value");
      if (text) {
        text.textContent = next ? "On" : "Off";
        text.classList.toggle("on", next);
      }
      const inlineState = wrap.parentElement?.querySelector(".pilot-inline-state");
      if (inlineState) inlineState.textContent = next ? "ON" : "OFF";
      toggle.disabled = false;
    } else {
      // Unknown != OFF. Freeze it until a successful, fresh status read.
      note.textContent = "Unconfirmed — refresh status";
      toggle.disabled = true;
    }
    delete toggle.dataset.pending;
    wrap.classList.remove("pending");
  });
  wrap.append(toggle, note);
  return wrap;
}

function labelled(label, text, control) {
  const wrap = document.createElement("div");
  wrap.className = "cap-item";
  wrap.innerHTML = '<span class="cap-label">' + esc(label) + '</span>' +
    '<span class="cap-value">' + esc(text) + '</span>';
  wrap.appendChild(control);
  return wrap;
}

export function renderControl(deviceId, point, value, card, refresh) {
  const type = pointKind(point);
  const label = String(point.code || `DP ${point.dp}`).replace(/_/g, " ");
  if (type === "bool") return renderSwitch(deviceId, point, value, card, refresh, label);

  const wrap = document.createElement("div");
  wrap.className = "cap-control";
  wrap.dataset.dp = String(point.dp);
  const send = async (next, button) => {
    if (button) button.disabled = true;
    const result = await sendValue(deviceId, point, next, label, card, refresh);
    if (button) button.disabled = false;
    return result;
  };

  if (type === "int") {
    const low = point.min ?? 0;
    const high = point.max ?? 100;
    const step = point.step ?? 1;
    const range = document.createElement("input");
    range.type = "range";
    range.min = low; range.max = high; range.step = step;
    const parsed = (value === null || value === undefined || value === "") ? NaN : Number(value);
    range.value = Number.isFinite(parsed) ? parsed : low;
    range.setAttribute("aria-label", label);
    const number = document.createElement("input");
    number.type = "number";
    number.min = low; number.max = high; number.step = step;
    number.value = range.value;
    number.setAttribute("aria-label", `${label} value`);
    range.oninput = () => { number.value = range.value; };
    number.onchange = () => { range.value = number.value; };
    const button = document.createElement("button");
    button.className = "btn small";
    button.textContent = "Set";
    button.onclick = () => {
      if (number.value === "" || !Number.isFinite(Number(number.value))) {
        toast(`${label}: Enter a number`, "warn");
        return;
      }
      send(Number(number.value), button);
    };
    wrap.append(range, number, button);
  } else if (type === "enum" && (point.options || []).length) {
    const options = point.options || [];
    const button = document.createElement("button");
    button.className = "btn small";
    button.textContent = "Set";
    if (options.length > 8) {
      const input = document.createElement("input");
      input.type = "text";
      input.value = String(value ?? "");
      input.setAttribute("list", controlId(deviceId, point.dp));
      input.setAttribute("placeholder", options.slice(0, 3).join(" / "));
      input.setAttribute("aria-label", label);
      const list = document.createElement("datalist");
      list.id = controlId(deviceId, point.dp);
      for (const option of options) {
        const item = document.createElement("option");
        item.value = option;
        list.appendChild(item);
      }
      button.onclick = () => send(input.value.trim(), button);
      wrap.append(input, button, list);
    } else {
      const select = document.createElement("select");
      select.setAttribute("aria-label", label);
      for (const option of options) {
        const item = document.createElement("option");
        item.value = option;
        item.textContent = option;
        if (option === String(value)) item.selected = true;
        select.appendChild(item);
      }
      button.onclick = () => send(select.value, button);
      wrap.append(select, button);
    }
  } else {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
    input.setAttribute("aria-label", label);
    const button = document.createElement("button");
    button.className = "btn small";
    button.textContent = "Set";
    button.onclick = () => send(input.value, button);
    wrap.append(input, button);
  }
  return wrap;
}

export function pointRow(deviceId, point, card, refresh) {
  const row = document.createElement("div");
  row.className = "point";
  row.dataset.dp = String(point.dp || "");
  const head = document.createElement("div");
  head.className = "point-head";
  head.innerHTML = '<span class="code">' + esc(point.code) + '</span>' +
    '<span class="type">' + esc(typeLabel(point.type)) + ' · DP ' + esc(point.dp) + '</span>';
  const state = document.createElement("div");
  state.className = "value";
  state.textContent = currentText(point, point.value);
  if (isOn(point.value)) state.classList.add("on");
  row.append(head, renderControl(deviceId, point, point.value, card, refresh), state);
  return row;
}

function valueCell(point, fallback) {
  const node = document.createElement("span");
  node.className = "cap-value";
  node.dataset.dp = String(point.dp);
  node.textContent = fallback ?? currentText(point, point.value);
  if (isOn(point.value)) node.classList.add("on");
  return node;
}

export function renderPoints(card, deviceId, device, values, refresh) {
  const host = card.querySelector(".tile-body");
  if (!host) return;
  host.innerHTML = "";
  const cap = capabilities(device, values);
  const points = cap.all;
  card.dataset.pointsKey = pointsKey(points);
  if (!points.length) {
    host.innerHTML = '<p class="note">Abhi koi live value nahi mili.</p>';
    return;
  }

  const title = capabilityTitle(cap, device);
  const subtitle = device.gateway ? "Gateway"
    : device.sub ? "Sub-device"
    : cap.kind === "sensor" || cap.kind === "meter" ? "Read only" : "Local control";

  if (cap.controls.length) {
    const primaryPoint = cap.all.find(point => String(point.dp) === cap.controls[0].dp) || cap.all[0];
    const primary = document.createElement("div");
    primary.className = "primary-row";
    primary.dataset.dp = String(primaryPoint.dp);
    const label = document.createElement("div");
    label.className = "primary-label";
    label.innerHTML = '<span class="primary-kicker">' + esc(title) + '</span>' +
      '<div class="code">' + esc(cap.controls[0].label) + '</div>';
    label.appendChild(valueCell(primaryPoint));
    primary.append(label, renderControl(deviceId, primaryPoint, primaryPoint.value, card, refresh));
    host.appendChild(primary);
  } else {
    const intro = document.createElement("div");
    intro.className = "read-only-row";
    intro.innerHTML = '<span class="primary-kicker">' + esc(title) + '</span>' +
      '<span class="read-only-tag">' + esc(subtitle) + '</span>';
    host.appendChild(intro);
  }

  const secondary = cap.controls.slice(1);
  if (secondary.length) {
    const box = document.createElement("div");
    box.className = "cap-grid";
    for (const control of secondary) {
      const point = cap.all.find(item => String(item.dp) === control.dp);
      if (!point) continue;
      box.appendChild(labelled(control.label, currentText(point, point.value),
        renderControl(deviceId, point, point.value, card, refresh)));
    }
    host.appendChild(box);
  }

  if (cap.readings.length) {
    const box = document.createElement("div");
    box.className = "reading";
    for (const reading of cap.readings) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.dataset.dp = reading.dp;
      chip.innerHTML = esc(reading.text) + ' <small>' + esc(reading.label) + '</small>';
      box.appendChild(chip);
    }
    host.appendChild(box);
  }

  if (cap.generic.length) {
    const details = document.createElement("details");
    details.className = "more";
    details.open = !!card.dataset.keepOpen;
    const summary = document.createElement("summary");
    summary.textContent = `All values and advanced controls (${cap.generic.length})`;
    details.appendChild(summary);
    for (const point of cap.generic) details.appendChild(pointRow(deviceId, point, card, refresh));
    host.appendChild(details);
  }
}

function setTextState(node, point) {
  if (!node) return;
  node.classList.toggle("on", isOn(point.value));
  node.textContent = currentText(point, point.value);
}

function updateControlValue(row, point) {
  const button = row?.querySelector(".pilot-switch-button");
  if (button) {
    if (button.dataset.pending === "1" || commandsInFlight.has(String(row.closest(".tile")?.dataset.id))) return;
    button.setAttribute("aria-checked", isOn(point.value) ? "true" : "false");
    button.disabled = false;  // only a successful live status read calls this
    const note = row.querySelector(".pilot-command-note");
    if (note) note.textContent = row.closest(".tile")?.dataset.critical === "true" ? "2 taps to confirm" : "";
    return;
  }
  const input = row && row.querySelector("input, select");
  if (!input || document.activeElement === input) return;
  const value = point.value;
  if (input.type === "checkbox") {
    input.checked = isOn(value);
  } else if (input.type === "range" || input.type === "number") {
    const number = Number(value);
    if (Number.isFinite(number)) {
      for (const field of row.querySelectorAll('input[type="range"], input[type="number"]')) {
        field.value = number;
      }
    }
  } else if (input.tagName === "SELECT") {
    input.value = String(value ?? "");
  } else {
    input.value = value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  }
}

// Silent refresh updates text/values in place. Rebuilding the card on every
// poll makes phones blink and can interrupt a tap on the switch.
export function updatePoints(card, values) {
  const points = allPoints({ points: [] }, values);
  if (!card.dataset.pointsKey || card.dataset.pointsKey !== pointsKey(points)) return false;
  const byDp = {};
  for (const point of points) byDp[String(point.dp || "")] = point;

  for (const node of card.querySelectorAll("[data-dp].cap-value")) {
    const point = byDp[node.dataset.dp];
    if (point) setTextState(node, point);
  }
  for (const control of card.querySelectorAll(".cap-control[data-dp]")) {
    const point = byDp[control.dataset.dp];
    if (point) updateControlValue(control, point);
  }
  for (const chip of card.querySelectorAll(".chip[data-dp]")) {
    const point = byDp[chip.dataset.dp];
    if (point) chip.innerHTML = esc(currentText(point, point.value)) + ' <small>' + esc(point.code || point.dp) + '</small>';
  }
  for (const row of card.querySelectorAll(".point[data-dp]")) {
    const point = byDp[row.dataset.dp];
    if (!point) continue;
    setTextState(row.querySelector(".value"), point);
    updateControlValue(row, point);
  }
  return true;
}
