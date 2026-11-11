(()=>{'use strict';
const defaults={store_name:'Your Business',company_logo_url:'',currency:'JMD',quote_terms:'',invoice_terms:'',purchase_order_terms:'',brand_primary_color:'#0B7A3E',brand_secondary_color:'#075C31',brand_accent_color:'#F2D11F',brand_theme:'light',brand_font:'inter',store_phone:'',store_email:'',store_address:'',receipt_footer:''};
const appearanceDefaults={display_mode:'system',density:'comfortable',accent:'company'};
const accents={blue:['#2563EB','#1D4ED8'],teal:['#0F766E','#115E59'],violet:['#7C3AED','#6D28D9']};
let brand={...defaults},appearance={...appearanceDefaults},loaded=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function safeUrl(url){const value=String(url||'').trim();return value.startsWith('/')&&!value.startsWith('//')&&!value.includes('\\') || /^https:\/\//i.test(value)?value:''}
function initials(name){return String(name||'POS').trim().split(/\s+/).slice(0,2).map(x=>x.charAt(0)).join('').toUpperCase()||'POS'}
function name(){return brand.store_name||defaults.store_name}
function markHTML(){const logo=safeUrl(brand.company_logo_url);return '<span class="shell-mark pos-brand-logo" aria-hidden="true">'+(logo?'<img src="'+esc(logo)+'" alt="" loading="eager">':esc(initials(name())))+'</span>'}
function printHeaderHTML(){const logo=safeUrl(brand.company_logo_url);return '<div style="display:flex;gap:12px;align-items:center;margin-bottom:16px">'+(logo?'<img src="'+esc(logo)+'" alt="" style="max-width:94px;max-height:64px;object-fit:contain">':'')+'<div><strong style="font-size:20px">'+esc(name())+'</strong>'+(brand.store_address?'<div>'+esc(brand.store_address)+'</div>':'')+(brand.store_phone?'<div>'+esc(brand.store_phone)+'</div>':'')+'</div></div>'}
function fontStack(){return brand.brand_font==='manrope'?'Manrope,Inter,system-ui,sans-serif':brand.brand_font==='system'?'system-ui,-apple-system,"Segoe UI",sans-serif':'Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'}
function apply(){
  const style=document.documentElement.style;
  const selected=accents[appearance.accent];
  const primary=selected?selected[0]:brand.brand_primary_color,secondary=selected?selected[1]:brand.brand_secondary_color;
  const settings={'--tt-green':primary,'--tt-green-deep':secondary,'--tt-yellow':brand.brand_accent_color,
    '--tt-brand-primary':brand.brand_primary_color,'--tt-brand-secondary':brand.brand_secondary_color,'--tt-brand-accent':brand.brand_accent_color,
    '--set-green':primary,'--set-green-deep':secondary,'--set-yellow':brand.brand_accent_color,'--tt-font':fontStack()};
  for(const [key,value] of Object.entries(settings))style.setProperty(key,value);
  const mode=appearance.display_mode==='system'?brand.brand_theme:appearance.display_mode;
  document.documentElement.dataset.posMode=mode==='system'?(window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light'):mode;
  document.documentElement.dataset.posDensity=appearance.density;
  document.title=name()+' POS';
  const apple=document.querySelector('meta[name="apple-mobile-web-app-title"]');if(apple)apple.content=name().slice(0,24);
  const theme=document.querySelector('meta[name="theme-color"]');if(theme)theme.content=brand.brand_primary_color;
  const logoUrl=safeUrl(brand.company_logo_url);
  const favicon=document.querySelector('link[rel="icon"]')||document.createElement('link');favicon.rel='icon';favicon.href=logoUrl||'/icons/app-192.png';if(!favicon.parentNode)document.head.appendChild(favicon);
  const appleIcon=document.querySelector('link[rel="apple-touch-icon"]');if(appleIcon)appleIcon.href=logoUrl&&/\.(png|jpe?g)(?:[?#]|$)/i.test(logoUrl)?logoUrl:'/icons/app-192.png';
  document.querySelectorAll('.pos-brand-logo').forEach(el=>{if(logoUrl)el.innerHTML='<img src="'+esc(logoUrl)+'" alt="" loading="eager">';else el.textContent=initials(name());});
  document.querySelectorAll('[data-pos-brand-name]').forEach(el=>{el.textContent=name()});
  document.querySelectorAll('[data-pos-brand-mark]').forEach(el=>{el.innerHTML=markHTML()});
  document.querySelectorAll('[data-pos-brand-nav]').forEach(el=>{el.setAttribute('aria-label',name()+' navigation')});
  document.dispatchEvent(new CustomEvent('pos-branding-updated',{detail:{name:name()}}));
}
async function load(){
  if(loaded)return brand;
  try{const response=await fetch('/api/settings/public',{credentials:'same-origin',cache:'no-store'});if(response.ok){const result=await response.json();brand={...defaults,...result};}}
  catch(_){}
  loaded=true;apply();return brand;
}
async function refresh(){loaded=false;return load()}
async function loadAppearance(){
  try{const response=await fetch('/api/appearance',{credentials:'same-origin',cache:'no-store'});if(response.ok){appearance={...appearanceDefaults,...await response.json()}}else{appearance={...appearanceDefaults}}}catch(_){appearance={...appearanceDefaults}}
  apply();return appearance;
}
function openAppearance(){
  document.getElementById('pos-appearance-dialog')?.remove();
  const overlay=document.createElement('div');overlay.id='pos-appearance-dialog';overlay.className='pos-appearance-overlay';
  const options=(items,selected)=>items.map(([value,title])=>'<option value="'+value+'"'+(value===selected?' selected':'')+'>'+title+'</option>').join('');
  overlay.innerHTML='<div class="pos-appearance-shade" data-close></div><form class="pos-appearance-panel" role="dialog" aria-modal="true" aria-labelledby="pos-appearance-title"><header><div><small>PERSONAL PREFERENCES</small><h2 id="pos-appearance-title">My appearance</h2><p>Your choices follow your employee account across devices.</p></div><button type="button" aria-label="Close" data-close>×</button></header><label>Colour mode<select name="display_mode">'+options([['system','Company default'],['light','Light'],['dark','Dark']],appearance.display_mode)+'</select></label><label>Workspace density<select name="density">'+options([['comfortable','Comfortable'],['compact','Compact']],appearance.density)+'</select></label><label>Interface accent<select name="accent">'+options([['company','Company colours'],['blue','Blue'],['teal','Teal'],['violet','Violet']],appearance.accent)+'</select></label><div class="pos-appearance-error" aria-live="polite"></div><footer><button type="button" data-close>Cancel</button><button type="submit">Save appearance</button></footer></form>';
  document.body.appendChild(overlay);
  const close=()=>overlay.remove();
  overlay.querySelectorAll('[data-close]').forEach(el=>el.addEventListener('click',close));
  overlay.addEventListener('keydown',event=>{if(event.key==='Escape')close()});
  const form=overlay.querySelector('form');
  form.addEventListener('submit',async event=>{
    event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;const payload=Object.fromEntries(new FormData(form));
    try{const response=await fetch('/api/appearance',{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not save preferences');appearance={...appearanceDefaults,...data};apply();close();
    }catch(err){form.querySelector('.pos-appearance-error').textContent=err.message;button.disabled=false;}
  });
  form.querySelector('select')?.focus();
}
window.PosBranding={load,refresh,loadAppearance,openAppearance,markHTML,printHeaderHTML,name,apply,get settings(){return {...brand}},get appearance(){return {...appearance}}};
})();
