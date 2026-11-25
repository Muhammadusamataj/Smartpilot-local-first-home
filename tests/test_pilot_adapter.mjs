// Read-only adapter safety regression test (no hardware, no network).
//
// Proves the typed LocalBackendAdapter:
//   - maps the real /api/local catalogue and keeps the two Haier slots first;
//   - only reports power from the genuine boolean switch DP ("1"), never from a
//     numeric meter DP, and never fabricates values;
//   - flips isLive only after a verified read;
//   - never issues a command POST in preview mode or without required approval.
//
// Run: node tests/test_pilot_adapter.mjs

import assert from 'node:assert/strict';

const calls = [];
let statusPayload = { status: 'ok', read_at: '2026-11-25T00:00:00.000Z', values: [{ dp: 1, value: true }] };

const jsonResponse = body => ({ ok: true, status: 200, json: async () => body });

globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  const method = (options.method || 'GET').toUpperCase();
  calls.push({ url: u, method, body: options.body });
  if (u.includes('/local/devices')) {
    return jsonResponse({
      devices: [
        { id: 'w1', name: 'Water Tank', category: 'water_tank', verified: true, points: [{ dp: 1, code: 'switch', type: 'bool' }] },
        { id: 'g1', name: 'Geyser', category: 'water_heater', verified: false, points: [{ dp: 1, code: 'switch', type: 'bool' }] },
        { id: 'm1', name: 'Ground Floor', category: 'breaker', verified: true, points: [{ dp: 2, code: 'cur_power', type: 'value' }] },
        { id: 'ff', name: 'FF Haier 19HFAB T3', category: 'climate', verified: false, points: [{ dp: 1, code: 'switch', type: 'bool' }] },
        { id: 'pro', name: '19HFAB T3 Pro', category: 'climate', verified: true, points: [{ dp: 1, code: 'switch', type: 'bool' }] },
      ],
    });
  }
  if (u.includes('/local/status')) return jsonResponse(statusPayload);
  if (u.includes('/local/command')) return jsonResponse({ ok: true });
  return jsonResponse({});
};

const { LocalBackendAdapter } = await import('../static/js/features/local-control/adapter.js');

// 1. Catalogue mapping keeps the two fixed Haier slots first, in slot order.
const adapter = new LocalBackendAdapter();
const devices = await adapter.listDevices();
assert.equal(devices[0].name, '19HFAB T3 Pro');
assert.equal(devices[1].name, 'FF Haier 19HFAB T3');
assert.equal(adapter.isLive, false, 'cataloguing alone must not mark the adapter live');

const pro = devices.find(d => d.id === 'pro');
assert.equal(pro.kind, 'air_conditioner');
assert.equal(pro.requiresApproval, false, 'climate is not approval-gated by category');
const geyser = devices.find(d => d.id === 'g1');
assert.equal(geyser.requiresApproval, true, 'water heater requires explicit approval');

// 2. A verified read flips isLive and reports power only from boolean DP "1".
const live = await adapter.getStatus('w1');
assert.equal(live.connection, 'online');
assert.equal(adapter.isLive, true);
assert.deepEqual(live.power, { known: true, value: 'on', at: statusPayload.read_at });

// 3. A numeric meter DP is never presented as on/off power.
const meterAdapter = new LocalBackendAdapter();
statusPayload = { status: 'ok', read_at: '2026-11-25T00:00:00.000Z', values: [{ dp: 2, value: 123 }] };
const meterStatus = await meterAdapter.getStatus('m1');
assert.equal(meterStatus.power.known, false, 'a numeric power meter must not be reported as on/off');

// 4. A non-ok read leaves the adapter not live and power unknown.
const coldAdapter = new LocalBackendAdapter();
statusPayload = { status: 'error' };
const cold = await coldAdapter.getStatus('w1');
assert.equal(cold.connection, 'unknown');
assert.equal(cold.power.known, false);
assert.equal(coldAdapter.isLive, false);

// 5. Preview mode never sends a command.
statusPayload = { status: 'ok', read_at: '2026-11-25T00:00:00.000Z', values: [{ dp: 1, value: true }] };
const previewAdapter = new LocalBackendAdapter();
const preview = await previewAdapter.sendCommand('pro', { type: 'power', value: 'off' });
assert.equal(preview.delivered, false);
assert.equal(preview.mode, 'preview');

// 6. An approval-required device is refused without explicit approval, even live.
const guard = new LocalBackendAdapter();
await guard.getStatus('g1'); // make live
const needsApproval = await guard.sendCommand('g1', { type: 'power', value: 'on' });
assert.equal(needsApproval.delivered, false);
assert.equal(needsApproval.message, 'needs_approval');

// 7. No command POST was ever issued across the whole run.
const commandPosts = calls.filter(c => c.method === 'POST' && c.url.includes('/local/command'));
assert.equal(commandPosts.length, 0, 'adapter must never POST a device command in these paths');

console.log('Adapter read-only mapping, verified-only power, preview and approval gating: PASS');