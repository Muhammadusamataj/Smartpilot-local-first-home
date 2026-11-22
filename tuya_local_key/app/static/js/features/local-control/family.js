// Family hub (opt-in). One phone keeps the device keys; other phones forward a
// small allowlist of control calls to it. Credentials are never rendered again.
import { api, esc, toast } from "./api.js";

let status = null;
let message = "";
const MODES = [
  ["off", "Off"],
  ["hub", "This phone is hub"],
  ["client", "Connect to hub"],
];

function modeHtml(s) {
  if (s.mode === "hub") {
    const address = s.lan_ip ? `http://${esc(s.lan_ip)}:8000` : "Wi-Fi address not available";
    return `<div class="haier-config">
      <p class="note"><b>Hub address:</b> <code>${address}</code></p>
      ${s.direct_mode
        ? `<p class="note">Direct mode is ON. Share this address and the username/password you set in the phone’s Direct mode panel; enter them on the family phone below.</p>`
        : `<p class="haier-warning">Direct mode is OFF. Set a username/password and switch it on first.</p>`}
      <button class="haier-action" type="button" data-family-open-direct>Open direct mode settings</button>
    </div>`;
  }
  if (s.mode === "client") {
    return `<form class="haier-config" data-family-form autocomplete="off">
      <p class="note">${s.connected ? 'Connected ✓' : esc(s.last_error || 'Not connected yet')}</p>
      <label>Hub address<input name="hub_url" value="${esc(s.hub_url || '')}" placeholder="http://192.168.100.19:8000" required></label>
      <label>Hub username<input name="username" autocomplete="username" required></label>
      <label>Hub password<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="note">Saved encrypted on this phone. It is never shown here again.</p>
      <button class="haier-action important" type="submit" data-family-connect>Connect to hub</button>
      <button class="haier-action" type="button" data-family-test>Test connection</button>
    </form>
    <button class="haier-action" type="button" data-family-disconnect style="margin-top:9px">Disconnect</button>`;
  }
  return `<p class="note">Off. Every phone controls only the devices configured on that phone. Choose a mode above to share control over your home Wi-Fi.</p>`;
}

function draw() {
  const mount = document.querySelector("[data-family-hub]");
  if (!mount || !status) return;
  mount.innerHTML = `<section class="panel haier-config" data-family-card style="margin-bottom:14px">
    <div class="haier-intro"><div><h3>Family sharing</h3><p>One phone at home shares control over Wi-Fi · keys stay on the hub</p></div><span class="haier-tag">OPTIONAL</span></div>
    <p class="haier-warning" data-family-msg role="status">${esc(message)}</p>
    <div class="haier-quick">${MODES.map(([id, label]) =>
      `<button class="haier-action${status.mode === id ? ' important' : ''}" type="button" data-family-mode="${id}">${esc(label)}</button>`
    ).join("")}</div>
    ${modeHtml(status)}
    <p class="note" style="margin-top:10px">Hub phone must stay powered on and on the same Wi-Fi. Outside the home, use your vendor cloud app or a VPN.</p>
  </section>`;
}

async function getStatus() {
  try {
    status = await api("/api/family/status");
  } catch (err) {
    status = { mode: "off", direct_mode: false, lan_ip: "", hub_url: "", connected: false };
  }
  draw();
}

function payloadFromForm(form) {
  const fields = new FormData(form);
  return {
    hub_url: String(fields.get("hub_url") || "").trim(),
    username: String(fields.get("username") || "").trim(),
    password: String(fields.get("password") || ""),
  };
}

async function setMode(mode) {
  message = mode === "hub" ? "Hub mode on. Enable Direct mode if it is off." : "Family sharing off.";
  try {
    await api("/api/family/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    toast("Family mode updated", "ok");
  } catch (err) {
    message = err.message;
    toast(err.message, "error");
  }
  await getStatus();
}

async function connect(form) {
  const data = payloadFromForm(form);
  const submit = form.querySelector("[data-family-connect]");
  if (submit) submit.disabled = true;
  message = "Connecting to hub…";
  const live = document.querySelector("[data-family-msg]");
  if (live) live.textContent = message;
  try {
    const saved = await api("/api/family/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "client", ...data }),
    });
    const result = await api("/api/family/check", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    message = result.ok ? `Connected to ${saved.hub_url}` : (result.error || "Could not reach hub");
    toast(result.ok ? "Connected to hub ✓" : message, result.ok ? "ok" : "warn");
  } catch (err) {
    message = err.message;
    toast(err.message, "error");
  }
  await getStatus();
}

async function testHub(form) {
  const data = payloadFromForm(form);
  message = "Saving and testing…";
  const live = document.querySelector("[data-family-msg]");
  if (live) live.textContent = message;
  try {
    await api("/api/family/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "client", ...data }),
    });
    const result = await api("/api/family/check", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    message = result.ok ? "Hub reachable ✓" : (result.error || "Hub not reachable");
  } catch (err) {
    message = err.message;
  }
  await getStatus();
}

async function disconnect() {
  try {
    await api("/api/family/disconnect", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    message = "Disconnected. No credentials remain on this phone.";
  } catch (err) {
    message = err.message;
  }
  await getStatus();
}

document.addEventListener("click", async (event) => {
  const mode = event.target.closest("[data-family-mode]");
  if (mode) { await setMode(mode.dataset.familyMode); return; }
  if (event.target.closest("[data-family-open-direct]")) {
    const native = window.PilotNative;
    if (native && typeof native.openDirectSettings === "function") native.openDirectSettings();
    else toast("Open Direct mode settings from the app's status bar.", "info");
    return;
  }
  if (event.target.closest("[data-family-disconnect]")) { await disconnect(); return; }
  const test = event.target.closest("[data-family-test]");
  if (test) { await testHub(test.closest("form")); }
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-family-form]");
  if (!form) return;
  event.preventDefault();
  connect(form);
});

getStatus();
