#!/usr/bin/env python3
"""Browser smoke test of real Haier card JS with mocked responses; never touches LAN."""
from pathlib import Path
from html import escape
from jinja2 import Environment,FileSystemLoader
from playwright.sync_api import sync_playwright
import json, os, re
root=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('PILOT_UI_SHOT',root/'SmartPilot_v0.5_Mobile.png'))
preview_out=Path(os.environ.get('PILOT_UI_HTML',root/'SmartPilot_v0.5_Preview.html'))
html=Environment(loader=FileSystemLoader(root/'templates')).get_template('local_control.html').render(ready=True,subnet_hint='',home_assistant=False,tailscale_url=None)
html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.I|re.S)
html=re.sub(r'<link\s+rel="stylesheet"[^>]*>','',html)
css='\n'.join((root/x).read_text() for x in ['static/css/base.css','static/css/local-control.css','static/css/design-system.css','static/css/lumen.css','static/css/pilot-theme.css','static/css/haier.css','static/css/pilot-compact.css'])
html=html.replace('</head>','<style>'+css+'</style></head>')
mini=[]
for name,room,online,icon in [('Water Tank','Porch',True,'◉'),('First Floor Breaker','Porch',False,'⚡'),('Ground Floor','Porch',True,'⌂'),('Bore Motor','Porch',False,'◌'),('Geyser','Terrace',True,'♨')]:
 mini.append(f'<button type="button" class="pilot-device-mini"><span class="pilot-device-mini-head"><span class="pilot-mini-icon">{icon}</span><span class="pilot-mini-signal {"online" if online else ""}">{"ONLINE" if online else "NOT VERIFIED"}</span></span><strong>{escape(name)}</strong><small>{room}</small></button>')
html=html.replace('<div id="homeQuickDevices" class="pilot-device-summary-grid" aria-live="polite"></div>',f'<div id="homeQuickDevices" class="pilot-device-summary-grid" aria-live="polite">{"".join(mini)}</div>')
html=html.replace('<p id="summary">Checking local devices…</p>','<p id="summary">5 devices · sample status only</p>')
html=html.replace('<body>','<body><div class="demo-banner">VISUAL DEMO · SAMPLE STATUSES · NO AC COMMANDS</div>')
html=html.replace('</head>','<style>.demo-banner{position:sticky;top:0;z-index:101;text-align:center;background:#284565;color:#fff;font:10px sans-serif;padding:7px;letter-spacing:.5px}</style></head>')
MOCK={'devices':[
 {'id':'pro','name':'19HFAB T3 Pro','configured':True,'ip':'192.168.1.40','mode':'manual','pause_until':0,'verified':True,
  'status':{'writable':True,'room_c':24,'target_c':26,'power_on':True,'power_w':540,'hvac_mode':'cool','fan':'auto','eco_level':5,'quiet':False,'sleep':False,'strong':False}},
 {'id':'ff','name':'FF Haier 19HFAB T3','configured':True,'ip':'192.168.1.41','mode':'auto','pause_until':0,'verified':True,
  'status':{'writable':True,'room_c':22.5,'target_c':25,'power_on':False,'power_w':0,'hvac_mode':'cool','fan':'auto','eco_level':0,'quiet':False,'sleep':False,'strong':False}}]}
source=(root/'static/js/features/local-control/haier.js').read_text()
assert 'import { api, esc, toast }' in source
source=source.replace('import { api, esc, toast } from "./api.js";','''const api = async path => {if (path.endsWith('/devices')) return window.FAKE_HAIER; throw Error('Demo commands disabled');};
const esc = val => String(val ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toast = () => {};''').replace('export function mountHaier()', 'function mountHaier()')
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=b.new_page(viewport={'width':390,'height':844},device_scale_factor=1,is_mobile=True,has_touch=True)
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content(html,wait_until='domcontentloaded')
 page.evaluate('data => {window.FAKE_HAIER=data;}', MOCK)
 page.add_script_tag(content='''document.addEventListener('click',event=>{const b=event.target.closest('[data-view],[data-jump-view]');if(!b)return;const v=b.dataset.view||b.dataset.jumpView;document.querySelectorAll('[data-view-panel]').forEach(s=>s.hidden=s.dataset.viewPanel!==v);document.querySelectorAll('[data-view]').forEach(t=>t.classList.toggle('active',t.dataset.view===v));});''')
 page.add_script_tag(content=source)
 page.wait_for_function("document.querySelectorAll('.pilot-ac-mini').length===2")
 assert not errors,errors
 assert page.locator('[data-view-panel="home"]:visible .pilot-ac-mini').count()==2
 assert page.locator('[data-view-panel="home"]:visible .pilot-device-mini').count()==5
 assert page.locator('[data-view-panel="home"]:visible .haier-card').count()==0
 size=page.evaluate('({viewport:innerHeight,document:document.documentElement.scrollHeight})')
 print('Home size',size)
 page.locator('.pilot-ac-mini[data-haier-focus="ff"]').click()
 assert page.locator('[data-view-panel="ac"]:visible').count()==1
 assert page.locator('[data-haier-cards] .haier-card').count()==2
 # Render controls from malformed/incomplete live state: unknown toggle MUST be disabled.
 MOCK['devices'][0]['status'].pop('quiet');MOCK['devices'][0]['status'].pop('eco_level')
 page.evaluate('data=>{window.FAKE_HAIER=data;}',MOCK)
 # Verify a separate isolated page with unknown feature status.
 q=b.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
 q.set_content(html)
 q.evaluate('data=>window.FAKE_HAIER=data',MOCK)
 q.add_script_tag(content=source)
 q.wait_for_function("document.querySelectorAll('[data-haier-cards] .haier-card').length===2")
 assert q.locator('[data-haier-slot="pro"] [data-haier-cmd="quiet"]').is_disabled()
 assert q.locator('[data-haier-slot="pro"] [data-haier-cmd="eco"]').is_disabled()
 q.close()
 MOCK['devices'][0]['status']['quiet']=False;MOCK['devices'][0]['status']['eco_level']=5
 MOCK['devices'][1]['verified']=False
 q=b.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
 q.set_content(html)
 q.evaluate('data=>window.FAKE_HAIER=data',MOCK)
 q.add_script_tag(content=source)
 q.wait_for_function("document.querySelectorAll('[data-haier-cards] .haier-card').length===2")
 assert q.locator('[data-haier-slot="ff"] .haier-room').inner_text().strip().startswith('—')
 assert q.locator('[data-haier-slot="ff"] [data-haier-cmd="power"]').is_disabled()
 q.close()
 # Restore the fully verified dummy data for screenshot (clearly demo-labeled).
 MOCK['devices'][1]['verified']=True
 page2=b.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
 page2.set_content(html)
 page2.evaluate('data=>window.FAKE_HAIER=data',MOCK)
 page2.add_script_tag(content=source)
 page2.wait_for_function("document.querySelectorAll('.pilot-ac-mini').length===2")
 page2.screenshot(path=str(out),full_page=True)
 rendered=page2.content()
 rendered=re.sub(r'<script\b[^>]*>.*?</script>','',rendered,flags=re.I|re.S)
 rendered=rendered.replace('</body>', '''<script>document.querySelectorAll('[data-view],[data-jump-view]').forEach(b=>b.addEventListener('click',()=>{const v=b.dataset.view||b.dataset.jumpView;document.querySelectorAll('[data-view-panel]').forEach(s=>s.hidden=s.dataset.viewPanel!==v);document.querySelectorAll('[data-view]').forEach(t=>t.classList.toggle('active',t.dataset.view===v));}));</script></body>''')
 preview_out.write_text(rendered)
 print('PASS: 2 ACs, 5 devices, unknown states disabled, stale control disabled; preview:',preview_out)
 b.close()
