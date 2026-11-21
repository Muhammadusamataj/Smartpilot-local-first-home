// Presentation-only Home layout. Device control credentials and capabilities never
// enter browser storage; only opaque device IDs, tile order, and visibility live here.
import { esc } from './api.js';

const STORAGE_KEY = 'smartpilot-home-layout-v1';
const MAX_KEYS = 128;
let editing = false;
let store = { order: [], hidden: [] };

function parseStore(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    const clean = array => Array.isArray(array)
      ? [...new Set(array.filter(x => typeof x === 'string' && /^(haier|tuya):[^\s]{1,80}$/.test(x)))].slice(0, MAX_KEYS)
      : [];
    return { order: clean(value.order), hidden: clean(value.hidden) };
  } catch (_) { return { order: [], hidden: [] }; }
}
try { store = parseStore(window.localStorage.getItem(STORAGE_KEY)); } catch (_) { /* private browsing */ }
function save() {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (_) { /* keep session state */ }
}
function emit() { window.dispatchEvent(new Event('smartpilot:home-layout')); }
export function isHomeEditing() { return editing; }
export function isHomeHidden(kind, id) { return store.hidden.includes(`${kind}:${id}`); }
export function sortHomeItems(items, kind) {
  const positions = new Map(store.order.map((key, index) => [key, index]));
  // Stable sort: new devices appear after existing user-ordered devices.
  return items.map((item, index) => ({item, index})).sort((a,b) => {
    const ax = positions.get(`${kind}:${a.item.id}`);
    const bx = positions.get(`${kind}:${b.item.id}`);
    return (ax ?? MAX_KEYS + a.index) - (bx ?? MAX_KEYS + b.index);
  }).map(({item}) => item);
}
export function showOnHome(kind, id) { return editing || !isHomeHidden(kind, id); }
export function homeTile(kind, id, cardHtml) {
  const key = `${kind}:${id}`;
  const hidden = isHomeHidden(kind, id);
  return `<div class="pilot-home-tile${hidden ? ' pilot-home-hidden' : ''}" data-home-key="${esc(key)}" data-home-kind="${esc(kind)}" draggable="${editing}">${cardHtml}
    <div class="pilot-home-edit-actions" role="group" aria-label="Arrange this Home tile">
      <button type="button" data-home-action="up" aria-label="Move earlier">↑</button>
      <button type="button" data-home-action="down" aria-label="Move later">↓</button>
      <button type="button" data-home-action="visibility" class="pilot-visibility" aria-label="${hidden?'Show':'Hide'} from Home">${hidden?'Show':'Hide'}</button>
    </div></div>`;
}
export function setHomeEditing(enabled) {
  editing = Boolean(enabled);
  document.body.classList.toggle('pilot-home-editing', editing);
  const button = document.getElementById('editHomeBtn');
  if (button) {
    button.textContent = editing ? 'Done ✓' : 'Customize';
    button.setAttribute('aria-pressed', String(editing));
  }
  const hint = document.getElementById('homeEditHint');
  if (hint) hint.hidden = !editing;
  emit();
}
function swapKey(key, adjacentKey) {
  const kind = key.split(':')[0];
  const nodes = [...document.querySelectorAll(`[data-home-kind="${kind}"][data-home-key]`)];
  const visibleKeys = nodes.map(node => node.dataset.homeKey);
  if (!visibleKeys.includes(key) || !visibleKeys.includes(adjacentKey)) return false;
  const a = visibleKeys.indexOf(key), b = visibleKeys.indexOf(adjacentKey);
  [visibleKeys[a], visibleKeys[b]] = [visibleKeys[b], visibleKeys[a]];
  store.order = [...store.order.filter(k => !k.startsWith(`${kind}:`)), ...visibleKeys].slice(0,MAX_KEYS);
  save(); emit(); return true;
}
export function homeAction(key, action) {
  if (!editing || !/^(haier|tuya):/.test(key)) return;
  if (action === 'visibility') {
    if (store.hidden.includes(key)) store.hidden = store.hidden.filter(item=>item!==key);
    else store.hidden = [...store.hidden, key].slice(-MAX_KEYS);
    save(); emit(); return;
  }
  const kind = key.split(':')[0];
  const keys = [...document.querySelectorAll(`[data-home-kind="${kind}"][data-home-key]`)].map(node=>node.dataset.homeKey);
  const index = keys.indexOf(key);
  const next = action === 'up' ? index - 1 : action === 'down' ? index + 1 : -1;
  if (index < 0 || next < 0 || next >= keys.length) return;
  swapKey(key, keys[next]);
}
export function moveHomeTile(sourceKey, targetKey) {
  if (!editing || sourceKey === targetKey || sourceKey.split(':')[0] !== targetKey.split(':')[0]) return;
  const kind = sourceKey.split(':')[0];
  const nodes = [...document.querySelectorAll(`[data-home-kind="${kind}"][data-home-key]`)];
  const keys = nodes.map(n=>n.dataset.homeKey);
  const from = keys.indexOf(sourceKey), to = keys.indexOf(targetKey);
  if (from < 0 || to < 0) return;
  keys.splice(to, 0, keys.splice(from, 1)[0]);
  store.order = [...store.order.filter(k=>!k.startsWith(`${kind}:`)), ...keys].slice(0,MAX_KEYS);
  save(); emit();
}
