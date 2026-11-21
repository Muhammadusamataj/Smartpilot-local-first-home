// Haier independent LAN cards. No local keys ever enter localStorage or GET responses.
// The backend refuses writes on unknown model layouts and confirms responses when possible.
import { api, esc, toast } from "./api.js";
import { homeTile, sortHomeItems, showOnHome } from "./home-layout.js";

const slots = ["pro", "ff"];
const POLL_MS = 60000;
let data = [];
let busy = new Set();
const polling = new Set();
const $ = id => document.getElementById(id);

function value(data, key, suffix="") {
  const x = data?.[key];
  return x === undefined || x === null ? "—" : `${x}${suffix}`;
}
function button(cmd, value, label, disabled = false, important = false) {
  return `<button class="haier-action${important ? ' important' : ''}" type="button" data-haier-cmd="${esc(cmd)}" data-haier-value="${esc(JSON.stringify(value))}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
}
function knownNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function knownBoolean(value) { return typeof value === "boolean"; }
function stateToggle(command, value, label, canWrite) {
  // Never send a guessed toggle when the AC has not reported this feature.
  const known = knownBoolean(value);
  return button(command, known ? !value : false,
    label + " " + (known ? (value ? "ON" : "OFF") : "—"), !canWrite || !known);
}
function card(device) {
  const ready = !!device.configured;
  const verified = !!(device.verified && device.status);
  // Stale cached data are not a trustworthy control baseline.
  const st = verified ? device.status : {};
  const canWrite = verified && st.writable === true;
  const mode = device.mode === "auto" ? "auto" : "manual";
  const paused = mode === "auto" && device.pause_until > Date.now() / 1000;
  const targetKnown = knownNumber(st.target_c) && st.target_c >= 16 && st.target_c <= 30;
  const target = targetKnown ? st.target_c : null;
  const powerKnown = knownBoolean(st.power_on);
  const ecoKnown = knownNumber(st.eco_level);
  const status = !ready ? "SETUP NEEDED" : !verified ? "NOT VERIFIED" : !canWrite ? "READ ONLY" : "LOCAL ONLINE";
  return `<article class="haier-card" data-haier-slot="${esc(device.id)}">
    <div class="haier-card-top"><div class="haier-device-mark" aria-hidden="true">❄</div><div class="haier-card-title"><h3>${esc(device.name)}</h3><div class="haier-status ${verified?'ok':''}"><span class="haier-dot"></span> ${esc(status)}</div></div><button class="haier-iconbtn" type="button" data-haier-setup title="Connection settings" aria-label="Configure ${esc(device.name)}">⚙</button></div>
    <div class="haier-mid"><div><div class="haier-room-caption">Room temperature</div><div class="haier-room">${value(st, "room_c", "°")}<small>C</small></div></div><div class="haier-target"><span>SETPOINT</span><strong>${value(st, "target_c", "°C")}</strong><span>Power ${value(st,"power_w"," W")}</span></div></div>
    <div class="haier-mode-tabs" role="group" aria-label="Operating mode"><button type="button" data-haier-mode="manual" class="${mode==='manual'?'current':''}" ${!ready?'disabled':''}>✋ Manual</button><button type="button" data-haier-mode="auto" class="${mode==='auto'?'current':''}" ${!canWrite?'disabled':''}>✧ Auto-Pilot</button></div>
    <div class="haier-controls">
      <div class="haier-top-control">${button('power', powerKnown ? !st.power_on : false, !powerKnown ? 'Power —' : st.power_on ? 'Turn OFF' : 'Turn ON', !canWrite || !powerKnown, true)}<div class="haier-temp-ctrl">${button('temperature', targetKnown ? Math.max(16,target-1) : 26, '−', !canWrite || !targetKnown || target <= 16)}<span>${targetKnown ? target+'°C' : '—'}</span>${button('temperature', targetKnown ? Math.min(30,target+1) : 26, '+', !canWrite || !targetKnown || target >= 30)}</div></div>
      <div class="haier-quick">${button('eco', ecoKnown ? st.eco_level === 0 : false, 'Eco ' + (ecoKnown ? (st.eco_level ? 'ON' : 'OFF') : '—'), !canWrite || !ecoKnown)}${stateToggle('quiet',st.quiet,'Quiet',canWrite)}${stateToggle('sleep',st.sleep,'Sleep',canWrite)}${stateToggle('strong',st.strong,'Strong',canWrite)}</div>
    </div>
    <div class="haier-footer"><span>${!ready ? 'Add LAN IP, Wi-Fi module ID and key' : !verified ? 'Refresh to verify current LAN status' : !canWrite ? 'Unsupported model layout; writes blocked' : `Mode: ${esc(st.hvac_mode||'—')} · Fan: ${esc(st.fan||'—')}`}</span><button class="haier-refresh" type="button" data-haier-read ${!ready ? 'disabled' : ''}>↻ Refresh</button></div>
    ${paused ? `<p class="haier-alert">Manual override: Auto paused until ${new Date(device.pause_until*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}.</p>` : ''}
    ${mode==='auto' && device.auto_error ? `<p class="haier-alert">Auto check failed: ${esc(device.auto_error)}</p>` : ''}
    ${mode==='auto' ? `<div class="haier-auto-note">Summer Auto: 26°C day / 27°C night, Eco daytime, Sleep at night. Changes only an already-running compatible AC. ${paused?'Paused.':''}</div><button type="button" class="haier-pause-btn" data-haier-pause>Pause Auto for 2 hours</button>` : ''}
    <div class="haier-config" hidden></div>
  </article>`;
}

function overviewCard(device) {
  const st = device.status || {};
  const ready = !!device.configured;
  const verified = !!(device.verified && device.status);
  const online = verified && st.writable === true;
  const room = verified && st.room_c != null ? `${esc(String(st.room_c))}°` : '—';
  const target = verified && st.target_c != null ? `${esc(String(st.target_c))}°` : '—';
  const status = !ready ? 'SETUP' : !verified ? 'NOT VERIFIED' : !online ? 'READ ONLY' : knownBoolean(st.power_on) ? (st.power_on ? 'ON' : 'OFF') : 'UNKNOWN';
  const power = verified && knownNumber(st.power_w) ? `${esc(String(st.power_w))} W` : 'No live watts';
  const auto = device.mode === 'auto';
  const paused = auto && device.pause_until > Date.now() / 1000;
  const modeLabel = paused ? 'AUTO PAUSED' : auto ? 'AUTO' : 'MANUAL';
  return `<button type="button" class="pilot-ac-mini" data-jump-view="autopilot" data-haier-focus="${esc(device.id)}" aria-label="Open ${esc(device.name)} controls">
    <span class="pilot-ac-mini-top"><span class="pilot-ac-mini-icon" aria-hidden="true">❄</span><span class="pilot-ac-mini-state ${verified?'online':''}">${status}</span></span>
    <strong>${esc(device.name)}</strong>
    <span class="pilot-ac-mini-temps"><b>${room}</b><span>Target ${target}</span></span>
    <span class="pilot-ac-mini-bottom">${modeLabel} · ${power}<span aria-hidden="true">›</span></span>
  </button>`;
}
window.addEventListener('smartpilot:home-layout', () => drawOverview());
function drawOverview() {
  for (const mount of document.querySelectorAll('[data-haier-overview]')) {
    const visible = sortHomeItems(data, 'haier').filter(device=>showOnHome('haier',device.id));
    mount.innerHTML = visible.length
      ? visible.map(device=>homeTile('haier',device.id,overviewCard(device))).join('')
      : '<div class="pilot-home-empty">No AC tiles shown. Tap Customize to restore them.</div>';
    for (const tile of mount.querySelectorAll('.pilot-home-tile')) tile.draggable = document.body.classList.contains('pilot-home-editing');
  }
}
function draw() {
  drawOverview();
  if (document.querySelector('.haier-config:not([hidden]) form')) return; // preserve key-entry form
  for (const mount of document.querySelectorAll('[data-haier-cards]')) {
    mount.innerHTML = data.length ? data.map(card).join('') : '<p class="note">Haier connection details load nahi ho sake.</p>';
  }
  const count = $('haierCount');
  if (count) count.textContent = data.filter(d=>d.verified).length + ' / 2 local';
}
async function getDevices() {
  try {
    const response = await api('/api/haier/devices');
    data = response.devices || [];
    draw();
  } catch (err) {
    // Never leave an old ONLINE badge and enabled write buttons after API failure.
    data = data.map(device => ({...device, verified:false, status:null}));
    draw();
    toast('Haier backend unavailable: '+err.message, 'warn');
  }
}

// Quiet background LAN read. The strict /read endpoint is still used by the
// Refresh button; /poll keeps the last good state if the AC is briefly busy.
async function pollSlot(slot) {
  if (polling.has(slot) || busy.has(slot) || document.hidden) return;
  polling.add(slot);
  try {
    const response = await api('/api/haier/poll', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({slot}), timeout: 18000
    });
    if (response.ok && response.device) {
      data = data.map(device => device.id === slot ? {...device, ...response.device} : device);
      draw();
    }
  } catch (err) {
    // Silent by design: a transient LAN conflict must not disable controls or
    // spam the user. The next poll retries; /devices still enforces freshness.
  } finally {
    polling.delete(slot);
  }
}
async function pollAll() {
  if (document.hidden || document.querySelector('.haier-config:not([hidden]) form')) return;
  // ACs accept one local session at a time, so poll sequentially.
  for (const device of data) {
    if (device.configured) await pollSlot(device.id);
  }
}

async function send(slot, path, payload = {}) {
  if (busy.has(slot)) return;
  busy.add(slot);
  try {
    const response = await api('/api/haier/'+path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot,...payload}),timeout:18000});
    if (response.confirmed === false) toast('Command sent, reply unconfirmed — do not repeat quickly', 'warn');
    else toast('Haier '+path+' ✓','ok');
    await getDevices();
    return response;
  } catch (err) {
    toast(err.message,'error');
  } finally { busy.delete(slot); }
}
function setupCard(slot, root) {
  const panel = root.querySelector('.haier-config');
  if (!panel) return;
  if (!panel.hidden) { panel.hidden=true;panel.innerHTML='';return; }
  const known = data.find(d=>d.id===slot);
  panel.hidden = false;
  panel.innerHTML = `<form data-haier-form="${esc(slot)}" autocomplete="off">
     <h4>Direct LAN connection — ${esc(known?.name || 'Haier')}</h4>
     <p>Your key is encrypted on the app server / phone and is not returned to this page. Never share screenshots with the key visible.</p>
     <button class="haier-action" type="button" data-haier-scan>Scan LAN for Haier devices</button>
     <div class="haier-discover" aria-live="polite"></div>
     <label>LAN IPv4 address<input name="ip" required placeholder="192.168.1.50" value="${esc(known?.ip||'')}" inputmode="decimal"></label>
     <label>Wi-Fi module Device ID<input name="device_id" required maxlength="32" placeholder="12-32 character module ID" value="${esc(known?.device_id||'')}"></label>
     <label>Haier Local Key (32 hex)<input name="local_key" required type="password" maxlength="32" placeholder="Paste from Haier local key sensor"></label>
     <label>Local Key version<input name="key_version" type="number" min="0" max="65535" value="${esc(known?.key_version||0)}"></label>
     <input type="hidden" name="uplus_id" value="${esc(known?.uplus_id||'')}">
     <input type="hidden" name="product_code" value="${esc(known?.product_code||'')}">
     <p class="haier-warning">Scan fills the IP and module ID. You still need the 32-hex local key. Save resets this AC to Manual mode. Don't run HA's HaiSmart integration polling the same AC during direct-LAN tests.</p>
     <button class="haier-action important" type="submit">Save encrypted connection</button>
   </form>`;
}

async function scanLan(cardRoot) {
  const out = cardRoot.querySelector('.haier-config .haier-discover');
  if (!out) return;
  out.innerHTML = '<p class="haier-warning">Scanning local network…</p>';
  try {
    const response = await api('/api/haier/discover', {timeout: 12000});
    const found = response.devices || [];
    out.innerHTML = found.length
      ? `<p class="haier-warning">Found ${found.length} Haier device(s). Tap Use, then paste the local key.</p>`
        + found.map(device => `<div class="haier-discover-row"><span>${esc(device.ip)} · ${esc(device.device_id)}${device.cloud_state_name ? ' · cloud '+esc(device.cloud_state_name) : ''}</span><button class="haier-action" type="button" data-haier-use data-ip="${esc(device.ip)}" data-device-id="${esc(device.device_id)}" data-uplus-id="${esc(device.uplus_id||'')}">Use</button></div>`).join('')
      : `<p class="haier-warning">No devices answered. Broadcast discovery needs UDP 7083; enter the LAN details manually if your network blocks it.</p>`;
  } catch (err) {
    out.innerHTML = `<p class="haier-warning">Scan failed: ${esc(err.message)}. You can still enter the details manually.</p>`;
  }
}

function useDiscovered(button) {
  const form = button.closest('form');
  if (!form) return;
  const set = (name, value) => { const field = form.querySelector(`[name="${name}"]`); if (field) field.value = value; };
  set('ip', button.dataset.ip || '');
  set('device_id', button.dataset.deviceId || '');
  set('uplus_id', button.dataset.uplusId || '');
  toast('Haier device details filled', 'ok');
}
async function handler(event) {
  const button = event.target.closest('button');
  // A Home summary navigates to the *correct* AC, not the top of a long page.
  const focusedSlot = button?.dataset?.haierFocus;
  if (focusedSlot && slots.includes(focusedSlot)) {
    requestAnimationFrame(() => {
      const target = document.querySelector(`[data-haier-cards] [data-haier-slot="${focusedSlot}"]`);
      target?.scrollIntoView({behavior:'smooth', block:'start'});
    });
    return;
  }
  const cardRoot = event.target.closest('[data-haier-slot]');
  if (!button || !cardRoot) return;
  const slot = cardRoot.dataset.haierSlot;
  if (button.hasAttribute('data-haier-setup')) { setupCard(slot,cardRoot); return; }
  if (button.hasAttribute('data-haier-scan')) { await scanLan(cardRoot); return; }
  if (button.hasAttribute('data-haier-use')) { useDiscovered(button); return; }
  if (button.hasAttribute('data-haier-read')) { await send(slot,'read'); return; }
  if (button.hasAttribute('data-haier-mode')) {
    const mode = button.dataset.haierMode;
    if (mode === 'auto' && !window.confirm('Auto-Pilot will manage an ALREADY RUNNING AC in summer (26°C day/27°C night). No auto start/stop. Continue?')) return;
    await send(slot,'mode',{mode}); return;
  }
  if (button.hasAttribute('data-haier-pause')) {await send(slot,'pause');return;}
  if (button.hasAttribute('data-haier-cmd')) {
    const command = button.dataset.haierCmd;
    const val = JSON.parse(button.dataset.haierValue);
    if (command==='power' && val===true && !window.confirm('Turn this Haier AC ON?')) return;
    await send(slot,'command',{command,value:val});return;
  }
}
async function formHandler(event) {
  const form=event.target.closest('[data-haier-form]');
  if(!form) return;
  event.preventDefault();
  const slot=form.dataset.haierForm;
  const fields=new FormData(form);
  const payload={ip:String(fields.get('ip')||'').trim(),device_id:String(fields.get('device_id')||'').trim(),local_key:String(fields.get('local_key')||'').trim(),key_version:Number(fields.get('key_version')||0),uplus_id:String(fields.get('uplus_id')||'').trim(),product_code:String(fields.get('product_code')||'').trim()};
  try { await send(slot,'config',payload); }
  finally { form.querySelector('[name=local_key]').value=''; }
}
export function mountHaier() {
  document.addEventListener('click',handler);
  document.addEventListener('submit',formHandler);
  getDevices();
  // First fresh read soon after open, then every minute while visible. A
  // background daemon handles Auto when enabled, even with the phone closed.
  setTimeout(pollAll, 3000);
  setInterval(pollAll, POLL_MS);
  setInterval(()=>{if(!document.hidden) getDevices();},45000);
}
mountHaier();
