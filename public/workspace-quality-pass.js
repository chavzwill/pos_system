(()=>{'use strict';
const known=new WeakSet();let lastTrigger=null;
function isWorkspace(el){if(!(el instanceof HTMLElement)||!el.id)return false;return /^tt-.*(?:workspace|operations|intelligence|controls|reconciliation|ledger|admin|reports|settings|suppliers|rentals|inventory|purchasing|wo)$/.test(el.id)||['tt-sales-workspace','tt-admin-workspace','tt-work-orders-workspace'].includes(el.id);}
function closeControl(el){return el.querySelector('[data-close],.tt-sales__close,.tt-admin__head>button,.tt-wo__back,[aria-label*="close" i]');}
function enhance(el){if(!isWorkspace(el)||known.has(el))return;known.add(el);el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');if(!el.hasAttribute('tabindex'))el.tabIndex=-1;const ctl=closeControl(el);requestAnimationFrame(()=>{(ctl||el).focus?.({preventScroll:true});});}
function scan(node=document.body){if(node instanceof HTMLElement)enhance(node);node.querySelectorAll?.('[id^="tt-"]').forEach(enhance);}
document.addEventListener('pointerdown',e=>{const b=e.target.closest?.('button,[data-open],[data-native-support]');if(b)lastTrigger=b;},true);
document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;const dialogs=[...document.querySelectorAll('[id^="tt-"][role="dialog"]')].filter(x=>x.isConnected);const top=dialogs.at(-1);if(!top)return;const ctl=closeControl(top);if(ctl){e.preventDefault();ctl.click();requestAnimationFrame(()=>lastTrigger?.isConnected&&lastTrigger.focus?.());}},true);
new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>n.nodeType===1&&scan(n)))).observe(document.body,{childList:true,subtree:true});
scan();
})();