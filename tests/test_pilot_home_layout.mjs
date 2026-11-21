import assert from 'node:assert/strict';
const saved = new Map();
const classes = new Set();
const buttons = {
  editHomeBtn: { textContent: '', setAttribute() {} },
  homeEditHint: { hidden: true },
};
let deviceOrder = ['tuya:one', 'tuya:two', 'tuya:three'];
globalThis.window = {
  localStorage: {getItem: key => saved.get(key) ?? null, setItem: (key,value) => saved.set(key,value)},
  dispatchEvent() {},
};
globalThis.Event = class Event {constructor(type) {this.type=type;}};
globalThis.document = {
  body: {classList: {toggle(name,on){if(on)classes.add(name);else classes.delete(name);}}},
  getElementById: id => buttons[id],
  querySelectorAll: selector => {
    if (selector.includes('tuya')) return deviceOrder.map(homeKey => ({dataset: {homeKey}}));
    return [];
  },
};
const lib = await import('../static/js/features/local-control/home-layout.js');
const original = [{id:'one'},{id:'two'},{id:'three'}];
assert.deepEqual(lib.sortHomeItems(original,'tuya').map(x=>x.id),['one','two','three']);
assert.equal(lib.showOnHome('tuya','one'),true);
lib.setHomeEditing(true);
assert.equal(lib.isHomeEditing(),true);
lib.homeAction('tuya:two','up');
assert.deepEqual(lib.sortHomeItems(original,'tuya').map(x=>x.id),['two','one','three']);
deviceOrder=['tuya:two','tuya:one','tuya:three'];
lib.homeAction('tuya:two','visibility');
assert.equal(lib.isHomeHidden('tuya','two'),true);
assert.equal(lib.showOnHome('tuya','two'),true); // edit mode exposes hidden cards
lib.setHomeEditing(false);
assert.equal(lib.showOnHome('tuya','two'),false);
assert.ok(saved.get('smartpilot-home-layout-v1').includes('tuya:two'));
assert.ok(lib.homeTile('tuya','<script>', '<button>safe</button>').includes('&lt;script&gt;'));
assert.equal(buttons.homeEditHint.hidden,true);
assert.ok(!classes.has('pilot-home-editing'));
console.log('Home layout state, reorder, hide, restore and escaping: PASS');
