// Premium local control app. All data comes from this server; no cloud call is
// made for daily control. HA ingress keeps working because every URL is relative.

import { api, debounce, esc, LimitedConcurrency, toast } from "./api.js";
import { capabilities, deviceIcon } from "./model.js";
import { adapter } from "./adapter.js";
import { commandsInFlight, renderPoints, renderSwitch, updatePoints } from "./controls.js";

// Typed local-backend adapter (Lovable domain over the real /api/local/* API).
// isLive stays false until a verified LAN read succeeds; hardware actuation
// remains disabled until explicitly authorized.
window.pilotAdapter = adapter;
import { homeTile, sortHomeItems, showOnHome, isHomeEditing, setHomeEditing, homeAction, moveHomeTile } from "./home-layout.js";
import {
  deleteScene, loadScenes, mountSceneEditor, renderSceneList, runScene, saveScene,
} from "./scenes.js";

const state = {
  devices: [],
  prefs: { favorites: [], rooms: {}, homes: [], updated_at: 0 },
  scenesState: { scenes: [], scheduler: { available: false, note: "" } },
  view: "home",
  filters: { search: "", home: "", room: "", category: "", favoritesOnly: false },
  loading: false,
  ensureCooldownUntil: 0,
  scanWatchTimer: null,
  pollTimer: null,
  inFlight: new Set(),
  retries: new Map(),
  latest: new Map(),
  latestReadAt: new Map(),
  tokens: new Map(),
  renderGeneration: 0,
  editorMounted: false,
  detailDeviceId: "",
  failedReads: new Map(),
  queuedReads: new Set(),
};

const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
// 2 concurrent LAN reads on Android is deliberate: more sockets make the Vivo
// device reads slow and unreliable. Extra reads wait in the bounded queue.
const limiter = new LimitedConcurrency(mobile ? 2 : 3);

// Presentation-only classification. These IDs are never sent to the server or
// used for control; they only opt a switch into the two-step confirm pattern.
const CRITICAL_DEVICE_IDS = new Set([
  "bf069004945cef348chgdf", // Bore Motor
  "bf8363e8618b64aa00nclo", // First Floor Breaker
  "bfe87f1e05abf9d1acdanb", // Ground Floor
  "bfccb1925a4b0b269dfph5", // Water Tank
  "bf04a442f57b19789dfflz", // Geyser
]);

function $(id) { return document.getElementById(id); }
function safeArray(value) { return Array.isArray(value) ? value : []; }
function sameId(a, b) { return String(a) === String(b); }

async function optionalApi(path, fallback) {
  try { return await api(path); } catch (error) { return fallback; }
}

function verifiedCount() { return state.devices.filter(device => device.verified === true).length; }
function savedCount() { return state.devices.filter(device => device.lan_known && device.verified !== true).length; }

function repairLine(data) {
  const summary = $("summary");
  if (!summary) return;
  const repair = data.repair || {};
  if (!repair.running) {
    summary.textContent = `${state.devices.length} device(s) · ${verifiedCount()} online · ${savedCount()} saved`;
    return;
  }
  const swept = repair.swept ?? 0;
  const total = repair.addresses ?? "";
  summary.textContent = `LAN reconnect… ${total !== "" ? `${swept}/${total} · ` : ""}${state.devices.length} device(s)`;
}

function statusClass(device) {
  if (device.verified === true) return "";
  return device.lan_known ? "stale" : "offline";
}

function statusLabel(device) {
  return device.status_label || (device.verified ? "Online" : device.lan_known ? "Address saved" : "Offline");
}

function roomName(device) {
  if (device.room_status === "unassigned") return "No room";
  if (device.room_name) return device.room_name;
  if (device.room_id) return `Room ${device.room_id}`;
  return state.prefs.rooms?.[device.id] || "Unknown room";
}

function homeName(device) {
  return device.home_name || "This home";
}

function isCriticalDevice(device) {
  if (CRITICAL_DEVICE_IDS.has(String(device.id))) return true;
  const context = `${device.name || ""} ${device.product_name || ""} ${roomName(device)}`.toLowerCase();
  return /breaker|motor|bore|geyser|water tank|pump|water heater|mains/.test(context);
}


// Visible switches are never inferred from a saved IP or numeric power meter.
// A recent successful LAN read must contain the live Boolean power DP.
function verifiedPowerPoint(device) {
  const id = String(device.id);
  const values = state.latest.get(id) || state.latest.get(device.id);
  const checkedAt = state.latestReadAt.get(id) || state.latestReadAt.get(device.id) || 0;
  if (device.verified !== true || !Array.isArray(values) || !values.length ||
      Date.now() - checkedAt > 60000) return null;
  const cap = capabilities(device, values);
  const control = cap.controls.find(item => item.label === "Power" &&
    item.kind === "switch" && item.type === "bool");
  if (!control) return null;
  const raw = values.find(item => String(item.dp) === control.dp);
  const point = cap.all.find(item => String(item.dp) === control.dp);
  // Tuya sometimes transports a declared Boolean as 0/1.
  if (!raw || !point || !(typeof raw.value === "boolean" ||
      raw.value === 0 || raw.value === 1)) return null;
  return { point, value: raw.value };
}

function renderQuickPower(card, device, refreshCard = card) {
  const host = card.querySelector("[data-quick-power]");
  if (!host) return;
  const live = verifiedPowerPoint(device);
  const stateLabel = document.createElement("span");
  stateLabel.className = "pilot-inline-state";
  stateLabel.textContent = live ? (live.value === true || live.value === 1 ? "ON" : "OFF")
    : device.verified === true ? "No verified power switch" : "Checking status";
  host.replaceChildren(stateLabel);
  host.classList.toggle("is-ready", !!live);

  if (live) {
    // Reuse the established command/confirmation handler. Critical devices
    // still require two deliberate taps, confirmed write and fresh readback.
    host.appendChild(renderSwitch(device.id, live.point, live.value,
      refreshCard, refresh, "Main power"));
  } else {
    const disabled = document.createElement("button");
    disabled.type = "button";
    disabled.className = "switch pilot-switch-button";
    disabled.setAttribute("role", "switch");
    disabled.setAttribute("aria-label", "Power status not verified");
    disabled.setAttribute("aria-checked", "mixed");
    disabled.disabled = true;
    disabled.innerHTML = '<span class="track" aria-hidden="true"><span class="thumb"></span></span>';
    host.appendChild(disabled);
  }
}

function matches(device) {
  const filters = state.filters;
  if (filters.favoritesOnly && !state.prefs.favorites.some(id => sameId(id, device.id))) return false;
  if (filters.home && homeName(device) !== filters.home) return false;
  if (filters.room && roomName(device) !== filters.room) return false;
  if (filters.category && (device.category || "Other") !== filters.category) return false;
  if (!filters.search) return true;
  const haystack = [device.name, device.product_name, device.category, device.id,
    roomName(device), homeName(device)].join(" ").toLowerCase();
  return haystack.includes(filters.search.toLowerCase());
}

function deviceSearchText(device) {
  return [device.name, device.product_name, device.category, device.id,
    roomName(device), homeName(device)].join(" ").toLowerCase();
}

function markReadFailed(cards, message) {
  for (const card of cards) {
    card.classList.remove("stale");
    card.classList.add("offline");
    card.dataset.verified = "0";
    // No interactive writes from cached or unreachable data.
    card.querySelectorAll(".cap-control button, .cap-control input, .cap-control select").forEach(control => {
      control.disabled = true;
    });
    const status = card.querySelector(".status");
    if (status) status.textContent = "Unreachable";
    const note = card.querySelector(".status-note");
    if (note) note.textContent = message;
    else {
      const line = document.createElement("p");
      line.className = "note status-note";
      line.textContent = message;
      card.querySelector(".tile-head")?.after(line);
    }
  }
  const device = state.devices.find(item => sameId(item.id, cards[0]?.dataset.id));
  if (device) {
    device.verified = false;
    for (const card of cards) renderQuickPower(card, device, card);
  }
  renderStats();
  renderHomeQuickDevices(state.devices);
  for (const card of cards) state.retries.set(card.dataset.id, Date.now() + 60000);
  const id = cards[0]?.dataset.id;
  if (id && !/\bbusy\b/i.test(String(message))) {
    const failures = (state.failedReads.get(id) || 0) + 1;
    state.failedReads.set(id, failures);
    // A LAN read may fail after DHCP changes. Ask the backend for its
    // *throttled, read-only* reconnect check; never retry an ON/OFF command.
    if (failures >= 2 && Date.now() >= state.ensureCooldownUntil && !document.hidden) {
      state.ensureCooldownUntil = Date.now() + 120000;
      api('/api/local/ensure', {method:'POST', timeout:6000})
        .then(() => watchReconnect())
        .catch(() => {});
    }
  }
}

function markReadOk(cards) {
  for (const card of cards) {
    card.classList.remove("offline", "stale");
    card.dataset.verified = "1";
    card.dataset.lanKnown = "1";
    const status = card.querySelector(".status");
    if (status) status.textContent = "Online";
    card.querySelector(".status-note")?.remove();
  }
  const device = state.devices.find(item => sameId(item.id, cards[0]?.dataset.id));
  if (device) {
    device.verified = true;
    device.lan_known = true;
  }
  renderHomeQuickDevices(state.devices);
  state.retries.delete(cards[0]?.dataset.id);
  state.failedReads.delete(cards[0]?.dataset.id);
  renderStats();
}

// Cold starts on Android can reach Tuya before the LAN session is ready.
// Retry STATUS READS only (never ON/OFF writes), and keep every device isolated.
async function readLiveStatusWithRetry(deviceId, isCurrent) {
  let lastError;
  // Keep a slow or silent device from holding the UI hostage: the LAN driver
  // already times out in ~2s, so two short attempts are plenty. Config errors
  // (key/protocol) are not transient and stop after the first answer.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!isCurrent()) return null;
    try {
      const data = await api(`/api/local/status?id=${encodeURIComponent(deviceId)}`, { timeout: 6000 });
      if (data.status === "ok" && Array.isArray(data.values) && data.values.length > 0) {
        return data;
      }
      const failure = new Error(data.error || data.status || "No live device values");
      failure.code = String(data.error || data.status || "no_values");
      throw failure;
    } catch (error) {
      lastError = error;
      const transient = /busy|timeout|no.values|empty|unreach|connect|network|fetch|initializ|not.ready|timed.out|refused|econn/i
        .test(String(error.code || "") + " " + String(error.message || ""));
      if (!transient || attempt === 1 || !isCurrent()) break;
      await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError || new Error("No verified live status");
}

async function refresh(deviceId, card, silent = false) {
  if (!card || state.inFlight.has(deviceId) || commandsInFlight.has(String(deviceId))) return;
  const cardsForDevice = () => [...document.querySelectorAll(".tile")]
    .filter(item => sameId(item.dataset.id, deviceId));
  if (!cardsForDevice().length) return;
  state.inFlight.add(deviceId);
  const generation = state.renderGeneration;
  const token = (state.tokens.get(deviceId) || 0) + 1;
  state.tokens.set(deviceId, token);
  const isCurrent = () => state.renderGeneration === generation && state.tokens.get(deviceId) === token;
  if (!silent) {
    for (const item of cardsForDevice()) {
      const host = item.querySelector(".tile-body");
      if (host) host.innerHTML = '<p class="note loading-line"><span class="spinner"></span> Reading live values…</p>';
    }
  }
  for (const item of cardsForDevice()) item.classList.add("refreshing");
  try {
    const data = await readLiveStatusWithRetry(deviceId, isCurrent);
    if (!data) return;
    if (!isCurrent()) return;
    if (data.status !== "ok") {
      markReadFailed(cardsForDevice(), data.error || data.status || "no_values");
      renderReadings();
      if (!silent) {
        for (const item of cardsForDevice()) {
          const host = item.querySelector(".tile-body");
          if (host) host.innerHTML = `<p class="note">${esc(data.error || data.status || "no_values")}</p>`;
        }
      }
      return;
    }
    markReadOk(cardsForDevice());
    state.latest.set(deviceId, data.values || []);
    state.latestReadAt.set(deviceId, Date.now());
    renderReadings();
    const liveDevice = state.devices.find(item => sameId(item.id, deviceId));
    if (liveDevice) {
      for (const item of cardsForDevice()) renderQuickPower(item, liveDevice, item);
    }
    renderHomeQuickDevices(state.devices);
    if (silent) {
      const updated = cardsForDevice().map(item => updatePoints(item, data.values || [])).some(Boolean);
      if (updated) return;
    }
    for (const item of cardsForDevice()) {
      renderPoints(item, deviceId,
        { points: state.devices.find(device => sameId(device.id, deviceId))?.points || [] },
        data.values || [], refresh);
    }
  } catch (error) {
    if (!isCurrent()) return;
    markReadFailed(cardsForDevice(), error.message);
    if (!silent) {
      for (const item of cardsForDevice()) {
        const host = item.querySelector(".tile-body");
        if (host) host.innerHTML = `<p class="note">${esc(error.message)}</p>`;
      }
    }
  } finally {
    for (const item of cardsForDevice()) item.classList.remove("refreshing");
    state.inFlight.delete(deviceId);
  }
}

function renderDevice(device) {
  const card = document.createElement("section");
  const lanKnown = device.lan_known ?? device.reachable ?? !!device.ip;
  const verified = device.verified === true;
  const favorite = state.prefs.favorites.some(id => sameId(id, device.id));
  card.className = `tile ${statusClass(device)}`;
  card.dataset.id = device.id;
  card.dataset.search = deviceSearchText(device);
  card.dataset.lanKnown = lanKnown ? "1" : "0";
  card.dataset.verified = verified ? "1" : "0";
  card.dataset.favorite = favorite ? "1" : "0";
  card.dataset.room = roomName(device);
  card.dataset.home = homeName(device);
  card.dataset.category = device.category || "Other";
  card.dataset.critical = isCriticalDevice(device) ? "true" : "false";

  const visual = deviceIcon(device);
  card.innerHTML =
    '<div class="tile-head"><div class="tile-icon tone-' + esc(visual.kind) + '">' + visual.svg + '</div>' +
      '<div class="tile-title"><h2>' + esc(device.name) + '</h2><p>' +
        esc(device.product_name || device.category || device.id) + '</p></div>' +
      '<button class="fav" data-fav title="Favorite" aria-label="Toggle favorite">' + (favorite ? "★" : "☆") + '</button>' +
      '<span class="status">' + esc(statusLabel(device)) + '</span>' +
      '<button class="compact-open" data-open-details title="Open device details" aria-label="Open device details for ' + esc(device.name) + '">›</button></div>' +
    (verified ? "" : '<p class="note status-note">' +
      esc(device.issue_message || (lanKnown ? "Address saved — waiting for a live reply." : "No IP saved yet.")) + '</p>') +
    '<div class="pilot-inline-power" data-quick-power></div>' +
    '<div class="tile-body"><p class="note">Reading live values…</p></div>' +
    '<div class="tile-foot"><span class="ip">' + (lanKnown ? esc(device.ip) : "no ip") + '</span>' +
      (verified ? "" : '<button class="link-btn" data-fix>Fix connection</button>') +
      '<button class="refresh" title="Refresh" aria-label="Refresh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button></div>';

  card.querySelector(".refresh").onclick = event => {
    event.stopPropagation();
    refresh(device.id, card);
  };
  card.querySelector("[data-fav]").onclick = event => {
    event.stopPropagation();
    toggleFavorite(device.id);
  };
  card.querySelector("[data-open-details]")?.addEventListener("click", event => {
    event.stopPropagation();
    openDeviceDetails(device, event.currentTarget);
  });
  card.querySelector("[data-fix]")?.addEventListener("click", event => {
    event.stopPropagation();
    openDrawer("network", event.currentTarget);
    toast("Scan or check the saved IP, then refresh this device");
  });
  card.addEventListener("details-toggle", () => {
    card.dataset.keepOpen = card.querySelector("details.more")?.open ? "1" : "";
  });
  // Smart-home gesture: tap the card for details, but never for a control.
  card.addEventListener("click", event => {
    if (event.target.closest("button, input, select, textarea, label, a, summary, details, .cap-control, .point")) return;
    openDeviceDetails(device, event.currentTarget);
  });
  card.addEventListener("keydown", event => {
    if (event.target !== card || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    openDeviceDetails(device, event.currentTarget);
  });
  card.tabIndex = 0;
  card.setAttribute("aria-label", `Open details and controls for ${device.name}`);
  const live = state.latest.get(device.id);
  if (verified && Array.isArray(live) && live.length
      && Date.now() - Number(state.latestReadAt.get(device.id) || 0) < 60000) {
    renderPoints(card, device.id, device, live, refresh);
  } else {
    const body = card.querySelector(".tile-body");
    if (body) body.innerHTML = '<p class="note">Reading live state before enabling controls…</p>';
  }
  renderQuickPower(card, device, card);
  return card;
}

function cardsFor(host, devices) {
  if (!host) return;
  host.innerHTML = "";
  if (!devices.length) {
    const message = state.devices.length
      ? "No devices match these filters."
      : "No devices added yet. Use Add device to get started.";
    host.innerHTML = `<div class="empty-mini"><p>${message}</p></div>`;
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const device of devices) fragment.appendChild(renderDevice(device));
  host.appendChild(fragment);
}

// Home is one compact navigation/overview per physical device, never a second
// full control surface. All write controls stay in Devices and the detail sheet.
function renderHomeQuickDevices(devices) {
  const host = $("homeQuickDevices");
  if (!host) return;
  host.replaceChildren();
  const seen = new Set();
  const ordered = sortHomeItems(devices, 'tuya').filter(device => {
    if (seen.has(String(device.id))) return false;
    seen.add(String(device.id));
    return showOnHome('tuya', device.id);
  });
  if (!ordered.length) {
    host.innerHTML = `<div class="pilot-home-empty">${devices.length ?
      'No Tuya tiles shown. Tap Customize to restore hidden devices.' :
      'No Tuya devices added yet. Use + to add one.'}</div>`;
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const device of ordered) {
    const verified = device.verified === true;
    const id = String(device.id);
    // Same information architecture as the Devices tab: identity on the left
    // (icon, name, room, readable status pill), power action on the right.
    const status = verified ? "Online" : statusLabel(device);
    const statusKind = verified ? "online" : (device.lan_known ? "stale" : "offline");
    // The navigation button and inline power button are siblings:
    // never nest an interactive toggle inside another button.
    const markup = `<div class="pilot-home-device-card">
      <button type="button" class="pilot-device-mini${verified ? ' is-verified' : ''}"
        data-device-id="${esc(id)}" data-search="${esc(deviceSearchText(device))}"
        aria-label="Open ${esc(device.name)} details">
        <span class="pilot-device-mini-head">
          <span class="pilot-mini-icon" aria-hidden="true">${deviceIcon(device).svg}</span>
          <span class="pilot-mini-copy"><strong>${esc(device.name)}</strong><small>${esc(roomName(device))}</small></span>
        </span>
        <span class="pilot-mini-signal ${statusKind}"><i aria-hidden="true"></i>${esc(status)}</span>
      </button>
      <div class="pilot-home-inline-power" data-quick-power></div>
    </div>`;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = homeTile('tuya', id, markup);
    const tile = wrapper.firstElementChild;
    tile.dataset.critical = isCriticalDevice(device) ? "true" : "false";
    tile.dataset.id = id;
    renderQuickPower(tile, device, tile);
    fragment.append(tile);
  }
  host.append(fragment);
}

function renderFilterOptions() {
  const homes = [...new Set(state.devices.map(homeName))].sort();
  const rooms = [...new Set(state.devices.map(roomName))].sort();
  const categories = [...new Set(state.devices.map(device => device.category || "Other"))].sort();
  const fill = (id, values, allLabel) => {
    const node = $(id);
    if (!node) return;
    const current = node.value;
    node.innerHTML = `<option value="">${allLabel}</option>` +
      values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
    node.value = values.includes(current) ? current : "";
  };
  fill("homeFilter", homes, "All homes");
  fill("roomFilter", rooms, "All rooms");
  fill("categoryFilter", categories, "All categories");
  state.filters.home = $("homeFilter")?.value || "";
  state.filters.room = $("roomFilter")?.value || "";
  state.filters.category = $("categoryFilter")?.value || "";
}

function renderStats() {
  const total = state.devices.length;
  const online = verifiedCount();
  const saved = savedCount();
  const setValue = (id, value) => { if ($(id)) $(id).textContent = String(value); };
  setValue("statTotal", total);
  setValue("statOnline", online);
  setValue("statSaved", saved);
  setValue("statOffline", Math.max(0, total - online - saved));
  if ($("heroTitle")) {
    const hour = new Date().getHours();
    $("heroTitle").textContent = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  }
}

function renderQuickScenes() {
  const host = $("quickScenes");
  if (!host) return;
  host.innerHTML = "";
  const scenes = state.scenesState.scenes.slice(0, 6);
  if (!scenes.length) {
    host.innerHTML = '<span class="empty-chip">No scenes yet — create one in Scenes.</span>';
    return;
  }
  for (const scene of scenes) {
    const button = document.createElement("button");
    button.className = "scene-chip";
    button.textContent = `⚡ ${scene.name}`;
    button.onclick = async () => {
      button.disabled = true;
      try {
        const result = await runScene(scene.id);
        toast(result.failed ? `${scene.name}: ${result.succeeded} confirmed, ${result.failed} failed`
          : `${scene.name} ✓`, result.failed ? "warn" : "ok");
        await reloadScenes();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        button.disabled = false;
      }
    };
    host.appendChild(button);
  }
}

function renderReadings() {
  const host = $("readingStrip");
  if (!host) return;
  host.innerHTML = "";
  const rows = [];
  for (const device of state.devices.filter(item => item.verified === true && matches(item))) {
    const cap = capabilities(device, state.latest.get(device.id) || device.points || []);
    for (const reading of cap.readings.slice(0, 2)) {
      const match = String(reading.text ?? "").match(/-?\d+(?:\.\d+)?/);
      rows.push({
        text: reading.text,
        label: reading.label,
        device: device.name,
        value: match ? Math.max(0, Number(match[0])) : 0,
      });
    }
  }
  const peak = Math.max(1, ...rows.map(row => row.value));
  host.innerHTML = rows.slice(0, 12).map(row => {
    const level = Math.max(6, Math.min(100, (row.value / peak) * 100)).toFixed(1);
    return `<span class="reading-pill"><b>${esc(row.text)}</b>` +
      `<small>${esc(row.device)} · ${esc(row.label)}</small>` +
      `<span class="reading-bar" aria-hidden="true"><i style="--level:${level}%"></i></span></span>`;
  }).join("") || '<span class="empty-chip">Live readings appear here after a verified local read.</span>';
}

function renderOrganize() {
  const host = $("organizeList");
  if (!host) return;
  host.innerHTML = "";
  if (!state.devices.length) {
    host.innerHTML = '<p class="note">Add a device first, then give it a room and a home name here.</p>';
    return;
  }
  for (const device of state.devices) {
    const row = document.createElement("div");
    row.className = "organize-row";
    row.dataset.id = device.id;
    const room = state.prefs.rooms?.[device.id] || (device.room_status === "unassigned" ? "" : device.room_name || "");
    const home = device.home_name || "";
    row.innerHTML = '<span class="name">' + esc(device.name) + '</span>' +
      '<input type="text" data-home value="' + esc(home) + '" maxlength="60" placeholder="Home" aria-label="Home for ' + esc(device.name) + '">' +
      '<input type="text" data-room value="' + esc(room) + '" maxlength="60" placeholder="Room" aria-label="Room for ' + esc(device.name) + '">';
    host.appendChild(row);
  }
}

async function saveOrganize() {
  const rooms = {};
  const homes = new Set(Array.isArray(state.prefs.homes) ? state.prefs.homes.map(item => item.name) : []);
  for (const row of document.querySelectorAll(".organize-row")) {
    const room = row.querySelector("[data-room]")?.value.trim() || "";
    const home = row.querySelector("[data-home]")?.value.trim() || "";
    if (room) rooms[row.dataset.id] = room;
    if (home) homes.add(home);
  }
  const payload = {
    favorites: state.prefs.favorites,
    rooms,
    homes: [...homes].map(name => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "home", name })),
    updated_at: state.prefs.updated_at || 0,
  };
  try {
    state.prefs = await api("/api/local/preferences", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    toast("Homes and rooms saved", "ok");
    await load(true);
  } catch (error) {
    toast(`Could not save organization: ${error.message}`, "warn");
  }
}

function uniqueCards() {
  const seen = new Set();
  return [...document.querySelectorAll(".tile")].filter(card => {
    const id = card.dataset.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// One queued read per device. `inFlight` alone is not enough because queued
// tasks have not started yet; without this a cold start can enqueue the same
// device twice (once from load() and once from the explicit refresh sweep).
function queueRefresh(card, silent = false) {
  const id = card?.dataset.id;
  if (!id || state.queuedReads.has(id) || state.inFlight.has(id)
      || commandsInFlight.has(String(id))) return;
  state.queuedReads.add(id);
  limiter.queue(async () => {
    try {
      await refresh(id, card, silent);
    } finally {
      state.queuedReads.delete(id);
    }
  });
}

// Cold start, reopen and foreground resume must ask every saved device for a
// fresh live status — including ones not yet verified — without dropping the
// extras when the 2-read Android limit is busy.
function refreshAllDevices(silent = false) {
  for (const card of uniqueCards()) queueRefresh(card, silent);
}

function renderAll({ poll = false } = {}) {
  state.renderGeneration += 1;
  const filtered = state.devices.filter(matches);
  renderFilterOptions();
  renderStats();
  renderQuickScenes();
  renderReadings();
  renderHomeQuickDevices(state.devices);
  cardsFor($("devices"), filtered);
  renderDetailSheet();
  renderOrganize();
  renderSceneList($("sceneList"), {
    scenes: state.scenesState.scenes,
    scheduler: state.scenesState.scheduler,
    devices: state.devices,
  }, sceneHandlers());
  applyFilter();
  if (poll) {
    for (const card of pollableCards()) queueRefresh(card);
  }
}

function applyFilter() {
  const query = state.filters.search.trim().toLowerCase();
  for (const card of document.querySelectorAll(".tile")) {
    if (card.closest("#deviceSheet")) continue;
    card.hidden = !!query && !(card.dataset.search || "").includes(query);
  }
  for (const group of document.querySelectorAll(".room-group")) {
    group.hidden = !group.querySelector(".tile:not([hidden])");
  }
  for (const tile of document.querySelectorAll(".pilot-device-mini")) {
    tile.hidden = !!query && !(tile.dataset.search || "").includes(query);
  }
  const empty = $("deviceEmpty");
  if (empty) empty.hidden = !($("devices")?.querySelectorAll(".tile:not([hidden])").length === 0 && state.devices.length > 0);
}

function setView(view) {
  // Backwards-compatible routes: older Home cards and deep links still work.
  view = ({ac:'autopilot', advanced:'settings'})[view] || view;
  if (isHomeEditing() && view !== 'home') setHomeEditing(false);
  state.view = view;
  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.tabIndex = active ? 0 : -1;
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const section of document.querySelectorAll("[data-view-panel]")) {
    section.hidden = section.dataset.viewPanel !== view;
  }
  if (view === "scenes" && !state.editorMounted && $("sceneEditor")) {
    mountSceneEditor($("sceneEditor"), {
      devices: state.devices,
      editingId: "",
    }, sceneHandlers());
    state.editorMounted = true;
  }
}

function sceneHandlers() {
  return {
    run: runScene,
    remove: deleteScene,
    save: saveScene,
    reload: reloadScenes,
  };
}

async function reloadScenes() {
  state.scenesState = await optionalApi("/api/local/scenes", state.scenesState);
  renderQuickScenes();
  renderSceneList($("sceneList"), {
    scenes: state.scenesState.scenes,
    scheduler: state.scenesState.scheduler,
    devices: state.devices,
  }, sceneHandlers());
}

async function toggleFavorite(deviceId) {
  const favorites = state.prefs.favorites.slice();
  const index = favorites.findIndex(id => sameId(id, deviceId));
  if (index >= 0) favorites.splice(index, 1); else favorites.push(deviceId);
  state.prefs.favorites = favorites;
  for (const card of document.querySelectorAll(`.tile[data-id="${CSS.escape(deviceId)}"]`)) {
    card.dataset.favorite = favorites.some(id => sameId(id, deviceId)) ? "1" : "0";
    const star = card.querySelector("[data-fav]");
    if (star) star.textContent = card.dataset.favorite === "1" ? "★" : "☆";
  }
  try {
    state.prefs = await api("/api/local/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.prefs),
    });
    renderAll();
  } catch (error) {
    toast(`Favorite saved locally: ${error.message}`, "warn");
  }
}

async function load(skipEnsure = false) {
  if (state.loading) return;
  state.loading = true;
  const grid = $("devices");
  grid?.setAttribute("aria-busy", "true");
  try {
    const [data, prefs, scenes] = await Promise.all([
      api("/api/local/devices"),
      optionalApi("/api/local/preferences", null),
      optionalApi("/api/local/scenes", null),
    ]);
    state.devices = safeArray(data.devices);
    if (prefs) state.prefs = prefs;
    if (scenes) state.scenesState = scenes;
    const targetInput = $("scanTargets");
    if (targetInput && data.subnet_hint) targetInput.value = data.subnet_hint;
    const line = $("networkLine");
    if (line) {
      const warning = data.network_warning;
      line.classList.toggle("warn", !!warning);
      line.textContent = warning ? warning.message : data.subnet_hint
        ? `Detected network: ${data.subnet_hint} · IPs are remembered automatically.`
        : "Network not detected. Log in once or set a subnet manually.";
    }
    renderIpList(state.devices);
    repairLine(data);
    renderAll({ poll: true });
    focusDeviceFromUrl();

    const repair = data.repair || {};
    const canEnsure = !skipEnsure && Date.now() >= state.ensureCooldownUntil;
    if (repair.running || (state.devices.some(device => !device.lan_known) && data.subnet_hint && canEnsure)) {
      if (!repair.running && canEnsure) {
        state.ensureCooldownUntil = Date.now() + 60000;
        await optionalApi("/api/local/ensure", { method: "POST" });
      }
      watchReconnect();
    }
  } catch (error) {
    if (grid) grid.innerHTML = `<div class="note" role="status">Device list unavailable. ${esc(error.message)}</div>`;
    const summary = $("summary");
    if (summary && !state.devices.length) summary.textContent = "Device list unavailable";
  } finally {
    grid?.setAttribute("aria-busy", "false");
    state.loading = false;
  }
}

function focusDeviceFromUrl() {
  const focusId = new URLSearchParams(location.search).get("device");
  if (!focusId) return;
  const device = state.devices.find(item => sameId(item.id, focusId));
  if (!device) return;
  setView("devices");
  const search = $("deviceSearch");
  if (search) {
    search.value = device.name;
    state.filters.search = device.name.toLowerCase();
    applyFilter();
  }
  const card = [...document.querySelectorAll(".tile")].find(item => sameId(item.dataset.id, focusId));
  card?.scrollIntoView({ block: "center" });
}

function renderIpList(devices) {
  const host = $("ipList");
  if (!host) return;
  host.innerHTML = "";
  if (!devices.length) { host.innerHTML = '<p class="note">No devices yet.</p>'; return; }
  for (const device of devices) {
    const row = document.createElement("div");
    row.className = "ip-row";
    row.innerHTML = '<span class="name">' + esc(device.name) + '</span>' +
      '<input type="text" value="' + esc(device.ip || device.ip_hint || "") + '" aria-label="IP for ' + esc(device.name) + '">' +
      '<button class="btn small" data-action="check">Check</button>' +
      '<button class="btn small" data-action="edit">Edit</button>' +
      '<button class="btn small danger" data-action="remove" title="Remove">✕</button>';

    const editor = document.createElement("form");
    editor.className = "device-edit";
    editor.hidden = true;
    const currentVersion = String(device.version || "auto");
    const autoSelected = currentVersion === "auto" ? " selected" : "";
    const versionOptions = '<option value="auto"' + autoSelected + '>Auto (detect)</option>' +
      ["3.5", "3.4", "3.3", "3.2", "3.1"]
        .map(v => '<option' + (v === currentVersion ? " selected" : "") + '>' + v + '</option>').join("");
    const gatewayHint = device.sub || device.gateway
      ? "Gateway device: IP/version apply to its gateway."
      : "Leave the new key blank to keep the saved key.";
    const dpField = device.category === "manual"
      ? '<div class="field"><label>ON/OFF DP</label><input name="dp" inputmode="numeric" value="' +
        esc((device.points || []).find(point => /switch/i.test(point.code || ""))?.dp ||
            (device.points || [])[0]?.dp || "1") + '"></div>'
      : "";
    editor.innerHTML =
      '<p class="hint">ID: ' + esc(device.id) + ' · ' + esc(gatewayHint) + '</p>' +
      '<div class="field"><label>Device name</label><input name="name" maxlength="60" required value="' + esc(device.name) + '"></div>' +
      '<div class="field-row">' +
        '<div class="field"><label>IP address</label><input name="ip" inputmode="decimal" value="' + esc(device.ip || device.ip_hint || "") + '"></div>' +
        '<div class="field"><label>Protocol version</label><select name="version">' + versionOptions + '</select></div>' +
      '</div>' +
      '<div class="field"><label>New local key (optional)</label><input name="local_key" type="password" maxlength="32" autocomplete="new-password" placeholder="unchanged"></div>' +
      dpField +
      '<div class="edit-actions"><button class="btn primary small" type="submit">Save changes</button>' +
      '<button class="btn small" type="button" data-action="cancel">Cancel</button></div>';

    const input = row.querySelector("input");
    const checkButton = row.querySelector('[data-action="check"]');
    const editButton = row.querySelector('[data-action="edit"]');
    const removeButton = row.querySelector('[data-action="remove"]');
    const field = name => editor.elements.namedItem(name);

    checkButton.onclick = async () => {
      const ip = input.value.trim();
      if (!ip) { toast("Enter an IP address", "warn"); return; }
      try {
        await api("/api/lan/scan", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_id: device.id, ip }),
        });
        toast(`Checking ${ip}`);
        pollScan($("scanStatus"));
      } catch (error) { toast(error.message, "error"); }
    };
    editButton.onclick = () => {
      editor.hidden = !editor.hidden;
      editButton.textContent = editor.hidden ? "Edit" : "Close";
      if (!editor.hidden) field("name").focus();
    };
    editor.querySelector('[data-action="cancel"]').onclick = () => {
      editor.hidden = true;
      editButton.textContent = "Edit";
    };
    removeButton.onclick = async () => {
      if (!confirm(`Remove ${device.name}?`)) return;
      try {
        await api(`/api/local/device?id=${encodeURIComponent(device.id)}`, { method: "DELETE" });
        await load(true);
        toast("Device removed", "ok");
      } catch (error) { toast(error.message, "error"); }
    };
    editor.onsubmit = async event => {
      event.preventDefault();
      const payload = {
        id: device.id,
        name: field("name").value.trim() || device.name,
        ip: field("ip").value.trim(),
        version: field("version").value,
      };
      const key = field("local_key").value.trim();
      if (key) payload.local_key = key;
      if (field("dp") && field("dp").value.trim()) payload.dp = field("dp").value.trim();
      editButton.disabled = true;
      try {
        await api("/api/local/device", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast("Device settings saved", "ok");
        await load(true);
      } catch (error) {
        toast(error.message, "error");
      } finally {
        editButton.disabled = false;
      }
    };
    host.append(row, editor);
  }
}

function watchReconnect() {
  if (state.scanWatchTimer) return;
  state.scanWatchTimer = setInterval(async () => {
    try {
      const data = await api("/api/local/devices");
      repairLine(data);
      if (!(data.repair || {}).running) {
        clearInterval(state.scanWatchTimer);
        state.scanWatchTimer = null;
        await load(true);
      }
    } catch (error) {
      clearInterval(state.scanWatchTimer);
      state.scanWatchTimer = null;
    }
  }, 1200);
}

async function pollScan(statusEl) {
  for (let i = 0; i < 90; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    let data;
    try { data = await api("/api/lan/scan"); }
    catch (error) { if (statusEl) statusEl.textContent = ""; toast(`Scan status: ${error.message}`, "error"); return; }
    const job = data.job;
    if (!job) { if (statusEl) statusEl.textContent = ""; return; }
    if (job.state === "running") {
      if (statusEl) statusEl.textContent = `Scanning… ${job.progress?.scanned ?? job.progress?.checked ?? ""}`;
      continue;
    }
    if (statusEl) statusEl.textContent = "";
    if (job.state === "done") { toast("Scan complete — devices updated", "ok"); await load(); }
    else if (job.state === "failed") toast(`Scan failed: ${job.error || "unknown"}`, "error");
    else toast(`Scan ${job.state}`, "warn");
    return;
  }
  if (statusEl) statusEl.textContent = "";
  toast("Scan timeout", "warn");
}

let scanInProgress = false;
async function startScan(targets) {
  const statusEl = $("scanStatus");
  if (!statusEl || scanInProgress) return;
  scanInProgress = true;
  const buttons = [$("scanBtn"), $("scanCustomBtn")].filter(Boolean);
  buttons.forEach(button => { button.disabled = true; button.setAttribute('aria-busy','true'); });
  statusEl.textContent = "Starting safe read-only LAN scan…";
  try {
    await api("/api/lan/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets }),
    });
    await pollScan(statusEl);
  } catch (error) {
    statusEl.textContent = "";
    toast(`Scan: ${error.message}`, "error");
  } finally {
    scanInProgress = false;
    buttons.forEach(button => { button.disabled = false; button.removeAttribute('aria-busy'); });
  }
}

let overlayOpener = null;

function activeOverlay() {
  return document.querySelector("#deviceSheet.open, #drawer.open");
}

function showOverlay(overlay, opener) {
  const previous = activeOverlay();
  if (previous === overlay) return;
  const returnTo = previous ? overlayOpener : opener;
  closeOverlays();
  overlayOpener = returnTo;
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  $("scrim")?.classList.add("open");
  for (const element of document.querySelectorAll("body > header, body > main")) {
    element.inert = true;
  }
}

function closeOverlays() {
  const overlay = activeOverlay();
  if (!overlay) return false;
  const opener = overlayOpener;
  overlayOpener = null;
  state.detailDeviceId = "";
  for (const element of document.querySelectorAll("body > header, body > main")) {
    element.inert = false;
  }
  const fallback = document.querySelector('.view-tabs [aria-selected="true"]');
  if (opener instanceof HTMLElement && opener.getClientRects().length) {
    opener.focus({preventScroll: true});
  }
  if (overlay.contains(document.activeElement) || document.activeElement === document.body) {
    fallback?.focus({preventScroll: true});
  }
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  $("scrim")?.classList.remove("open");
  return true;
}

// Native Android Back uses the same dismissal and focus restoration as Escape.
window.smartPilotDismissOverlay = closeOverlays;

function openDrawer(section, opener = document.activeElement) {
  const drawer = $("drawer");
  if (!drawer) return;
  showOverlay(drawer, opener);
  const target = {
    add: $("devName"),
    network: $("scanTargets"),
    appearance: drawer.querySelector("[data-theme-option]"),
  }[section];
  (target || $("closeDrawer") || drawer).focus();
}

function handleOverlayKey(event) {
  const overlay = activeOverlay();
  if (!overlay || event.defaultPrevented) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeOverlays();
  }
  if (event.key !== "Tab") return;
  const tabStops = [...overlay.querySelectorAll(
    "button, a[href], input, select, textarea, summary, [tabindex]"
  )].filter(element => element.tabIndex >= 0 && !element.matches(":disabled")
    && element.getClientRects().length && getComputedStyle(element).visibility === "visible");
  const first = tabStops[0];
  const last = tabStops[tabStops.length - 1];
  const current = document.activeElement;
  if (!tabStops.includes(current) || current === (event.shiftKey ? first : last)) {
    event.preventDefault();
    (event.shiftKey ? last || overlay : first || overlay).focus();
  }
}

function renderDetailSheet() {
  const sheet = $("deviceSheet");
  const body = $("deviceSheetBody");
  if (!sheet?.classList.contains("open") || !body || !state.detailDeviceId) return;
  const device = state.devices.find(item => sameId(item.id, state.detailDeviceId));
  if (!device) {
    closeOverlays();
    return;
  }
  const card = renderDevice(device);
  card.classList.add("detail-card");
  card.removeAttribute("tabindex");
  card.removeAttribute("aria-label");
  card.querySelector("[data-open-details]")?.remove();
  card.dataset.keepOpen = "1";
  // Advanced/raw Tuya DPs stay collapsed until deliberately opened.
  // The everyday sheet should show understandable controls first.
  if (body.contains(document.activeElement)) $("closeDeviceSheet")?.focus();
  body.replaceChildren(card);
  const title = $("deviceSheetTitle");
  const subtitle = $("deviceSheetSubtitle");
  if (title) title.textContent = device.name;
  if (subtitle) subtitle.textContent = `${statusLabel(device)} · ${roomName(device)}`;
}

function openDeviceDetails(device, opener = document.activeElement) {
  const sheet = $("deviceSheet");
  if (!sheet || !device) return;
  if (activeOverlay() === sheet && sameId(state.detailDeviceId, device.id)) return;
  showOverlay(sheet, opener);
  state.detailDeviceId = device.id;
  renderDetailSheet();
  $("closeDeviceSheet")?.focus({preventScroll: true});
}

function pollableCards() {
  return uniqueCards()
    .filter(card => (card.dataset.lanKnown === "1" || card.dataset.verified === "1")
      && !state.inFlight.has(card.dataset.id) && !commandsInFlight.has(String(card.dataset.id)));
}

function pollDelay() {
  if (document.hidden) return 60000;
  // Android may mark Wi-Fi "no internet" while the LAN is fully usable.
  if (state.retries.size) return mobile ? 60000 : 30000;
  return mobile ? 30000 : 12000;
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!$("autoRefresh")?.checked) return;
  state.pollTimer = setTimeout(async () => {
    if (!document.hidden) {
      for (const card of pollableCards()) {
        const next = Number(state.retries.get(card.dataset.id) || 0);
        if (Date.now() < next) continue;
        queueRefresh(card, true);
      }
    }
    schedulePoll();
  }, pollDelay());
}

function initEvents() {
  $("settingsBtn")?.addEventListener("click", event => openDrawer(undefined, event.currentTarget));
  $("editHomeBtn")?.addEventListener("click", () => setHomeEditing(!isHomeEditing()));
  $("addBtn")?.addEventListener("click", event => openDrawer("add", event.currentTarget));
  $("closeDrawer")?.addEventListener("click", closeOverlays);
  $("closeDeviceSheet")?.addEventListener("click", closeOverlays);
  $("scrim")?.addEventListener("click", closeOverlays);
  document.addEventListener("keydown", handleOverlayKey);
  for (const button of document.querySelectorAll("[data-open-drawer]")) {
    button.addEventListener("click", event => openDrawer(button.dataset.openDrawer, event.currentTarget));
  }
  const tabs = Array.from(document.querySelectorAll(".view-tabs [data-view]"));
  for (const [index, button] of tabs.entries()) {
    button.addEventListener("click", () => setView(button.dataset.view));
    button.addEventListener("keydown", event => {
      let nextIndex;
      switch (event.key) {
        case "ArrowLeft": nextIndex = (index + tabs.length - 1) % tabs.length; break;
        case "ArrowRight": nextIndex = (index + 1) % tabs.length; break;
        case "Home": nextIndex = 0; break;
        case "End": nextIndex = tabs.length - 1; break;
        default: return;
      }
      event.preventDefault();
      const next = tabs[nextIndex];
      setView(next.dataset.view);
      next.focus();
    });
  }
  window.addEventListener('smartpilot:home-layout', () => renderHomeQuickDevices(state.devices));
  document.addEventListener('click', event => {
    const actionButton = event.target.closest('[data-home-action]');
    if (actionButton) {
      event.preventDefault(); event.stopPropagation();
      homeAction(actionButton.closest('[data-home-key]')?.dataset.homeKey || '', actionButton.dataset.homeAction);
      return;
    }
    const deviceButton = event.target.closest('#homeQuickDevices [data-device-id]');
    if (deviceButton && !isHomeEditing()) {
      const device = state.devices.find(item=>sameId(item.id,deviceButton.dataset.deviceId));
      if (device) openDeviceDetails(device, deviceButton);
      return;
    }
  });
  // Drag is optional for desktop; mobile uses accessible Up/Down buttons.
  let draggingKey = '';
  document.addEventListener('dragstart', event => {
    const tile = event.target.closest('.pilot-home-tile');
    if (!isHomeEditing() || !tile) return;
    draggingKey = tile.dataset.homeKey || '';
    event.dataTransfer?.setData('text/plain', draggingKey);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragover', event => {
    if (isHomeEditing() && draggingKey && event.target.closest('.pilot-home-tile')) event.preventDefault();
  });
  document.addEventListener('drop', event => {
    const tile = event.target.closest('.pilot-home-tile');
    if (!tile || !draggingKey) return;
    event.preventDefault();
    moveHomeTile(draggingKey, tile.dataset.homeKey);
    draggingKey = '';
  });
  document.addEventListener('dragend', () => { draggingKey = ''; });
  document.addEventListener("click", event => {
    const jump = event.target.closest("[data-jump-view]");
    if (jump) setView(jump.dataset.jumpView);
  });
  const search = $("deviceSearch");
  search?.addEventListener("input", debounce(event => {
    state.filters.search = event.target.value.trim();
    applyFilter();
  }, 120));
  $("homeFilter")?.addEventListener("change", event => { state.filters.home = event.target.value; renderAll(); });
  $("roomFilter")?.addEventListener("change", event => { state.filters.room = event.target.value; renderAll(); });
  $("categoryFilter")?.addEventListener("change", event => { state.filters.category = event.target.value; renderAll(); });
  $("favoriteFilter")?.addEventListener("change", event => {
    state.filters.favoritesOnly = event.target.checked;
    renderAll();
  });
  $("refreshAll")?.addEventListener("click", () => {
    for (const card of uniqueCards()) queueRefresh(card);
  });
  $("saveOrganize")?.addEventListener("click", saveOrganize);
  $("autoRefresh")?.addEventListener("change", schedulePoll);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAllDevices(true);
    schedulePoll();
  });
  // Reopening from the Android back stack can restore a cached page without a
  // fresh visibilitychange; pageshow covers that path too.
  window.addEventListener("pageshow", event => {
    if (event.persisted) refreshAllDevices(true);
  });
  window.addEventListener("online", () => { toast("Network changed — checking local devices", "ok"); load(true); schedulePoll(); });
  window.addEventListener("offline", () => { toast("Internet offline — local Wi-Fi checks continue", "warn"); schedulePoll(); });
  window.addEventListener("pagehide", () => clearTimeout(state.pollTimer));

  $("addForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const payload = {
      name: $("devName").value.trim(), id: $("devId").value.trim(),
      local_key: $("devKey").value.trim(), ip: $("devIp").value.trim(),
      version: $("devVersion").value, dp: $("devDp").value.trim(),
    };
    try {
      await api("/api/local/device", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      closeOverlays();
      event.target.reset();
      await load(true);
      toast("Device saved — waiting for the first live reply", "ok");
    } catch (error) { toast(error.message, "error"); }
  });

  $("scanBtn")?.addEventListener("click", () => {
    const hint = $("networkLine")?.textContent.match(/[0-9.]+(?:\/\d+)?/);
    const targets = $("scanTargets")?.value.trim() || (hint ? `${hint[0]}/24` : "");
    if (!targets) { toast("Network not detected yet", "warn"); return; }
    startScan(targets);
  });
  $("scanCustomBtn")?.addEventListener("click", () => {
    const targets = $("scanTargets").value.trim();
    if (!targets) { toast("Enter a subnet", "warn"); return; }
    startScan(targets);
  });
}

async function boot() {
  initEvents();
  setView("home");
  await load();
  // load() already refreshes verified cards; this sweep also covers saved
  // devices that have never answered, so all five get one fresh read.
  refreshAllDevices(true);
  schedulePoll();
}

boot();
