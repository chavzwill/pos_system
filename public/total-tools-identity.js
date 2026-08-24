(()=>{'use strict';
const DOMAIN_TASKS={
  sale:['sales'],hold:['sales'],return:['sales'],drawer:['sales','finance'],quote:['sales'],
  repair:['service'],rental:['rentals'],dispatch:['dispatch','rentals'],
  'inventory-adjust':['inventory'],count:['inventory'],transfer:['inventory','dispatch'],erp:['inventory','purchasing','finance'],
  pr:['purchasing'],po:['purchasing'],reports:['finance','administration'],compensation:['service','people','administration']
};
function domains(){return [...document.querySelectorAll('.shell-nav [data-domain]')].map(x=>x.dataset.domain).filter(Boolean);}
function moveGuide(){const launcher=document.getElementById('tt-guide-launcher'),nav=document.querySelector('.shell-nav');if(!launcher||!nav)return;launcher.classList.add('shell-guide-entry');launcher.removeAttribute('style');nav.after(launcher);launcher.setAttribute('aria-label','Open Guided Mode');}
function filterGuideTasks(){const modal=document.getElementById('tt-guided-mode');if(!modal)return;const permitted=new Set(domains());modal.querySelectorAll('[data-task]').forEach(btn=>{const allowed=DOMAIN_TASKS[btn.dataset.task];btn.hidden=!!allowed&&!allowed.some(x=>permitted.has(x));});}
function relabelShell(){const brand=document.querySelector('.shell-brand span');if(brand)brand.textContent='Total Tools operating system';const hero=document.querySelector('.shell-hero p');if(hero&&/shell loads immediately/i.test(hero.textContent||''))hero.textContent='Familiar Total Tools workflows, upgraded with faster role-aware tools, modern controls and operational intelligence.';const tools=document.querySelector('.shell-section-head p');if(tools)tools.textContent='Choose the same operational areas staff already know. New capabilities open only when needed.';}
function observe(){const o=new MutationObserver(()=>{moveGuide();filterGuideTasks();relabelShell();});o.observe(document.documentElement,{subtree:true,childList:true});moveGuide();filterGuideTasks();relabelShell();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',observe);else observe();
})();