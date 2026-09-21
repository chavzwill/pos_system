(()=>{'use strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function launcher(){return document.getElementById('tt-guide-launcher');}
function guide(){return document.getElementById('tt-guided-mode');}
function currentTask(){return guide()?.querySelector('.tt-guide__head p')?.textContent?.trim()||'';}
function currentStep(){const t=guide()?.querySelector('.tt-guide__step-count')?.textContent||'';const m=t.match(/step\s+(\d+)/i);return m?Number(m[1]):0;}
function remember(){const task=currentTask(),step=currentStep();if(!task||!step)return;try{sessionStorage.setItem('tt-guide-resume',JSON.stringify({task,step,at:Date.now()}));}catch(_){}}
function stored(){try{const v=JSON.parse(sessionStorage.getItem('tt-guide-resume')||'null');return v&&v.task?v:null;}catch(_){return null;}}
function openGuide(){const btn=launcher();if(btn){btn.click();return true;}return false;}
function ensureStyle(){if(document.getElementById('tt-guide-access-style'))return;const s=document.createElement('style');s.id='tt-guide-access-style';s.textContent=`
.tt-guide-access{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 13px;border:1px solid var(--tt-border-strong,#cfd9d3);border-radius:var(--tt-radius-sm,10px);background:#fff;color:var(--tt-text,#18211d);font-size:12.5px;font-weight:800;box-shadow:none;cursor:pointer;white-space:nowrap}
.tt-guide-access:hover{background:var(--tt-surface-muted,#f1f5f2);border-color:#bfcfc6}
.tt-guide__availability{display:grid;gap:4px;margin:0 0 10px;padding:10px 11px;border:1px solid var(--tt-border,#dbe7e0);border-radius:var(--tt-radius-sm,10px);background:var(--tt-surface-soft,#f5faf7)}
.tt-guide__availability strong{font-size:12px;color:var(--tt-accent,#087b3e)}
.tt-guide__availability span{font-size:11.5px;line-height:1.45;color:var(--tt-muted,#627068)}
.tt-guide__resume{width:100%;margin:0 0 9px;min-height:40px;padding:0 11px;border:1px solid var(--tt-border-strong,#cbd9d1);border-radius:var(--tt-radius-sm,10px);background:#fff;color:var(--tt-text,#174a35);text-align:left;font-size:12px;font-weight:800;cursor:pointer}
.tt-guide__resume:hover{background:var(--tt-surface-muted,#f3f8f5);border-color:#9fbdaa}
@media(max-width:520px){.tt-guide-access{min-height:40px;padding:0 10px;font-size:12px}}
`;document.head.appendChild(s);}
function ensureTopbarAccess(){const top=document.querySelector('.shell-topbar');if(!top||document.getElementById('tt-guide-access'))return;const b=document.createElement('button');b.id='tt-guide-access';b.type='button';b.className='tt-guide-access';b.setAttribute('aria-haspopup','dialog');b.textContent='Guide Me';b.title='Open step-by-step help';b.addEventListener('click',openGuide);const branch=[...top.children].find(x=>x.tagName==='SPAN');if(branch)top.insertBefore(b,branch);else top.appendChild(b);const legacy=launcher();if(legacy){legacy.hidden=true;legacy.setAttribute('aria-hidden','true');legacy.tabIndex=-1;}}
function ensureMobileAccess(){document.getElementById('tt-guide-quick')?.remove();}
function enhanceHome(){const g=guide();if(!g)return;const step=currentStep(),p=g.querySelector('.tt-guide__head p');if(p&&!step)p.textContent='Help is available anytime. Tell me what you need to do and I’ll take you to the right place.';const body=g.querySelector('.tt-guide__body');if(body&&!step&&!body.querySelector('.tt-guide__availability')){const n=document.createElement('div');n.className='tt-guide__availability';n.innerHTML='<strong>Always available</strong><span>Use Guide Me whenever you are unsure, learning a task, returning to an infrequent workflow, or checking the safest next step.</span>';body.prepend(n);}const resume=stored();if(body&&!step&&resume&&!body.querySelector('[data-guide-resume]')){const b=document.createElement('button');b.type='button';b.className='tt-guide__resume';b.dataset.guideResume='1';b.textContent=`Resume where I left off · ${resume.task}`;b.addEventListener('click',async()=>{const chip=[...g.querySelectorAll('[data-task]')].find(x=>x.textContent.trim()===resume.task);if(chip){chip.click();await sleep(80);for(let i=1;i<resume.step;i++){const next=guide()?.querySelector('[data-guide-next]');if(!next||next.disabled)break;next.click();await sleep(55);}}});body.prepend(b);}}
function enhance(){ensureStyle();ensureTopbarAccess();ensureMobileAccess();const legacy=launcher();if(legacy&&document.getElementById('tt-guide-access')){legacy.hidden=true;legacy.setAttribute('aria-hidden','true');legacy.tabIndex=-1;}if(guide()){remember();enhanceHome();}}
let queued=false;const observer=new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;enhance();});});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden']});
document.addEventListener('keydown',e=>{if(((e.key==='?'&&e.shiftKey)||((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='h'))&&!/input|textarea|select/i.test(document.activeElement?.tagName||'')){e.preventDefault();openGuide();}});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',enhance,{once:true});else enhance();
})();