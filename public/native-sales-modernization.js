(()=>{'use strict';
const ROOT_ID='tt-sales-workspace';
let observer=null;
function root(){return document.getElementById(ROOT_ID)}
function addStrip(){const r=root();if(!r)return;const panel=r.querySelector('.tt-sales__panel');if(!panel||panel.querySelector('.pos-cashier-strip'))return;const tabs=panel.querySelector('.tt-sales__tabs');if(!tabs)return;const strip=document.createElement('div');strip.className='pos-cashier-strip';strip.innerHTML='<span class="pos-cashier-strip__state"><span class="pos-cashier-strip__dot"></span>Native POS · Cashier ready</span><span class="pos-cashier-strip__hint"><kbd>/</kbd> Search products &nbsp; <kbd>F2</kbd> Checkout &nbsp; <kbd>F4</kbd> Transactions &nbsp; <kbd>Esc</kbd> Close</span>';tabs.insertAdjacentElement('afterend',strip)}
function focusSearch(){const el=root()?.querySelector('#tt-sales-search');if(!el)return;el.focus();el.select?.();el.classList.add('pos-sales-focus-ring');setTimeout(()=>el.classList.remove('pos-sales-focus-ring'),500)}
function openCheckout(){const b=root()?.querySelector('[data-tab="checkout"]');b?.click();setTimeout(focusSearch,50)}
function openHistory(){root()?.querySelector('[data-tab="history"]')?.click()}
function closeWorkspace(){root()?.querySelector('[data-close]')?.click()}
function handleKey(e){const r=root();if(!r)return;const tag=(e.target?.tagName||'').toLowerCase();const typing=tag==='input'||tag==='textarea'||tag==='select';if(e.key==='Escape'){e.preventDefault();closeWorkspace();return}if(!typing&&e.key==='/'){e.preventDefault();focusSearch();return}if(e.key==='F2'){e.preventDefault();openCheckout();return}if(e.key==='F4'){e.preventDefault();openHistory();return}}
function enhance(){addStrip()}
function watch(){if(observer)return;observer=new MutationObserver(()=>enhance());observer.observe(document.body,{childList:true,subtree:true});enhance();document.addEventListener('keydown',handleKey)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watch,{once:true});else watch();
})();