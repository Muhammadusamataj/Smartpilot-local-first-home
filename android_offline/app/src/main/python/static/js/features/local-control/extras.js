// Additive Safety & Automation panel. Never touches device command paths.
import { api, esc, toast } from "./api.js";

const $ = (id) => document.getElementById(id);
const native = () => (typeof window !== "undefined" ? window.PilotNative : null);

function row(label, value, badge = "") {
  return `<div class="pilot-extra-row"><span>${esc(label)}</span>` +
    `<span class="pilot-extra-badge ${badge}">${esc(value)}</span></div>`;
}

function time(timestamp) {
  if (!timestamp) return "never";
  const date = new Date(Number(timestamp) * 1000);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

async function loadScheduler() {
  const node = $("schedulerInfo");
  if (!node) return;
  try {
    const data = await api("api/local/scheduler");
    node.innerHTML = row("Schedules", data.scheduled ?? 0) +
      row("Scenes", data.scenes ?? 0) +
      row("Next run", data.next_run || "none", data.next_run ? "ok" : "") +
      `<p class="note">${esc(data.note || "")}</p>`;
  } catch (error) {
    node.textContent = `Unavailable: ${error.message}`;
  }
}

async function loadRules(devices) {
  const node = $("rulesInfo");
  if (!node) return;
  try {
    const data = await api("api/local/rules");
    const rules = data.rules || [];
    node.innerHTML = rules.length ? rules.map((rule) =>
      `<div class="pilot-extra-row"><span>${esc(rule.name)}<br><small>${esc(rule.device_id)} · DP ${esc(rule.dp)} · ${esc(rule.minutes)} min</small></span>` +
      `<button type="button" class="btn danger" data-rule-delete="${esc(rule.id)}">Delete</button></div>`
    ).join("") : "<p class=\"note\">No safety rules yet. Add a preset below.</p>";
  } catch (error) {
    node.textContent = `Unavailable: ${error.message}`;
  }
  return devices;
}

async function addPreset(kind, devices) {
  const wanted = kind === "motor" ? /bore|motor|pump/i : /geyser|heater|water/i;
  const device = (devices || []).find((item) => wanted.test(String(item.name || "")));
  if (!device) {
    toast("No matching device found. Add the device first.", "error");
    return;
  }
  const point = (device.points || []).find((item) =>
    /switch|power|onoff/i.test(String(item.code || ""))) ||
    (device.points || []).find((item) => !item.readonly);
  if (!point) {
    toast("No writable power DP found for this device.", "error");
    return;
  }
  try {
    await api("api/local/rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: kind === "motor" ? "Motor auto OFF (30 min)" : "Geyser auto OFF (60 min)",
        kind: "on_duration", device_id: device.id, dp: point.dp,
        minutes: kind === "motor" ? 30 : 60, action: false, enabled: true,
      }),
    });
    toast("Safety rule saved", "ok");
    await loadRules(devices);
  } catch (error) {
    toast(`Could not save rule: ${error.message}`, "error");
  }
}

async function loadUsage() {
  const node = $("usageInfo");
  if (!node) return;
  try {
    const data = await api("api/local/usage");
    const devices = (data.devices || []).slice(0, 8);
    node.innerHTML = row("Today", `${data.total_kwh ?? 0} kWh`, "ok") +
      devices.map((item) => row(String(item.id).slice(0, 18), `${item.kwh} kWh`)).join("") +
      (data.ac || []).map((ac) => row(
        `${ac.name || ac.id} verified`,
        ac.verified ? `${ac.power_on ? "ON" : "OFF"} · ${time(ac.last_read)}` : `no · ${time(ac.last_read)}`,
        ac.verified ? "ok" : "warn",
      )).join("");
  } catch (error) {
    node.textContent = `Unavailable: ${error.message}`;
  }
}

async function loadEvents() {
  const node = $("eventsInfo");
  if (!node) return;
  try {
    const data = await api("api/local/events");
    const events = (data.events || []).slice(-6).reverse();
    node.innerHTML = events.length ? events.map((item) =>
      `<div class="pilot-extra-row"><span>${esc(item.title)}<br><small>${esc(item.body)}</small></span>` +
      `<small>${esc(new Date(item.at * 1000).toLocaleTimeString())}</small></div>`
    ).join("") : "<p class=\"note\">No activity yet.</p>";
  } catch (error) {
    node.textContent = `Unavailable: ${error.message}`;
  }
}

function renderUpdate(state) {
  const node = $("updateInfo");
  if (!node) return;
  if (!state || !state.platform) {
    node.innerHTML = `<p class="note">Updates are available through GitHub Releases. In the Android app, use Check for update to install a signed APK; keep a backup before updating.</p>`;
    return;
  }
  node.innerHTML = row("Installed", state.current || "unknown") +
    row("Latest release", state.latest || (state.busy ? "checking…" : "up to date"),
        state.available ? "warn" : "ok") +
    row("Install permission", state.canInstall ? "allowed" : "needed",
        state.canInstall ? "ok" : "warn") +
    row("Rollback copy", state.hasBackup ? "saved" : "none",
        state.hasBackup ? "ok" : "warn") +
    (state.error ? `<p class="note">${esc(state.error)}</p>` : "");
  $("updateInstall").hidden = !state.available;
  $("updateRollback").hidden = !state.hasBackup;
  $("updatePermission").hidden = state.canInstall !== false;
}

function callNative(method, ...args) {
  const bridge = native();
  if (!bridge || typeof bridge[method] !== "function") return null;
  try { return bridge[method](...args); } catch (error) { return null; }
}

function updateResult(raw) {
  try { renderUpdate(JSON.parse(raw)); } catch (error) { /* ignore malformed bridge data */ }
}

async function refreshAll() {
  const devices = await api("api/local/devices").then((data) => data.devices || []).catch(() => []);
  await Promise.allSettled([loadScheduler(), loadRules(devices), loadUsage(), loadEvents()]);
  const state = callNative("updateState");
  if (state) renderUpdate(JSON.parse(state));
  else renderUpdate(null);
}

function init() {
  $("schedulerTick")?.addEventListener("click", async () => {
    try {
      const data = await api("api/local/scheduler/tick", { method: "POST" });
      toast(`Scene tick: ${(data.ran || []).length} scene(s)`, "ok");
      refreshAll();
    } catch (error) { toast(`Tick failed: ${error.message}`, "error"); }
  });

  document.querySelectorAll("[data-rule-preset]").forEach((button) => {
    button.addEventListener("click", async () => {
      const devices = await api("api/local/devices").then((d) => d.devices || []).catch(() => []);
      await addPreset(button.dataset.rulePreset, devices);
    });
  });

  $("rulesInfo")?.addEventListener("click", async (event) => {
    const deleteButton = event.target.closest("[data-rule-delete]");
    if (!deleteButton) return;
    try {
      await api(`api/local/rules?id=${encodeURIComponent(deleteButton.dataset.ruleDelete)}`, { method: "DELETE" });
      toast("Rule removed", "ok");
      refreshAll();
    } catch (error) { toast(`Delete failed: ${error.message}`, "error"); }
  });

  $("backupDownload")?.addEventListener("click", async () => {
    try {
      const response = await fetch("api/local/backup", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "smart-pilot-backup.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      toast("Backup downloaded", "ok");
    } catch (error) { toast(`Backup failed: ${error.message}`, "error"); }
  });

  $("restoreFile")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    try {
      const data = await api("api/local/restore", { method: "POST", body });
      toast(`Restored ${(data.restored || []).length} file(s)`, "ok");
    } catch (error) { toast(`Restore failed: ${error.message}`, "error"); }
    event.target.value = "";
  });

  $("updateCheck")?.addEventListener("click", () => {
    if (!callNative("checkUpdate")) toast("Update check is available in the Android app.", "info");
  });
  $("updateInstall")?.addEventListener("click", () => callNative("installUpdate"));
  $("updateRollback")?.addEventListener("click", () => callNative("rollback"));
  $("updatePermission")?.addEventListener("click", () => {
    if (!callNative("openInstallPermission")) toast("Open Android settings to allow installs.", "info");
  });

  window.pilotUpdateResult = updateResult;
  refreshAll();
  setInterval(() => {
    const panel = document.querySelector('[data-view-panel="settings"]');
    if (panel && !panel.hidden) refreshAll();
  }, 60000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
