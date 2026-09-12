(()=>{'use strict';
let raf=0;
function guide(){return document.getElementById('tt-guided-mode');}
function task(){return guide()?.querySelector('.tt-guide__head p')?.textContent?.trim()||'';}
function step(){const t=guide()?.querySelector('.tt-guide__step-count')?.textContent||'';const m=t.match(/step\s+(\d+)/i);return m?Number(m[1]):0;}
function pending(){return document.querySelector('#tt-purch-compose-form [data-line="0"] [data-guide-purchase-unit="true"][data-guide-uom-review="pending"]');}
function clearMine(){document.querySelector('[data-uom-guide-me-action="true"]')?.remove();}
function render(){raf=0;const g=guide();const select=pending();if(!g||!select||task()!=='Create, edit, copy, cancel or receive a PO'||step()!==2){clearMine();return;}
 const stepCard=g.querySelector('.tt-guide__step');if(!stepCard)return;g.querySelector('.tt-guide__exact-action')?.remove();clearMine();
 document.querySelectorAll('.tt-guide-exact-highlight,[data-guide-hardened-target="true"]').forEach(el=>{el.classList.remove('tt-guide-exact-highlight');el.removeAttribute('data-guide-hardened-target');el.removeAttribute('data-guide-target-label');});
 select.classList.add('tt-guide-exact-highlight');select.setAttribute('data-guide-hardened-target','true');select.setAttribute('data-guide-target-label','6 · Confirm purchase unit');
 const box=document.createElement('div');box.className='tt-guide__exact-action';box.dataset.uomGuideMeAction='true';box.innerHTML='<div><small>Do this now</small><strong>Confirm the supplier purchase unit. The conversion preview shows the authoritative inventory quantity and base-unit cost before the PO is created.</strong></div><button type="button">6 · Confirm purchase unit</button>';
 box.querySelector('button').addEventListener('click',()=>{select.focus({preventScroll:false});select.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});});stepCard.appendChild(box);
}
function schedule(){if(!raf)raf=requestAnimationFrame(render);}
new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-guide-uom-review','class','hidden']});
['focusin','change','click'].forEach(type=>document.addEventListener(type,()=>setTimeout(schedule,20),true));
setInterval(schedule,350);if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule,{once:true});else schedule();
})();
