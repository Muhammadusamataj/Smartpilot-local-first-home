// Scene editor and runner. Execution happens on the server: the browser never
// owns a schedule timer, so scenes survive a closed WebView on an always-on host.

import { api, esc, toast } from "./api.js";
import { allPoints, deviceIcon, pointKind } from "./model.js";

const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];
const ICONS = ["bolt", "light", "fan", "curtain", "plug"];

export async function loadScenes() {
  const data = await api("/api/local/scenes");
  return {
    scenes: Array.isArray(data.scenes) ? data.scenes : [],
    scheduler: data.scheduler || { available: false, note: "" },
  };
}

export async function saveScene(payload) {
  const data = await api("/api/local/scenes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return data.scene;
}

export async function deleteScene(id) {
  return api(`/api/local/scenes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function runScene(id) {
  return api("/api/local/scenes/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

function scheduleText(schedule) {
  if (!schedule || !schedule.enabled || !schedule.time) return "Manual";
  const days = Array.isArray(schedule.days) ? schedule.days.slice().sort() : [];
  if (!days.length) return `Daily ${schedule.time}`;
  if (days.length === 7) return `Daily ${schedule.time}`;
  return `${days.map(day => DAY_LABELS[day] || "").join(" ")} ${schedule.time}`;
}

function actionLabel(action, devices) {
  const device = devices.find(item => String(item.id) === String(action.device_id));
  const name = device?.name || action.device_id;
  const label = String(action.value === true ? "On" : action.value === false ? "Off" : action.value);
  return `${name} · DP ${action.dp} → ${label}`;
}

export function renderSceneList(host, state, handlers) {
  if (!host) return;
  host.innerHTML = "";
  const { scenes, scheduler, devices } = state;
  if (scheduler?.note) {
    const note = document.createElement("p");
    note.className = "note scene-note";
    note.textContent = scheduler.note;
    host.appendChild(note);
  }
  if (!scenes.length) {
    const empty = document.createElement("div");
    empty.className = "scene-empty";
    empty.innerHTML = '<div class="scene-empty-icon">⚡</div>' +
      '<h3>No scenes yet</h3>' +
      '<p>Group two or more device actions into one tap. Schedules run on the server, not in the phone WebView.</p>';
    host.appendChild(empty);
    return;
  }
  for (const scene of scenes) {
    const card = document.createElement("article");
    card.className = "scene-card";
    card.dataset.id = scene.id;
    const icon = document.createElement("div");
    icon.className = "scene-icon";
    icon.textContent = ICONS.includes(scene.icon) ? ({ bolt: "⚡", light: "☀", fan: "✦", curtain: "↔", plug: "⏻" })[scene.icon] : "⚡";
    const body = document.createElement("div");
    body.className = "scene-body";
    body.innerHTML = '<h3>' + esc(scene.name) + '</h3>' +
      '<p>' + esc((scene.actions || []).map(action => actionLabel(action, devices)).join(" · ")) + '</p>' +
      '<div class="scene-meta"><span>' + esc(scheduleText(scene.schedule)) + '</span>' +
      (scene.last_run ? '<span>Last run ' + esc(scene.last_run) + '</span>' : "") + '</div>';
    const run = document.createElement("button");
    run.className = "btn primary small";
    run.textContent = "Run";
    run.onclick = async () => {
      run.disabled = true;
      try {
        const result = await handlers.run(scene.id);
        if (result.failed) {
          toast(`${result.succeeded}/${result.succeeded + result.failed} actions confirmed. ${result.failed} failed.`, "warn");
        } else {
          toast(`${scene.name} ✓ ${result.succeeded} action(s) confirmed`, "ok");
        }
        await handlers.reload();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        run.disabled = false;
      }
    };
    const remove = document.createElement("button");
    remove.className = "icon-btn danger small";
    remove.title = "Delete scene";
    remove.textContent = "✕";
    remove.onclick = async () => {
      if (!confirm(`Delete scene “${scene.name}”?`)) return;
      try {
        await handlers.remove(scene.id);
        await handlers.reload();
        toast("Scene deleted", "ok");
      } catch (error) {
        toast(error.message, "error");
      }
    };
    card.append(icon, body, run, remove);
    host.appendChild(card);
  }
}

function valueEditor(point) {
  const kind = pointKind(point);
  if (kind === "bool") {
    const select = document.createElement("select");
    select.innerHTML = '<option value="true">On</option><option value="false">Off</option>';
    return select;
  }
  if (kind === "enum" && (point.options || []).length) {
    const select = document.createElement("select");
    for (const option of point.options) {
      const item = document.createElement("option");
      item.value = option;
      item.textContent = option;
      select.appendChild(item);
    }
    return select;
  }
  const input = document.createElement("input");
  input.type = kind === "int" ? "number" : "text";
  if (point.min !== undefined) input.min = point.min;
  if (point.max !== undefined) input.max = point.max;
  if (point.step !== undefined) input.step = point.step;
  input.value = String(point.value ?? point.min ?? "");
  return input;
}

export function mountSceneEditor(root, state, handlers) {
  if (!root) return;
  root.innerHTML = "";
  const form = document.createElement("form");
  form.className = "scene-editor";
  form.innerHTML =
    '<div class="scene-editor-grid">' +
      '<label class="field"><span>Name</span><input name="name" required maxlength="60" placeholder="Good night"></label>' +
      '<label class="field"><span>Icon</span><select name="icon">' +
        ICONS.map(icon => `<option value="${icon}">${icon}</option>`).join("") + '</select></label>' +
    '</div>' +
    '<div class="action-builder"><div class="action-fields">' +
      '<label class="field"><span>Device</span><select name="device"></select></label>' +
      '<label class="field"><span>Control</span><select name="point"></select></label>' +
      '<label class="field"><span>Value</span><span class="value-slot"></span></label>' +
      '<button type="button" class="btn small" data-add-action>Add action</button>' +
    '</div><div class="action-list"></div></div>' +
    '<fieldset class="schedule-fields"><legend>Schedule (optional)</legend>' +
      '<label class="switch-line"><span>Enable schedule</span><input type="checkbox" name="scheduled"></label>' +
      '<div class="schedule-grid"><input type="time" name="time" value="07:30" aria-label="Run time">' +
        DAY_LABELS.map((label, index) =>
          `<label class="day"><input type="checkbox" name="day" value="${index}" ${index < 5 ? "checked" : ""}><span>${label}</span></label>`).join("") +
      '</div><p class="note">Schedules run only while the server is running. Phone-closed execution needs an always-on PC, HA add-on, or trusted hub.</p>' +
    '</fieldset>' +
    '<button class="btn primary" type="submit">Save scene</button>';

  const deviceSelect = form.elements.device;
  const pointSelect = form.elements.point;
  const valueSlot = form.querySelector(".value-slot");
  const actionList = form.querySelector(".action-list");
  let actions = [];

  const eligible = state.devices.filter(device => device.lan_known || device.verified);
  deviceSelect.innerHTML = eligible.length
    ? eligible.map(device => `<option value="${esc(device.id)}">${esc(device.name)}</option>`).join("")
    : '<option value="">No local devices yet</option>';

  function fillPoints() {
    const device = eligible.find(item => String(item.id) === deviceSelect.value);
    const points = allPoints(device || {}, []);
    pointSelect.innerHTML = points.length
      ? points.map(point => `<option value="${esc(point.dp)}">${esc(point.code)} (DP ${esc(point.dp)})</option>`).join("")
      : '<option value="">No controls found</option>';
    fillValue();
  }

  function fillValue() {
    const device = eligible.find(item => String(item.id) === deviceSelect.value);
    const point = allPoints(device || {}, []).find(item => String(item.dp) === pointSelect.value);
    valueSlot.innerHTML = "";
    valueSlot.appendChild(valueEditor(point || { type: "text", value: "" }));
  }

  deviceSelect.onchange = fillPoints;
  pointSelect.onchange = fillValue;
  fillPoints();

  function renderActions() {
    actionList.innerHTML = actions.map((action, index) => {
      const device = eligible.find(item => String(item.id) === action.device_id);
      return `<span class="action-pill">${esc(device?.name || action.device_id)} · DP ${esc(action.dp)} → ${esc(String(action.value))}` +
        `<button type="button" data-remove="${index}" aria-label="Remove action">✕</button></span>`;
    }).join("");
    for (const button of actionList.querySelectorAll("[data-remove]")) {
      button.onclick = () => {
        actions.splice(Number(button.dataset.remove), 1);
        renderActions();
      };
    }
  }

  form.querySelector("[data-add-action]").onclick = () => {
    const deviceId = deviceSelect.value;
    const dp = pointSelect.value;
    const valueNode = valueSlot.querySelector("input, select");
    if (!deviceId || !dp || !valueNode) { toast("Choose a device and control first", "warn"); return; }
    let value = valueNode.value;
    if (valueNode.type === "number") value = Number(value);
    if (value === "true") value = true;
    if (value === "false") value = false;
    actions.push({ device_id: deviceId, dp, value });
    renderActions();
  };

  form.onsubmit = async event => {
    event.preventDefault();
    if (!actions.length) { toast("Add at least one action", "warn"); return; }
    const scheduled = form.elements.scheduled.checked;
    const days = [...form.querySelectorAll('[name="day"]:checked')].map(node => Number(node.value));
    const payload = {
      id: state.editingId || undefined,
      name: form.elements.name.value.trim(),
      icon: form.elements.icon.value,
      actions,
      schedule: { enabled: scheduled, time: scheduled ? form.elements.time.value : "", days: scheduled ? days : [] },
    };
    try {
      await handlers.save(payload);
      form.reset();
      actions = [];
      actionList.innerHTML = "";
      fillPoints();
      state.editingId = "";
      await handlers.reload();
      toast("Scene saved", "ok");
    } catch (error) {
      toast(error.message, "error");
    }
  };
  root.appendChild(form);
}

export function sceneIconSvg(name) {
  const device = { name, category: name };
  return deviceIcon(device).svg;
}
