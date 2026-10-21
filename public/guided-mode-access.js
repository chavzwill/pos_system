(()=>{'use strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function launcher(){return document.getElementById('tt-guide-launcher');}
function guide(){return document.getElementById('tt-guided-mode');}
function currentTask(){return guide()?.querySelector('.tt-guide__head p')?.textContent?.trim()||'';}
function currentStep(){const t=guide()?.querySelector('.tt-guide__step-count')?.textContent||'';const m=t.match(/step\s+(\d+)/i);return m?Number(m[1]):0;}
function remember(){const task=currentTask(),step=currentStep();if(!task||!step)return;try{sessionStorage.setItem('tt-guide-resume',JSON.stringify({task,step,at:Date.now()}));}catch(_){}}
function stored(){try{const v=JSON.parse(sessionStorage.getItem('tt-guide-resume')||'null');return v&&v.task?v:null;}catch(_){return null;}}
function openGuide(){if(window.TotalToolsGuideMe?.open){window.TotalToolsGuideMe.open();return true;}const btn=document.getElementById('shell-guide');if(btn){btn.click();return true;}return false;}
function ensureStyle(){if(document.getElementById('tt-guide-access-style'))return;/* Screen presentation is owned by ui-workspaces.css. */}
function ensureTopbarAccess(){document.getElementById('tt-guide-access')?.remove();}
function ensureMobileAccess(){document.getElementById('tt-guide-quick')?.remove();}
function enhanceHome(){const g=guide();if(!g)return;const step=currentStep(),p=g.querySelector('.tt-guide__head p');if(p&&!step)p.textContent='Help is available anytime. Tell me what you need to do and I’ll take you to the right place.';const body=g.querySelector('.tt-guide__body');if(body&&!step&&!body.querySelector('.tt-guide__availability')){const n=document.createElement('div');n.className='tt-guide__availability';n.innerHTML='<strong>Always available</strong><span>Use Guide Me whenever you are unsure, learning a task, returning to an infrequent workflow, or checking the safest next step.</span>';body.prepend(n);}const resume=stored();if(body&&!step&&resume&&!body.querySelector('[data-guide-resume]')){const b=document.createElement('button');b.type='button';b.className='tt-guide__resume';b.dataset.guideResume='1';b.textContent=`Resume where I left off · ${resume.task}`;b.addEventListener('click',async()=>{const chip=[...g.querySelectorAll('[data-task]')].find(x=>x.textContent.trim()===resume.task);if(chip){chip.click();await sleep(80);for(let i=1;i<resume.step;i++){const next=guide()?.querySelector('[data-guide-next]');if(!next||next.disabled)break;next.click();await sleep(55);}}});body.prepend(b);}}
function enhance(){ensureStyle();ensureTopbarAccess();ensureMobileAccess();if(guide()){remember();enhanceHome();}}
let queued=false;const observer=new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;enhance();});});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden']});
document.addEventListener('keydown',e=>{if(((e.key==='?'&&e.shiftKey)||((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='h'))&&!/input|textarea|select/i.test(document.activeElement?.tagName||'')){e.preventDefault();openGuide();}});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',enhance,{once:true});else enhance();
})();